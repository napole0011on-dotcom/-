import type { Actor } from '@cms/core';
import { schema, sql, type Db } from '@cms/db';
import { resolveAgent, updateConstructorAgent } from './agent-registry.js';
import {
  BLOCK_KINDS,
  Composition,
  compileComposition,
  defaultComposition,
  type CompiledAgent,
} from './blocks.js';
import type { AgentControls } from './controls.js';
import { savePromptVersion } from './prompt-store.js';
import { addLink, loadWorkspace } from './workspace.js';

const { agentCompositions, auditLog } = schema;

export interface CompositionView {
  agentId: string;
  /** null: nothing saved yet (the default composition is shown). */
  version: number | null;
  composition: Composition;
  builtVersion: number | null;
  versions: { version: number; note: string; createdAt: Date; createdBy: string; built: boolean }[];
}

export interface CompositionResult {
  ok: boolean;
  message: string;
  version?: number;
  problems?: string[];
  warnings?: string[];
}

const audit = (db: Db, brandId: string, actor: Actor, action: string, details: object) =>
  db.insert(auditLog).values({
    brandId,
    actorKind: actor.kind,
    actorId: actor.id,
    action,
    details: details,
  });

async function editableAgent(db: Db, brandId: string, agentId: string) {
  const ref = await resolveAgent(db, brandId, agentId);
  if (!ref) return { ref: null, problem: 'Нет такого агента' };
  if (ref.kind !== 'constructor')
    return {
      ref,
      problem: 'Из блоков собираются агенты конструктора; этот агент описан в коде',
    };
  return { ref, problem: null };
}

async function versionsOf(db: Db, brandId: string, agentId: string) {
  return db
    .select()
    .from(agentCompositions)
    .where(
      sql`${agentCompositions.brandId} = ${brandId} and ${agentCompositions.agentId} = ${agentId}`,
    )
    .orderBy(sql`${agentCompositions.version} desc`);
}

export async function getComposition(
  db: Db,
  brandId: string,
  agentId: string,
): Promise<CompositionView | null> {
  const ref = await resolveAgent(db, brandId, agentId);
  if (!ref) return null;
  const rows = await versionsOf(db, brandId, agentId);
  const latest = rows[0];
  const built = rows.find((r) => r.builtAt);
  return {
    agentId,
    version: latest?.version ?? null,
    composition: latest
      ? Composition.parse({ blocks: latest.blocks, links: latest.links })
      : defaultComposition(ref.role),
    builtVersion: built?.version ?? null,
    versions: rows.map((r) => ({
      version: r.version,
      note: r.note,
      createdAt: r.createdAt,
      createdBy: r.createdBy,
      built: !!r.builtAt,
    })),
  };
}

/** Every save is a new version (audited); the previous ones stay for rollback. */
export async function saveComposition(
  db: Db,
  brandId: string,
  agentId: string,
  raw: unknown,
  actor: Actor,
  note = 'сохранено',
): Promise<CompositionResult> {
  const { problem } = await editableAgent(db, brandId, agentId);
  if (problem) return { ok: false, message: problem };
  const parsed = Composition.safeParse(raw);
  if (!parsed.success) return { ok: false, message: 'Неверный состав блоков' };
  const c = parsed.data;
  const ids = new Set(c.blocks.map((b) => b.id));
  if (ids.size !== c.blocks.length) return { ok: false, message: 'У блоков повторяются id' };
  if (c.links.some((l) => !ids.has(l.from) || !ids.has(l.to)))
    return { ok: false, message: 'Связь ведёт к блоку, которого нет' };
  const version = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`composition:${brandId}:${agentId}`}))`,
    );
    const [last] = await tx
      .select({ v: sql<number>`coalesce(max(${agentCompositions.version}), 0)::int` })
      .from(agentCompositions)
      .where(
        sql`${agentCompositions.brandId} = ${brandId} and ${agentCompositions.agentId} = ${agentId}`,
      );
    const v = (last?.v ?? 0) + 1;
    await tx.insert(agentCompositions).values({
      brandId,
      agentId,
      version: v,
      blocks: c.blocks,
      links: c.links,
      note,
      createdBy: actor.id,
    });
    await tx.insert(auditLog).values({
      brandId,
      actorKind: actor.kind,
      actorId: actor.id,
      action: 'composition_saved',
      details: { agent: agentId, version: v, blocks: c.blocks.length, note },
    });
    return v;
  });
  return { ok: true, version, message: `Блоки сохранены (версия ${version})` };
}

/** Rollback = the old version copied as the newest (history is never rewritten). */
export async function rollbackComposition(
  db: Db,
  brandId: string,
  agentId: string,
  version: number,
  actor: Actor,
): Promise<CompositionResult> {
  const rows = await versionsOf(db, brandId, agentId);
  const old = rows.find((r) => r.version === version);
  if (!old) return { ok: false, message: `Нет версии ${version}` };
  if (rows[0]?.version === version) return { ok: false, message: 'Это уже текущая версия' };
  const r = await saveComposition(
    db,
    brandId,
    agentId,
    { blocks: old.blocks, links: old.links },
    actor,
    `откат к версии ${version}`,
  );
  if (r.ok)
    await audit(db, brandId, actor, 'composition_rollback', { agent: agentId, to: version });
  return r.ok ? { ...r, message: `Вернул блоки версии ${version} (новая версия ${r.version})` } : r;
}

/** Checks the latest saved composition without changing anything. */
export async function checkComposition(
  db: Db,
  brandId: string,
  agentId: string,
  allowedModels: readonly string[],
): Promise<{ ok: true; agent: CompiledAgent } | { ok: false; problems: string[] }> {
  const view = await getComposition(db, brandId, agentId);
  if (!view) return { ok: false, problems: ['Нет такого агента'] };
  const nodes = (await loadWorkspace(db, brandId)).nodes.map((n) => n.id);
  return compileComposition(view.composition, { allowedModels, nodes });
}

/**
 * «Собрать в агента»: the latest version becomes the agent's draft — fields, criteria, prompt,
 * model and board links. Changing an active agent's fields makes it a draft again, so it is
 * switched on only after a mock test of exactly this build (the constructor's rule).
 */
export async function buildComposition(
  db: Db,
  brandId: string,
  agentId: string,
  controls: AgentControls,
  actor: Actor,
): Promise<CompositionResult> {
  const { ref, problem } = await editableAgent(db, brandId, agentId);
  if (problem || !ref) return { ok: false, message: problem ?? 'Нет такого агента' };
  const rows = await versionsOf(db, brandId, agentId);
  const latest = rows[0];
  if (!latest) return { ok: false, message: 'Сначала сохраните блоки' };
  const compiled = await checkComposition(db, brandId, agentId, controls.allowedModels());
  if (!compiled.ok)
    return {
      ok: false,
      message: `Собрать нельзя: ${compiled.problems.length} ${compiled.problems.length === 1 ? 'проблема' : 'проблем(ы)'}`,
      problems: compiled.problems,
    };
  const a = compiled.agent;
  const warnings: string[] = [];
  const upd = await updateConstructorAgent(
    db,
    brandId,
    agentId,
    { fields: a.fields, criteria: a.criteria, modelRole: a.modelRole },
    actor,
  );
  if (!upd.ok) return { ok: false, message: upd.message };
  const pr = await savePromptVersion(db, brandId, agentId, a.prompt, actor);
  if (!pr.ok && pr.message !== 'Текст не изменился') warnings.push(`Промпт: ${pr.message}`);
  const model = a.model
    ? await controls.setModel(brandId, agentId, a.model, actor)
    : await controls.resetModel(brandId, agentId, actor);
  if (!model.ok && model.message !== 'Модель не изменилась')
    warnings.push(`Модель: ${model.message}`);
  const ws = await loadWorkspace(db, brandId);
  for (const to of a.links) {
    if (ws.links.some((l) => l.from === agentId && l.to === to)) continue;
    const r = await addLink(db, brandId, agentId, to, actor);
    if (!r.ok) {
      const name = ws.nodes.find((n) => n.id === to)?.name ?? to;
      warnings.push(`Связь с «${name}»: ${r.message}`);
    }
  }
  await db
    .update(agentCompositions)
    .set({ builtAt: sql`now()` })
    .where(sql`${agentCompositions.id} = ${latest.id}`);
  await audit(db, brandId, actor, 'composition_built', {
    agent: agentId,
    version: latest.version,
    fields: a.fields.length,
    criteria: a.criteria.length,
    links: a.links,
    warnings: warnings.length,
  });
  const after = await resolveAgent(db, brandId, agentId);
  return {
    ok: true,
    version: latest.version,
    warnings,
    message:
      after?.status === 'active'
        ? `Собрано из блоков версии ${latest.version}`
        : `Собрано из блоков версии ${latest.version}: черновик обновлён — проверьте тестом и включите`,
  };
}

export const BLOCK_LABELS = Object.fromEntries(
  Object.values(BLOCK_KINDS).map((k) => [k.type, k.label]),
);

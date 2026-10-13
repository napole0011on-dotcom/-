import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Actor } from '@cms/core';
import { schema, sql, type Db } from '@cms/db';
import {
  AgentDraftInput,
  activateConstructorAgent,
  createConstructorAgent,
  needsFields,
  resolveAgent,
  updateConstructorAgent,
} from './agent-registry.js';
import { runAgentTest, type AgentTestDeps } from './agent-test.js';
import { capabilityById, isToolCapability } from './capabilities.js';
import { OutputField } from './fields.js';
import { BRIEF, OWNER, TEAM_ROLES, nearestFree } from './graph.js';
import { activePrompt } from './prompt-store.js';
import { addLink, loadWorkspace, saveLayout } from './workspace.js';

const { agentTemplates, auditLog } = schema;

/**
 * Agent library: templates to copy onto the board. A template never runs and never appears on
 * the board by itself: «Добавить» makes a new agent (a new id) that lives on independently.
 * Starting templates are files in config/library/*.yaml, imported by `pnpm library:sync` and at
 * the first start; the owner edits, deletes and adds templates in the panel. Every save of a
 * slug is a new version; sync never overwrites the owner's edits and never brings back a
 * template the owner deleted. Export/import is JSON by a strict schema: no keys or tokens.
 */
export const CATEGORIES = [
  'Команда',
  'Контент',
  'SEO и охват',
  'Видео',
  'Продажи',
  'Аналитика',
  'Инструменты',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const LIBRARY_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'config', 'library');

const SLUG = /^[a-z][a-z0-9_]{1,39}$/;

export const TemplateBody = z
  .object({
    slug: z.string().regex(SLUG, 'slug: латиница, цифры и _, с буквы'),
    category: z.enum(CATEGORIES),
    name: z.string().trim().min(2).max(40),
    role: z.string().trim().min(3).max(120),
    description: z.string().trim().max(600).default(''),
    teamRole: z.enum(TEAM_ROLES).default('worker'),
    /** Code behaviour (copywriting, image_generate, stt_voice, ...); null: an LLM agent by fields. */
    capability: z.string().max(40).nullable().default(null),
    modelRole: z.enum(['worker', 'ceo', 'critic']).nullable().default(null),
    /** Null only for tool capabilities (no LLM). */
    prompt: z.string().trim().max(20_000).nullable().default(null),
    fields: z.array(OutputField).max(20).default([]),
    criteria: z.array(z.string().trim().min(3).max(300)).max(15).default([]),
    /** Place in «Базовая команда» (1, 2, ...); null: not in it. */
    basicTeam: z.number().int().min(1).max(20).nullable().default(null),
    /** Files exported before stage 7 have it; ignored. */
    requiresKey: z.string().max(120).nullable().optional(),
  })
  .strict()
  .superRefine((t, ctx) => {
    if (t.capability && !capabilityById(t.capability))
      ctx.addIssue({ code: 'custom', path: ['capability'], message: 'нет такой возможности' });
    const tool = isToolCapability(t.capability);
    if (!tool && (!t.prompt || t.prompt.length < 20))
      ctx.addIssue({
        code: 'custom',
        path: ['prompt'],
        message: 'нужна инструкция (от 20 символов)',
      });
    if (needsFields({ teamRole: t.teamRole, capability: t.capability }) && t.fields.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'нужно хотя бы одно поле результата',
      });
  });
export type TemplateBody = z.infer<typeof TemplateBody>;

/** Only the template's own fields (no id, version, source of this installation). */
function bodyOf(t: object): Record<string, unknown> {
  const all = t as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(TemplateBody.shape)
      .filter((k) => k in all)
      .map((k) => [k, all[k]]),
  );
}

export interface TemplateView extends TemplateBody {
  /** The slug (templates are addressed by it; every save is a new version). */
  id: string;
  version: number;
  /** file: from config/library (starting template); panel/import/agent: the owner's. */
  source: string;
  /** A starting template from config/library that the owner has not changed. */
  system: boolean;
  createdAt: string | null;
}

// ------------------------------------------------------------------ files

const stripFrontMatter = (raw: string) =>
  raw
    .replace(/\r\n/g, '\n')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .trim();

/** Reads config/library/*.yaml (snake_case keys; `prompt_file` relative to the folder). */
export function loadLibraryFiles(
  dir: string = LIBRARY_DIR,
): (TemplateBody & { version: number })[] {
  const out: (TemplateBody & { version: number })[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()) {
    const raw = parseYaml(readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
    const prompt =
      typeof raw.prompt_file === 'string'
        ? stripFrontMatter(readFileSync(path.join(dir, raw.prompt_file), 'utf8'))
        : ((raw.prompt as string | undefined) ?? null);
    const parsed = TemplateBody.safeParse({
      slug: raw.slug,
      category: raw.category,
      name: raw.name,
      role: raw.role,
      description: raw.description ?? '',
      teamRole: raw.team_role ?? 'worker',
      capability: raw.capability ?? null,
      modelRole: raw.model_role ?? null,
      prompt,
      fields: raw.fields ?? [],
      criteria: raw.criteria ?? [],
      basicTeam: raw.basic_team ?? null,
    });
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new Error(`config/library/${file}: ${i?.path.join('.')} — ${i?.message}`);
    }
    if (parsed.data.slug !== file.replace(/\.yaml$/, ''))
      throw new Error(`config/library/${file}: slug must match the file name`);
    out.push({ ...parsed.data, version: Number(raw.version ?? 1) });
  }
  return out;
}

type Row = typeof agentTemplates.$inferSelect;

async function rowsOf(db: Db, brandId: string, slug?: string): Promise<Row[]> {
  return db
    .select()
    .from(agentTemplates)
    .where(
      slug
        ? sql`${agentTemplates.brandId} = ${brandId} and ${agentTemplates.slug} = ${slug}`
        : sql`${agentTemplates.brandId} = ${brandId}`,
    )
    .orderBy(sql`${agentTemplates.slug}, ${agentTemplates.version} desc`);
}

/** jsonb does not keep key order: compare with sorted keys (and without undefined values). */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
const sameBody = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * `pnpm library:sync` and the first start: new files become templates; a changed file becomes
 * a new version unless the owner edited the template (then the owner's version stays) or
 * deleted it (then it does not come back).
 */
export async function syncLibrary(
  db: Db,
  brandId: string,
  dir: string = LIBRARY_DIR,
): Promise<{ added: string[]; updated: string[]; skipped: string[] }> {
  const files = loadLibraryFiles(dir);
  const res = { added: [] as string[], updated: [] as string[], skipped: [] as string[] };
  for (const f of files) {
    const body = bodyOf(f);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tpl:${brandId}:${f.slug}`}))`);
      const rows = await tx
        .select()
        .from(agentTemplates)
        .where(sql`${agentTemplates.brandId} = ${brandId} and ${agentTemplates.slug} = ${f.slug}`)
        .orderBy(sql`${agentTemplates.version} desc`);
      const latest = rows[0];
      if (rows.some((r) => r.deletedAt) || (latest && latest.source !== 'file')) {
        res.skipped.push(f.slug);
        return;
      }
      if (latest && sameBody(latest.body, body)) return;
      await tx.insert(agentTemplates).values({
        brandId,
        slug: f.slug,
        version: (latest?.version ?? 0) + 1,
        body,
        source: 'file',
        createdBy: 'system:library',
      });
      (latest ? res.updated : res.added).push(f.slug);
    });
  }
  if (res.added.length || res.updated.length)
    await db.insert(auditLog).values({
      brandId,
      actorKind: 'system',
      actorId: 'system:library',
      action: 'library_synced',
      details: { added: res.added, updated: res.updated },
    });
  return res;
}

// ------------------------------------------------------------------ templates

const view = (r: Row): TemplateView => {
  const body = TemplateBody.parse(r.body);
  return {
    ...body,
    id: r.slug,
    version: r.version,
    source: r.source,
    system: r.source === 'file',
    createdAt: new Date(r.createdAt).toISOString(),
  };
};

/** The latest version of every template that is not deleted. */
export async function listTemplates(db: Db, brandId: string): Promise<TemplateView[]> {
  const rows = await rowsOf(db, brandId);
  const out: TemplateView[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.slug)) continue;
    seen.add(r.slug);
    if (rows.some((x) => x.slug === r.slug && x.deletedAt)) continue;
    const parsed = TemplateBody.safeParse(r.body);
    if (parsed.success) out.push(view(r));
  }
  const order = (t: TemplateView) => CATEGORIES.indexOf(t.category);
  return out.sort((a, b) => order(a) - order(b) || (a.basicTeam ?? 99) - (b.basicTeam ?? 99));
}

export async function getTemplate(
  db: Db,
  brandId: string,
  id: string,
): Promise<TemplateView | null> {
  return (await listTemplates(db, brandId)).find((t) => t.id === id) ?? null;
}

async function saveTemplateVersion(
  db: Db,
  brandId: string,
  body: TemplateBody,
  actor: Actor,
  source: 'panel' | 'import' | 'agent',
): Promise<{ ok: boolean; message: string; id?: string; version?: number }> {
  const version = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`tpl:${brandId}:${body.slug}`}))`);
    const [last] = await tx
      .select({ v: sql<number>`coalesce(max(${agentTemplates.version}), 0)::int` })
      .from(agentTemplates)
      .where(sql`${agentTemplates.brandId} = ${brandId} and ${agentTemplates.slug} = ${body.slug}`);
    const v = (last?.v ?? 0) + 1;
    // Saving a deleted slug again brings it back (the owner's own action).
    await tx
      .update(agentTemplates)
      .set({ deletedAt: null })
      .where(sql`${agentTemplates.brandId} = ${brandId} and ${agentTemplates.slug} = ${body.slug}`);
    await tx.insert(agentTemplates).values({
      brandId,
      slug: body.slug,
      version: v,
      body,
      source,
      createdBy: actor.id,
    });
    await tx.insert(auditLog).values({
      brandId,
      actorKind: actor.kind,
      actorId: actor.id,
      action: 'template_saved',
      details: { slug: body.slug, version: v, how: source },
    });
    return v;
  });
  return {
    ok: true,
    id: body.slug,
    version,
    message: `Шаблон «${body.name}» сохранён в библиотеку (версия ${version})`,
  };
}

/** «Изменить» in the library: a new version of the template (agents made from it do not change). */
export async function updateTemplate(
  db: Db,
  brandId: string,
  id: string,
  patch: Partial<
    Pick<
      TemplateBody,
      'name' | 'role' | 'description' | 'category' | 'prompt' | 'criteria' | 'teamRole'
    >
  >,
  actor: Actor,
) {
  const t = await getTemplate(db, brandId, id);
  if (!t) return { ok: false, message: 'Шаблон не найден' };
  const body = bodyOf(t);
  const next = TemplateBody.safeParse({ ...body, ...patch });
  if (!next.success) {
    const i = next.error.issues[0];
    return { ok: false, message: `${i?.path.join('.') || 'шаблон'} — ${i?.message ?? 'ошибка'}` };
  }
  return saveTemplateVersion(db, brandId, next.data, actor, 'panel');
}

/** Deletes a template (all versions). Agents already made from it stay as they are. */
export async function deleteTemplate(db: Db, brandId: string, id: string, actor: Actor) {
  const t = await getTemplate(db, brandId, id);
  if (!t) return { ok: false, message: 'Шаблон не найден' };
  await db
    .update(agentTemplates)
    .set({ deletedAt: sql`now()` })
    .where(sql`${agentTemplates.brandId} = ${brandId} and ${agentTemplates.slug} = ${id}`);
  await db.insert(auditLog).values({
    brandId,
    actorKind: actor.kind,
    actorId: actor.id,
    action: 'template_deleted',
    details: { slug: id, name: t.name, version: t.version },
  });
  return { ok: true, message: `Шаблон «${t.name}» удалён. Созданные из него агенты не изменились` };
}

/** «В библиотеку»: an agent (fields, criteria, role, capability, active prompt) as a template. */
export async function saveAgentAsTemplate(
  db: Db,
  brandId: string,
  agentId: string,
  category: Category,
  actor: Actor,
) {
  const ref = await resolveAgent(db, brandId, agentId);
  if (!ref) return { ok: false, message: 'Нет такого агента' };
  const prompt = ref.promptAgent
    ? await activePrompt(db, brandId, agentId).catch(() => null)
    : null;
  const spec = ref.spec as { fields?: unknown; criteria?: unknown };
  const body = TemplateBody.safeParse({
    slug: agentId,
    category,
    name: ref.name,
    role: ref.role,
    description: ref.description,
    teamRole: ref.teamRole,
    capability: ref.capability,
    modelRole: ref.modelRole === 'classifier' ? 'worker' : ref.modelRole,
    prompt: prompt?.text ?? null,
    fields: spec.fields ?? [],
    criteria: spec.criteria ?? [],
  });
  if (!body.success)
    return {
      ok: false,
      message: `Агента пока нельзя сохранить: ${body.error.issues[0]?.path.join('.')} — ${body.error.issues[0]?.message}`,
    };
  return saveTemplateVersion(db, brandId, body.data, actor, 'agent');
}

/** Export: the template only — no keys, no ids of this installation. */
export function exportTemplate(t: TemplateView) {
  return {
    format: 'cms-agent-template',
    formatVersion: 2,
    version: t.version,
    template: TemplateBody.parse(bodyOf(t)),
  };
}

const ImportFile = z
  .object({
    format: z.literal('cms-agent-template'),
    formatVersion: z.union([z.literal(1), z.literal(2)]),
    version: z.number().int().min(1).optional(),
    template: TemplateBody,
  })
  .strict();

/** Import: a strict schema; anything extra (keys, tokens, ids) makes the file invalid. */
export async function importTemplate(db: Db, brandId: string, raw: unknown, actor: Actor) {
  const parsed = ImportFile.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return {
      ok: false,
      message: `Файл не подходит: ${i?.path.join('.') || 'формат'} — ${i?.message ?? 'ошибка'}`,
    };
  }
  return saveTemplateVersion(db, brandId, parsed.data.template, actor, 'import');
}

// ------------------------------------------------------------------ agents from templates

/**
 * «Добавить» / drag onto the board: a draft copy of the template (a new id, preferring the
 * slug), with its role, capability, fields, criteria and prompt. It is switched on after a test.
 */
export async function addFromTemplate(
  db: Db,
  brandId: string,
  templateId: string,
  actor: Actor,
  position?: { x: number; y: number },
): Promise<{ ok: boolean; message: string; id?: string }> {
  const t = await getTemplate(db, brandId, templateId);
  if (!t) return { ok: false, message: 'Шаблон не найден' };
  const draft = AgentDraftInput.parse({
    name: t.name,
    role: t.role,
    description: t.description,
    teamRole: t.teamRole,
    capability: t.capability,
    ...(t.modelRole ? { modelRole: t.modelRole } : {}),
  });
  if (!draft.ok) return draft;
  const created = await createConstructorAgent(
    db,
    brandId,
    { ...draft.value, id: t.slug, prompt: t.prompt },
    actor,
  );
  if (!created.ok || !created.id) return created;
  if (t.fields.length || t.criteria.length) {
    const upd = await updateConstructorAgent(
      db,
      brandId,
      created.id,
      { fields: t.fields, criteria: t.criteria },
      actor,
    );
    if (!upd.ok) return upd;
  }
  if (position) {
    // Never on top of another card: the closest free spot to the drop point.
    const ws = await loadWorkspace(db, brandId);
    const taken = Object.entries(ws.layout)
      .filter(([id]) => id !== created.id)
      .map(([, p]) => p);
    await saveLayout(db, brandId, { [created.id]: nearestFree(taken, position) }, actor);
  }
  await db.insert(auditLog).values({
    brandId,
    actorKind: actor.kind,
    actorId: actor.id,
    action: 'agent_from_template',
    details: { agent: created.id, template: t.id, version: t.version },
  });
  return {
    ok: true,
    id: created.id,
    message: `«${t.name}» добавлен как черновик: проверьте тестом и включите`,
  };
}

/**
 * «Базовая команда»: the templates marked basic_team (Планировщик, Копирайтер, Проверяющий)
 * become agents, linked Бриф → планировщик → исполнители → проверяющий → Вы, tested on the mock
 * model ($0) and switched on. Ordinary owner's actions: each one is in audit_log, and any of
 * these agents can be changed or deleted later.
 */
export async function createBasicTeam(
  deps: AgentTestDeps & { release: () => Promise<void> },
  brandId: string,
  actor: Actor,
): Promise<{ ok: boolean; message: string; agents: string[] }> {
  const { db } = deps;
  const templates = (await listTemplates(db, brandId))
    .filter((t) => t.basicTeam !== null)
    .sort((a, b) => a.basicTeam! - b.basicTeam!);
  if (templates.length === 0)
    return {
      ok: false,
      message: 'В библиотеке нет шаблонов базовой команды: выполните pnpm library:sync',
      agents: [],
    };
  const made: { id: string; teamRole: string }[] = [];
  const problems: string[] = [];
  for (const t of templates) {
    const r = await addFromTemplate(db, brandId, t.id, actor);
    if (!r.ok || !r.id) problems.push(`${t.name}: ${r.message}`);
    else made.push({ id: r.id, teamRole: t.teamRole });
  }
  const planners = made.filter((m) => m.teamRole === 'planner');
  const reviewers = made.filter((m) => m.teamRole === 'reviewer');
  const workers = made.filter((m) => m.teamRole === 'worker' || m.teamRole === 'acceptor');
  const link = async (from: string, to: string) => {
    const r = await addLink(db, brandId, from, to, actor);
    if (!r.ok) problems.push(r.message);
  };
  for (const p of planners.slice(0, 1)) {
    await link(BRIEF, p.id);
    for (const w of workers) await link(p.id, w.id);
  }
  for (const w of workers)
    if (reviewers[0]) await link(w.id, reviewers[0].id);
    else await link(w.id, OWNER);
  if (reviewers[0]) await link(reviewers[0].id, OWNER);
  for (const m of made) {
    const test = await runAgentTest(deps, brandId, m.id, {}, actor);
    if (!test.ok) {
      problems.push(test.message);
      continue;
    }
    const on = await activateConstructorAgent(db, brandId, m.id, actor, deps.release);
    if (!on.ok) problems.push(on.message);
  }
  return {
    ok: made.length > 0 && problems.length === 0,
    agents: made.map((m) => m.id),
    message:
      problems.length === 0
        ? `Команда собрана: ${made.length} агента проверены тестом и включены. Можно ставить задачу`
        : `Команда собрана с замечаниями: ${problems.join('; ')}`,
  };
}

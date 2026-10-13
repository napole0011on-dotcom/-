import type { Actor } from '@cms/core';
import { schema, sql, type Db, type DbOrTx } from '@cms/db';
import {
  normalizePromptText,
  promptHash,
  promptLabel,
  validatePromptText,
  type LoadedPrompt,
  type PromptMap,
} from './prompts.js';

const { promptVersions, agentSettings, auditLog } = schema;

export type PromptVersion = typeof promptVersions.$inferSelect;

export interface ActivePrompt extends LoadedPrompt {
  id: string;
}

export const labelOf = (v: Pick<PromptVersion, 'agent' | 'version' | 'hash'>) =>
  promptLabel(v.agent, v.version, v.hash);

const toLoaded = (v: PromptVersion): ActivePrompt => ({
  id: v.id,
  agent: v.agent,
  text: v.text,
  version: labelOf(v),
});

const lock = (tx: DbOrTx, brandId: string, agent: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`prompts:${brandId}:${agent}`}))`);

async function ensureSettingsRow(tx: DbOrTx, brandId: string, agent: string) {
  await tx.insert(agentSettings).values({ brandId, agent }).onConflictDoNothing();
}

/** Inserts a version unless the same text already exists (then that one is returned). */
async function insertVersion(
  tx: DbOrTx,
  v: {
    brandId: string;
    agent: string;
    text: string;
    source: 'file' | 'panel';
    fileVersion: number | null;
    createdBy: string;
  },
): Promise<{ row: PromptVersion; created: boolean }> {
  const hash = promptHash(v.text);
  const [existing] = await tx
    .select()
    .from(promptVersions)
    .where(
      sql`${promptVersions.brandId} = ${v.brandId} and ${promptVersions.agent} = ${v.agent} and ${promptVersions.hash} = ${hash}`,
    );
  if (existing) return { row: existing, created: false };
  const [max] = await tx
    .select({ n: sql<number>`coalesce(max(${promptVersions.version}), 0)::int` })
    .from(promptVersions)
    .where(sql`${promptVersions.brandId} = ${v.brandId} and ${promptVersions.agent} = ${v.agent}`);
  const [row] = await tx
    .insert(promptVersions)
    .values({ ...v, hash, version: (max?.n ?? 0) + 1 })
    .returning();
  return { row: row!, created: true };
}

async function activeVersion(db: DbOrTx, brandId: string, agent: string) {
  const [row] = await db
    .select({ v: promptVersions })
    .from(agentSettings)
    .innerJoin(promptVersions, sql`${promptVersions.id} = ${agentSettings.activePromptId}`)
    .where(sql`${agentSettings.brandId} = ${brandId} and ${agentSettings.agent} = ${agent}`);
  return row?.v ?? null;
}

/** The prompt an agent runs with: its active DB version. */
export async function activePrompt(db: Db, brandId: string, agent: string): Promise<ActivePrompt> {
  const v = await activeVersion(db, brandId, agent);
  if (!v) throw new Error(`No active prompt for ${agent}`);
  return toLoaded(v);
}

/** Active prompts of these agents (those that have one). */
export async function activePrompts(
  db: Db,
  brandId: string,
  agents: readonly string[] = [],
): Promise<PromptMap> {
  const out: PromptMap = {};
  for (const a of agents) {
    if (out[a]) continue;
    const v = await activeVersion(db, brandId, a);
    if (v) out[a] = toLoaded(v);
  }
  return out;
}

/** Whether an agent already has an active prompt version (registry agents start without one). */
export async function hasActivePrompt(db: DbOrTx, brandId: string, agent: string) {
  return (await activeVersion(db, brandId, agent)) !== null;
}

export interface PromptVersionView {
  id: string;
  version: number;
  label: string;
  text: string;
  source: 'file' | 'panel';
  fileVersion: number | null;
  createdBy: string;
  createdAt: Date;
  active: boolean;
}

/** All versions, newest first, plus the file version that is newer than the active one (if any). */
export async function promptHistory(db: Db, brandId: string, agent: string) {
  const active = await activeVersion(db, brandId, agent);
  const rows = await db
    .select()
    .from(promptVersions)
    .where(sql`${promptVersions.brandId} = ${brandId} and ${promptVersions.agent} = ${agent}`)
    .orderBy(sql`${promptVersions.version} desc`);
  const versions: PromptVersionView[] = rows.map((r) => ({
    id: r.id,
    version: r.version,
    label: labelOf(r),
    text: r.text,
    source: r.source,
    fileVersion: r.fileVersion,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    active: r.id === active?.id,
  }));
  // A new registry agent has no active version until the owner saves its first prompt.
  const activeRow = versions.find((v) => v.active) ?? null;
  const newestFile = versions.find((v) => v.source === 'file');
  const pendingFile =
    newestFile && !newestFile.active && newestFile.version > (activeRow?.version ?? 0)
      ? newestFile
      : null;
  return { active: activeRow, versions, pendingFile };
}

export interface PromptChange {
  ok: boolean;
  message: string;
  label?: string;
}

async function setActive(
  tx: DbOrTx,
  brandId: string,
  agent: string,
  row: PromptVersion,
  actor: Actor,
  action: string,
) {
  const before = await activeVersion(tx, brandId, agent);
  await ensureSettingsRow(tx, brandId, agent);
  await tx
    .update(agentSettings)
    .set({ activePromptId: row.id, updatedBy: actor.id, updatedAt: sql`now()` })
    .where(sql`${agentSettings.brandId} = ${brandId} and ${agentSettings.agent} = ${agent}`);
  await tx.insert(auditLog).values({
    brandId,
    actorKind: actor.kind,
    actorId: actor.id,
    action,
    details: { agent, from: before ? labelOf(before) : null, to: labelOf(row) },
  });
}

/** Saves the owner's edit as a new version and makes it active (same text = that old version). */
export async function savePromptVersion(
  db: Db,
  brandId: string,
  agent: string,
  rawText: string,
  actor: Actor,
): Promise<PromptChange> {
  const problem = validatePromptText(rawText);
  if (problem) return { ok: false, message: problem };
  const text = normalizePromptText(rawText);
  return db.transaction(async (tx) => {
    await lock(tx, brandId, agent);
    const { row, created } = await insertVersion(tx, {
      brandId,
      agent,
      text,
      source: 'panel',
      fileVersion: null,
      createdBy: actor.id,
    });
    const before = await activeVersion(tx, brandId, agent);
    if (before?.id === row.id)
      return { ok: false, message: 'Текст не изменился', label: labelOf(row) };
    await setActive(tx, brandId, agent, row, actor, 'prompt_saved');
    const label = labelOf(row);
    return {
      ok: true,
      label,
      message: created
        ? `Сохранено как ${label}, новые запуски пойдут с ним`
        : `Такой текст уже был (${label}) — включил эту версию`,
    };
  });
}

/** One-click rollback / switch to any stored version (incl. a new version from the file). */
export async function activatePromptVersion(
  db: Db,
  brandId: string,
  agent: string,
  versionId: string,
  actor: Actor,
): Promise<PromptChange> {
  return db.transaction(async (tx) => {
    await lock(tx, brandId, agent);
    const [row] = await tx
      .select()
      .from(promptVersions)
      .where(
        sql`${promptVersions.id} = ${versionId} and ${promptVersions.brandId} = ${brandId} and ${promptVersions.agent} = ${agent}`,
      );
    if (!row) return { ok: false, message: 'Версия не найдена' };
    const before = await activeVersion(tx, brandId, agent);
    if (before?.id === row.id) return { ok: false, message: 'Эта версия уже активна' };
    await setActive(tx, brandId, agent, row, actor, 'prompt_activated');
    return { ok: true, label: labelOf(row), message: `Активна версия ${labelOf(row)}` };
  });
}

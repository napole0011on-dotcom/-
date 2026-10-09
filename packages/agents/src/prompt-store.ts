import type { Actor } from '@cms/core';
import { schema, sql, type Db, type DbOrTx } from '@cms/db';
import {
  AGENT_NAMES,
  PROMPTS_DIR,
  loadPrompt,
  normalizePromptText,
  promptHash,
  promptLabel,
  validatePromptText,
  type AgentName,
  type LoadedPrompt,
} from './prompts.js';

const { promptVersions, agentSettings, auditLog } = schema;

export type PromptVersion = typeof promptVersions.$inferSelect;

export interface ActivePrompt extends LoadedPrompt {
  id: string;
}

const FILE_ACTOR = 'system:prompt-files';

export const labelOf = (v: Pick<PromptVersion, 'agent' | 'version' | 'hash'>) =>
  promptLabel(v.agent, v.version, v.hash);

const toLoaded = (v: PromptVersion): ActivePrompt => ({
  id: v.id,
  agent: v.agent as AgentName,
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

/**
 * Called at start (bot and API) and lazily before the first run. For each agent:
 *  - no versions yet -> the file becomes version 1 and is activated;
 *  - the file text is new -> it is added as a version from the file but NOT activated
 *    (the panel shows "есть новая версия из файла");
 *  - otherwise nothing changes.
 */
export async function syncPromptFiles(
  db: Db,
  brandId: string,
  dir: string = PROMPTS_DIR,
): Promise<{ agent: AgentName; label: string; activated: boolean }[]> {
  const out: { agent: AgentName; label: string; activated: boolean }[] = [];
  for (const agent of AGENT_NAMES) {
    const file = loadPrompt(agent, dir);
    const fileVersion = Number(/@(\d+)#/.exec(file.version)?.[1] ?? 0) || null;
    const r = await db.transaction(async (tx) => {
      await lock(tx, brandId, agent);
      await ensureSettingsRow(tx, brandId, agent);
      const { row, created } = await insertVersion(tx, {
        brandId,
        agent,
        text: file.text,
        source: 'file',
        fileVersion,
        createdBy: FILE_ACTOR,
      });
      const active = await activeVersion(tx, brandId, agent);
      if (!active) {
        await tx
          .update(agentSettings)
          .set({ activePromptId: row.id, updatedBy: FILE_ACTOR, updatedAt: sql`now()` })
          .where(sql`${agentSettings.brandId} = ${brandId} and ${agentSettings.agent} = ${agent}`);
      }
      return { created, activated: !active, label: labelOf(row) };
    });
    if (r.created || r.activated) out.push({ agent, label: r.label, activated: r.activated });
  }
  return out;
}

/** The prompt agents run with: the active DB version (seeded from the file on first use). */
export async function activePrompt(
  db: Db,
  brandId: string,
  agent: AgentName,
): Promise<ActivePrompt> {
  let v = await activeVersion(db, brandId, agent);
  if (!v) {
    await syncPromptFiles(db, brandId);
    v = await activeVersion(db, brandId, agent);
  }
  if (!v) throw new Error(`No active prompt for ${agent}`);
  return toLoaded(v);
}

export async function activePrompts(
  db: Db,
  brandId: string,
): Promise<Record<AgentName, ActivePrompt>> {
  const entries = await Promise.all(
    AGENT_NAMES.map(async (a) => [a, await activePrompt(db, brandId, a)] as const),
  );
  return Object.fromEntries(entries) as Record<AgentName, ActivePrompt>;
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
export async function promptHistory(db: Db, brandId: string, agent: AgentName) {
  const active = await activePrompt(db, brandId, agent);
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
    active: r.id === active.id,
  }));
  const activeRow = versions.find((v) => v.active)!;
  const newestFile = versions.find((v) => v.source === 'file');
  const pendingFile =
    newestFile && !newestFile.active && newestFile.version > activeRow.version ? newestFile : null;
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
  agent: AgentName,
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
  agent: AgentName,
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
  agent: AgentName,
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

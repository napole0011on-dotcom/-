import type { Actor } from '@cms/core';
import { schema, sql, type Db, type DbOrTx } from '@cms/db';
import { capabilityById, isToolCapability, type ModelRole } from './capabilities.js';
import { ConstructorSpec, specHash, type AgentTestRecord } from './constructor.js';
import { OutputField } from './fields.js';
import {
  BRIEF,
  OWNER,
  TEAM_ROLES,
  TEAM_ROLE_LABEL,
  type NodeStatus,
  type TeamRole,
} from './graph.js';
import { activePrompt, hasActivePrompt, savePromptVersion } from './prompt-store.js';
import { loadWorkspace, nextColor, placeNewNode, type ChangeResult } from './workspace.js';

const { agentDefinitions, agentLinks, agentLayout, agentSettings, auditLog, artifacts, tasks } =
  schema;

/**
 * One agent as the runtime and the panel see it. There are no built-in agents: every agent
 * is the owner's record (made by hand, from blocks or copied from the library). The engine
 * looks agents up by team role and capability, never by id. Humans («Бриф», «Вы») are not agents.
 */
export interface AgentRef {
  id: string;
  name: string;
  /** One line on the card (what the agent does). */
  role: string;
  description: string;
  kind: 'custom';
  status: NodeStatus;
  color: string;
  icon: string;
  teamRole: TeamRole;
  capability: string | null;
  /** LLM_MODEL_* role (null: a tool capability without an LLM). */
  modelRole: ModelRole | null;
  /** Key in prompt_versions (the agent id); null when the agent has no LLM. */
  promptAgent: string | null;
  spec: Record<string, unknown>;
}

const MODEL_ROLES: readonly ModelRole[] = ['ceo', 'worker', 'critic', 'classifier'];
const asRole = (r: string | null): ModelRole | null =>
  r && (MODEL_ROLES as readonly string[]).includes(r) ? (r as ModelRole) : null;
export const asTeamRole = (r: unknown): TeamRole =>
  typeof r === 'string' && (TEAM_ROLES as readonly string[]).includes(r)
    ? (r as TeamRole)
    : 'worker';

/** The default LLM_MODEL_* role for a team role (the owner can pick another model). */
export const defaultModelRole = (r: TeamRole): ModelRole =>
  r === 'planner' ? 'ceo' : r === 'reviewer' ? 'critic' : 'worker';

/** The agent's output is described by owner's fields (planner/reviewer/capabilities have fixed ones). */
export const needsFields = (a: Pick<AgentRef, 'teamRole' | 'capability'>) =>
  a.teamRole !== 'planner' && a.teamRole !== 'reviewer' && !a.capability;

/** The agent calls an LLM (needs a prompt and a model). */
export const usesLlm = (a: Pick<AgentRef, 'capability'>) => !isToolCapability(a.capability);

/** All agents of the brand in board order (drafts included, deleted ones not). */
export async function listAgents(db: Db, brandId: string): Promise<AgentRef[]> {
  const ws = await loadWorkspace(db, brandId);
  return ws.nodes
    .filter((n) => n.kind !== 'human')
    .map((n) => {
      const capability = n.capability ?? null;
      const llm = !isToolCapability(capability);
      return {
        id: n.id,
        name: n.name,
        role: n.role,
        description: n.description,
        kind: 'custom' as const,
        status: n.status,
        color: n.color,
        icon: n.icon,
        teamRole: asTeamRole(n.teamRole),
        capability,
        modelRole: llm ? (asRole(n.modelRole) ?? defaultModelRole(asTeamRole(n.teamRole))) : null,
        promptAgent: llm ? n.id : null,
        spec: n.spec,
      };
    });
}

export async function resolveAgent(db: Db, brandId: string, id: string): Promise<AgentRef | null> {
  return (await listAgents(db, brandId)).find((a) => a.id === id) ?? null;
}

/** Agents with this team role (active first). */
export async function agentsWithRole(db: Db, brandId: string, role: TeamRole) {
  return (await listAgents(db, brandId))
    .filter((a) => a.teamRole === role)
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'));
}

/** The name of an agent for history (runs, prompts, audit) — deleted agents included. */
export async function agentNames(db: DbOrTx, brandId: string): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: agentDefinitions.id, name: agentDefinitions.name })
    .from(agentDefinitions)
    .where(sql`${agentDefinitions.brandId} = ${brandId}`);
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/** Spec of an agent with owner's fields (defaults for a fresh draft with no fields yet). */
export function constructorSpecOf(ref: Pick<AgentRef, 'spec'>): {
  spec: ConstructorSpec | null;
  raw: Record<string, unknown>;
} {
  const parsed = ConstructorSpec.safeParse(ref.spec);
  return { spec: parsed.success ? parsed.data : null, raw: ref.spec };
}

/** What the last test must match: fields, criteria, role and capability. */
export function specHashOf(ref: Pick<AgentRef, 'spec' | 'teamRole' | 'capability'>): string {
  const raw = ref.spec as { fields?: unknown; criteria?: unknown };
  const fields = OutputField.array().safeParse(raw.fields ?? []);
  const criteria = Array.isArray(raw.criteria) ? (raw.criteria as string[]) : [];
  return specHash({
    fields: fields.success ? fields.data : [],
    criteria,
    teamRole: ref.teamRole,
    capability: ref.capability,
  });
}

// ------------------------------------------------------------------ ids

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}; // prettier-ignore

/** "SEO-менеджер" -> "seo_menedzher" (latin, digits, _; 2..40 chars). */
export function slugify(name: string): string {
  const s = [...name.toLowerCase()]
    .map((c) => TRANSLIT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '');
  return /^[a-z]/.test(s) ? s : `agent_${s}`.slice(0, 40);
}

const RESERVED = new Set([BRIEF, OWNER, 'new', 'tool', 'system', 'owner', 'export', 'test']);
const ID_RE = /^[a-z][a-z0-9_]{1,39}$/;

// ------------------------------------------------------------------ CRUD

export const AgentDraftInput = {
  parse(v: {
    name?: unknown;
    role?: unknown;
    description?: unknown;
    modelRole?: unknown;
    teamRole?: unknown;
    capability?: unknown;
  }): { ok: true; value: AgentDraftFields } | { ok: false; message: string } {
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    const role = typeof v.role === 'string' ? v.role.trim() : '';
    const description = typeof v.description === 'string' ? v.description.trim() : '';
    const teamRole = asTeamRole(v.teamRole);
    if (v.teamRole != null && v.teamRole !== teamRole)
      return { ok: false, message: 'Роль: Планировщик, Проверяющий, Исполнитель или Приёмка' };
    const capability = typeof v.capability === 'string' && v.capability ? v.capability : null;
    if (capability && !capabilityById(capability))
      return { ok: false, message: `Нет такой возможности: ${capability}` };
    const modelRole =
      typeof v.modelRole === 'string' && v.modelRole
        ? asRole(v.modelRole)
        : defaultModelRole(teamRole);
    if (name.length < 2 || name.length > 40)
      return { ok: false, message: 'Название: от 2 до 40 символов' };
    if (role.length < 3 || role.length > 120)
      return { ok: false, message: 'Описание в одну строку: от 3 до 120 символов' };
    if (description.length > 600) return { ok: false, message: 'Описание длиннее 600 символов' };
    if (!modelRole || modelRole === 'classifier')
      return { ok: false, message: 'Модель: CEO, Исполнитель или Critic' };
    return { ok: true, value: { name, role, description, modelRole, teamRole, capability } };
  },
};

export interface AgentDraftFields {
  name: string;
  role: string;
  description: string;
  modelRole: ModelRole;
  teamRole: TeamRole;
  capability: string | null;
}

const audit = (
  tx: DbOrTx,
  brandId: string,
  actor: Actor,
  action: string,
  details: Record<string, unknown>,
) =>
  tx
    .insert(auditLog)
    .values({ brandId, actorKind: actor.kind, actorId: actor.id, action, details });

const lockWs = (tx: DbOrTx, brandId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`workspace:${brandId}`}))`);

export interface RegistryResult extends ChangeResult {
  id?: string;
}

/** Ids ever used by the brand, deleted agents included: a new agent never reuses one. */
async function usedIds(db: DbOrTx, brandId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: agentDefinitions.id })
    .from(agentDefinitions)
    .where(sql`${agentDefinitions.brandId} = ${brandId}`);
  return new Set(rows.map((r) => r.id));
}

/**
 * A new agent as a draft: it appears on the board but does not run until it passes a test and
 * is switched on. `id` is a preference (e.g. the template slug); a taken one gets a suffix.
 */
export async function createConstructorAgent(
  db: Db,
  brandId: string,
  input: Omit<AgentDraftFields, 'teamRole' | 'capability'> &
    Partial<Pick<AgentDraftFields, 'teamRole' | 'capability'>> & {
      id?: string;
      prompt?: string | null;
      /** The id must be exactly this one (the API for an explicit id). */
      strictId?: boolean;
    },
  actor: Actor,
): Promise<RegistryResult> {
  const ws = await loadWorkspace(db, brandId);
  const taken = await usedIds(db, brandId);
  let id = input.id?.trim() || slugify(input.name);
  if (!ID_RE.test(id))
    return { ok: false, message: 'Идентификатор: латиница, цифры и _, с буквы, 2–40 символов' };
  if (RESERVED.has(id)) return { ok: false, message: `Имя «${id}» зарезервировано` };
  if (input.strictId && taken.has(id)) return { ok: false, message: `Агент «${id}» уже есть` };
  const base = id;
  for (let i = 2; taken.has(id); i++) id = `${base.slice(0, 36)}_${i}`;
  if (ws.nodes.some((n) => n.name.toLowerCase() === input.name.toLowerCase()))
    return { ok: false, message: `Агент с названием «${input.name}» уже есть` };
  const teamRole = input.teamRole ?? 'worker';
  const capability = input.capability ?? null;

  const created = await db.transaction(async (tx) => {
    await lockWs(tx, brandId);
    if ((await usedIds(tx, brandId)).has(id)) return false;
    await tx.insert(agentDefinitions).values({
      brandId,
      id,
      name: input.name,
      role: input.role,
      description: input.description,
      kind: 'custom',
      status: 'draft',
      teamRole,
      capability,
      color: nextColor(ws.nodes.map((n) => n.color)),
      icon: [...input.name][0]!.toUpperCase(),
      modelRole: isToolCapability(capability) ? null : input.modelRole,
      spec: { fields: [], criteria: [], lastTest: null },
      createdBy: actor.id,
    });
    await placeNewNode(tx, brandId, id);
    await audit(tx, brandId, actor, 'agent_created', {
      agent: id,
      name: input.name,
      teamRole,
      capability,
    });
    return true;
  });
  if (!created) return { ok: false, message: `Агент «${id}» уже есть` };
  if (input.prompt?.trim()) {
    const r = await savePromptVersion(db, brandId, id, input.prompt, actor);
    if (!r.ok)
      return { ok: true, id, message: `Черновик «${input.name}» создан, промпт: ${r.message}` };
  }
  return {
    ok: true,
    id,
    message: `Черновик «${input.name}» создан. Проверьте тестом и включите.`,
  };
}

const editable = (ref: AgentRef | null): string | null => (!ref ? 'Нет такого агента' : null);

/**
 * Name, role, model role, team role, capability and the output spec. Changing what the agent
 * does (fields, criteria, team role, capability) of an ACTIVE agent turns it back into a draft:
 * it must pass a test again.
 */
export async function updateConstructorAgent(
  db: Db,
  brandId: string,
  id: string,
  patch: Partial<Omit<AgentDraftFields, 'capability'>> & {
    capability?: string | null;
    fields?: unknown;
    criteria?: unknown;
  },
  actor: Actor,
): Promise<RegistryResult> {
  const ref = await resolveAgent(db, brandId, id);
  const problem = editable(ref);
  if (problem) return { ok: false, message: problem };
  const cur = ref!;
  const fields = AgentDraftInput.parse({
    name: patch.name ?? cur.name,
    role: patch.role ?? cur.role,
    description: patch.description ?? cur.description,
    modelRole: patch.modelRole ?? cur.modelRole ?? undefined,
    teamRole: patch.teamRole ?? cur.teamRole,
    capability: patch.capability === undefined ? cur.capability : patch.capability,
  });
  if (!fields.ok) return fields;
  const v = fields.value;
  const raw = cur.spec as { fields?: unknown; criteria?: unknown; lastTest?: unknown };
  const nextSpec = {
    ...cur.spec,
    fields: patch.fields ?? raw.fields ?? [],
    criteria: patch.criteria ?? raw.criteria ?? [],
    lastTest: raw.lastTest ?? null,
  };
  const fieldsChanged =
    (patch.fields !== undefined && JSON.stringify(patch.fields) !== JSON.stringify(raw.fields)) ||
    (patch.criteria !== undefined &&
      JSON.stringify(patch.criteria) !== JSON.stringify(raw.criteria));
  if (fieldsChanged) {
    const parsed = (needsFields(v) ? ConstructorSpec : ConstructorSpec.partial()).safeParse(
      nextSpec,
    );
    if (!parsed.success) return { ok: false, message: zodMessage(parsed.error) };
    nextSpec.fields = parsed.data.fields ?? [];
    nextSpec.criteria = parsed.data.criteria ?? [];
  }
  const roleChanged = v.teamRole !== cur.teamRole;
  const capabilityChanged = v.capability !== cur.capability;
  const specChanged = fieldsChanged || roleChanged || capabilityChanged;
  const others = (await loadWorkspace(db, brandId)).nodes.filter((n) => n.id !== id);
  if (others.some((n) => n.name.toLowerCase() === v.name.toLowerCase()))
    return { ok: false, message: `Агент с названием «${v.name}» уже есть` };
  const backToDraft = specChanged && cur.status === 'active';
  await db.transaction(async (tx) => {
    await lockWs(tx, brandId);
    await tx
      .update(agentDefinitions)
      .set({
        name: v.name,
        role: v.role,
        description: v.description,
        modelRole: isToolCapability(v.capability) ? null : v.modelRole,
        teamRole: v.teamRole,
        capability: v.capability,
        spec: nextSpec,
        ...(backToDraft ? { status: 'draft' } : {}),
        updatedAt: sql`now()`,
      })
      .where(sql`${agentDefinitions.brandId} = ${brandId} and ${agentDefinitions.id} = ${id}`);
    await audit(tx, brandId, actor, 'agent_updated', {
      agent: id,
      specChanged,
      ...(roleChanged ? { teamRole: { from: cur.teamRole, to: v.teamRole } } : {}),
      ...(capabilityChanged ? { capability: { from: cur.capability, to: v.capability } } : {}),
      ...(backToDraft ? { status: { from: 'active', to: 'draft' } } : {}),
    });
  });
  return {
    ok: true,
    id,
    message: backToDraft
      ? `«${v.name}» сохранён и снова черновик: проверьте тестом и включите`
      : roleChanged
        ? `«${v.name}»: роль — ${TEAM_ROLE_LABEL[v.teamRole]}`
        : `«${v.name}» сохранён`,
  };
}

/** Stores the last test result in the spec (only for the saved spec and active prompt). */
export async function recordAgentTest(
  db: Db,
  brandId: string,
  id: string,
  record: AgentTestRecord,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockWs(tx, brandId);
    const [row] = await tx
      .select({ spec: agentDefinitions.spec })
      .from(agentDefinitions)
      .where(sql`${agentDefinitions.brandId} = ${brandId} and ${agentDefinitions.id} = ${id}`);
    if (!row) return;
    await tx
      .update(agentDefinitions)
      .set({ spec: { ...(row.spec as object), lastTest: record } })
      .where(sql`${agentDefinitions.brandId} = ${brandId} and ${agentDefinitions.id} = ${id}`);
  });
}

/** What still blocks activation (Russian, for the owner); empty = may be activated. */
export async function activationProblems(db: Db, brandId: string, ref: AgentRef) {
  const out: string[] = [];
  const { spec } = constructorSpecOf(ref);
  if (needsFields(ref) && !spec) out.push('Добавьте хотя бы одно поле результата');
  const prompt = !usesLlm(ref)
    ? null
    : (await hasActivePrompt(db, brandId, ref.id))
      ? await activePrompt(db, brandId, ref.id)
      : null;
  if (usesLlm(ref) && !prompt) out.push('Сохраните промпт');
  const t = (ref.spec as { lastTest?: AgentTestRecord | null }).lastTest ?? null;
  if (out.length === 0) {
    if (!t) out.push('Запустите тест');
    else if (!t.ok) out.push('Последний тест не прошёл — исправьте и запустите снова');
    else if (t.specHash !== specHashOf(ref) || (prompt && t.promptVersion !== prompt.version))
      out.push('После теста менялись поля, роль или промпт — запустите тест снова');
  }
  return out;
}

/** Draft -> active. Requires a successful test of the current spec and prompt. */
export async function activateConstructorAgent(
  db: Db,
  brandId: string,
  id: string,
  actor: Actor,
  release: () => Promise<void>,
): Promise<RegistryResult> {
  const ref = await resolveAgent(db, brandId, id);
  const problem = editable(ref);
  if (problem) return { ok: false, message: problem };
  if (ref!.status === 'active') return { ok: false, message: 'Агент уже включён' };
  const blockers = await activationProblems(db, brandId, ref!);
  if (blockers.length) return { ok: false, message: `Включить нельзя: ${blockers.join('; ')}` };
  await setStatus(db, brandId, id, 'active', actor, ref!.status);
  // Runs of tasks whose approved plan already had this step wait for it ("agent:<id>").
  await release();
  return {
    ok: true,
    id,
    message: `«${ref!.name}» включён: связи с ним работают для новых задач`,
  };
}

export async function deactivateConstructorAgent(
  db: Db,
  brandId: string,
  id: string,
  actor: Actor,
): Promise<RegistryResult> {
  const ref = await resolveAgent(db, brandId, id);
  const problem = editable(ref);
  if (problem) return { ok: false, message: problem };
  if (ref!.status !== 'active') return { ok: false, message: 'Агент и так не включён' };
  await setStatus(db, brandId, id, 'draft', actor, 'active');
  return {
    ok: true,
    id,
    message: `«${ref!.name}» снова черновик: в новых задачах его шага не будет, начатые ждут`,
  };
}

async function setStatus(
  db: Db,
  brandId: string,
  id: string,
  status: NodeStatus,
  actor: Actor,
  from: NodeStatus,
) {
  await db.transaction(async (tx) => {
    await lockWs(tx, brandId);
    await tx
      .update(agentDefinitions)
      .set({ status, updatedAt: sql`now()` })
      .where(sql`${agentDefinitions.brandId} = ${brandId} and ${agentDefinitions.id} = ${id}`);
    await audit(tx, brandId, actor, status === 'active' ? 'agent_activated' : 'agent_deactivated', {
      agent: id,
      from,
      to: status,
    });
  });
}

/** Unfinished tasks whose plan has this agent (a step, a step's reviewer or the planner). */
export async function tasksUsing(
  db: DbOrTx,
  brandId: string,
  id: string,
): Promise<{ id: string; title: string }[]> {
  return db
    .selectDistinct({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .innerJoin(artifacts, sql`${artifacts.taskId} = ${tasks.id} and ${artifacts.slot} = 'plan'`)
    .where(
      sql`${tasks.brandId} = ${brandId}
        and ${tasks.status} not in ('exported', 'published', 'failed', 'cancelled', 'rejected')
        and (${artifacts.content} -> 'pipeline' -> 'steps' @> ${JSON.stringify([{ agent: id }])}::jsonb
          or ${artifacts.content} -> 'pipeline' -> 'steps' @> ${JSON.stringify([{ reviewer: id }])}::jsonb
          or ${artifacts.content} -> 'pipeline' ->> 'planner' = ${id}
          or ${artifacts.agent} = ${id})`,
    );
}

export interface DeleteResult extends RegistryResult {
  /** Refused because of this task (the panel links to it). */
  taskId?: string;
}

/**
 * Deletes any agent (active ones too: the panel asks to confirm). Refused only while an
 * unfinished task has it in its plan. The record is kept as deleted for history (runs,
 * prompt versions and audit show its name); links, position and settings go.
 */
export async function deleteConstructorAgent(
  db: Db,
  brandId: string,
  id: string,
  actor: Actor,
): Promise<DeleteResult> {
  const ref = await resolveAgent(db, brandId, id);
  const problem = editable(ref);
  if (problem) return { ok: false, message: problem };
  const used = await tasksUsing(db, brandId, id);
  if (used.length > 0)
    return {
      ok: false,
      taskId: used[0]!.id,
      message: `«${ref!.name}» есть в плане незавершённой задачи «${used[0]!.title}»${used.length > 1 ? ` и ещё ${used.length - 1}` : ''}. Завершите или отмените её, потом удалите агента.`,
    };
  const planners =
    ref!.teamRole === 'planner'
      ? (await listAgents(db, brandId)).filter((a) => a.teamRole === 'planner' && a.id !== id)
      : null;
  await db.transaction(async (tx) => {
    await lockWs(tx, brandId);
    await tx
      .delete(agentLinks)
      .where(
        sql`${agentLinks.brandId} = ${brandId} and (${agentLinks.fromNode} = ${id} or ${agentLinks.toNode} = ${id})`,
      );
    await tx
      .delete(agentLayout)
      .where(sql`${agentLayout.brandId} = ${brandId} and ${agentLayout.nodeId} = ${id}`);
    // Prompt versions stay (history refers to them); the settings row goes.
    await tx
      .delete(agentSettings)
      .where(sql`${agentSettings.brandId} = ${brandId} and ${agentSettings.agent} = ${id}`);
    await tx
      .update(agentDefinitions)
      .set({ deletedAt: sql`now()`, status: 'draft', updatedAt: sql`now()` })
      .where(sql`${agentDefinitions.brandId} = ${brandId} and ${agentDefinitions.id} = ${id}`);
    await audit(tx, brandId, actor, 'agent_deleted', {
      agent: id,
      before: {
        name: ref!.name,
        teamRole: ref!.teamRole,
        capability: ref!.capability,
        status: ref!.status,
      },
      after: null,
    });
  });
  return {
    ok: true,
    id,
    message:
      planners && planners.length === 0
        ? `Удалён агент «${ref!.name}». Планировщиков больше нет: новые задачи не запустятся, пока он не появится`
        : `Удалён агент «${ref!.name}» вместе со своими связями`,
  };
}

function zodMessage(err: { issues: { message: string; path: PropertyKey[] }[] }): string {
  const i = err.issues[0];
  return i ? i.message : 'Неверные данные';
}

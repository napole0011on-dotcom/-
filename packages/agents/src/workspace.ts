import type { Actor } from '@cms/core';
import { schema, sql, type Db, type DbOrTx } from '@cms/db';
import {
  AGENT_COLORS,
  BRIEF,
  OWNER,
  autoLayout,
  buildPipeline,
  freeSpot,
  overlaps,
  spareTop,
  validateLink,
  type GraphLink,
  type GraphNode,
  type NodeKind,
  type NodeStatus,
  type Pipeline,
  type TeamRole,
} from './graph.js';

const { agentDefinitions, agentLinks, agentLayout, auditLog } = schema;

export interface WorkspaceNode extends GraphNode {
  role: string;
  description: string;
  color: string;
  icon: string;
  modelRole: string | null;
  teamRole: TeamRole | null;
  capability: string | null;
  spec: Record<string, unknown>;
}

export interface WorkspaceLink extends GraphLink {
  id: string;
  createdBy: string;
  createdAt: Date;
}

export interface Workspace {
  nodes: WorkspaceNode[];
  links: WorkspaceLink[];
  layout: Record<string, { x: number; y: number }>;
}

export interface ChangeResult {
  ok: boolean;
  message: string;
}

/**
 * What every board has: «Бриф» (where a task starts) and «Вы» (the gate). They are not agents
 * and cannot be deleted. There are no built-in agents: the owner creates them or takes them
 * from the library.
 */
const HUMAN_NODES = [
  {
    id: BRIEF,
    name: 'Бриф',
    role: 'вы ставите задачу',
    description: 'Отсюда начинается любая задача: бриф из панели или Telegram. Это вы, а не агент.',
    kind: 'human',
    status: 'active',
    color: 'neutral',
    icon: 'Б',
    modelRole: null,
  },
  {
    id: OWNER,
    name: 'Вы',
    role: 'утверждаете результат',
    description:
      'Гейт согласования: план и итоговый пакет утверждаете только вы. Это вы, а не агент.',
    kind: 'human',
    status: 'active',
    color: 'neutral',
    icon: 'Я',
    modelRole: null,
  },
] as const;

const SEED_ACTOR = 'system:workspace';

/** «Бриф» and «Вы» exist on every board (idempotent; safe from several processes). */
export async function ensureWorkspace(db: Db, brandId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`workspace:${brandId}`}))`);
    await tx
      .insert(agentDefinitions)
      .values(HUMAN_NODES.map((s) => ({ ...s, spec: {}, brandId, createdBy: SEED_ACTOR })))
      .onConflictDoNothing();
    const placed = new Set(
      (
        await tx
          .select({ id: agentLayout.nodeId })
          .from(agentLayout)
          .where(sql`${agentLayout.brandId} = ${brandId}`)
      ).map((r) => r.id),
    );
    if (placed.size === 0) {
      const pos = autoLayout(
        HUMAN_NODES.map((n) => ({ id: n.id })),
        [],
      );
      await tx
        .insert(agentLayout)
        .values(Object.entries(pos).map(([nodeId, p]) => ({ brandId, nodeId, ...p })))
        .onConflictDoNothing();
      return;
    }
    // Boards laid out before cards had a fixed height may have cards on top of each other.
    for (const n of HUMAN_NODES) if (!placed.has(n.id)) await placeNewNode(tx, brandId, n.id);
    await resolveOverlaps(tx, brandId);
  });
}

const liveDefs = (db: DbOrTx, brandId: string) =>
  db
    .select()
    .from(agentDefinitions)
    .where(sql`${agentDefinitions.brandId} = ${brandId} and ${agentDefinitions.deletedAt} is null`)
    .orderBy(agentDefinitions.createdAt);

export async function loadWorkspace(db: Db, brandId: string): Promise<Workspace> {
  let defs = await liveDefs(db, brandId);
  if (!defs.some((d) => d.id === BRIEF) || !defs.some((d) => d.id === OWNER)) {
    await ensureWorkspace(db, brandId);
    defs = await liveDefs(db, brandId);
  }
  // Stable order: «Бриф» first, «Вы» last, agents as created.
  const rank = (id: string) => (id === BRIEF ? -1 : id === OWNER ? 1 : 0);
  const nodes: WorkspaceNode[] = defs
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d.id) - rank(b.d.id) || a.i - b.i)
    .map(({ d }) => ({
      id: d.id,
      name: d.name,
      role: d.role,
      description: d.description,
      kind: (d.kind === 'human' ? 'human' : 'custom') as NodeKind,
      status: (d.status === 'active' ? 'active' : 'draft') as NodeStatus,
      color: d.color,
      icon: d.icon,
      modelRole: d.modelRole,
      teamRole: d.kind === 'human' ? null : ((d.teamRole as TeamRole | null) ?? 'worker'),
      capability: d.capability,
      spec: d.spec as Record<string, unknown>,
    }));
  const live = new Set(nodes.map((n) => n.id));
  const links = (
    await db
      .select()
      .from(agentLinks)
      .where(sql`${agentLinks.brandId} = ${brandId}`)
      .orderBy(agentLinks.createdAt)
  )
    .filter((l) => live.has(l.fromNode) && live.has(l.toNode))
    .map((l) => ({
      id: l.id,
      from: l.fromNode,
      to: l.toNode,
      createdBy: l.createdBy,
      createdAt: l.createdAt,
    }));
  const layout: Workspace['layout'] = {};
  for (const p of await db
    .select()
    .from(agentLayout)
    .where(sql`${agentLayout.brandId} = ${brandId}`))
    if (live.has(p.nodeId)) layout[p.nodeId] = { x: p.x, y: p.y };
  return { nodes, links, layout };
}

/** Execution plan for a new task from the current board. */
export async function currentPipeline(
  db: Db,
  brandId: string,
  sources: readonly string[] = [],
  plannerId?: string,
): Promise<Pipeline> {
  const w = await loadWorkspace(db, brandId);
  return buildPipeline(w.nodes, w.links, sources, plannerId);
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

export async function addLink(
  db: Db,
  brandId: string,
  from: string,
  to: string,
  actor: Actor,
): Promise<ChangeResult & { linkId?: string }> {
  await loadWorkspace(db, brandId); // «Бриф» and «Вы» on first use
  return db.transaction(async (tx) => {
    await lockWs(tx, brandId);
    const nodes = (await liveDefs(tx, brandId)).map((d) => ({
      id: d.id,
      name: d.name,
      kind: (d.kind === 'human' ? 'human' : 'custom') as NodeKind,
      status: (d.status === 'active' ? 'active' : 'draft') as NodeStatus,
      teamRole: d.teamRole as TeamRole | null,
      capability: d.capability,
    }));
    const links = (
      await tx
        .select()
        .from(agentLinks)
        .where(sql`${agentLinks.brandId} = ${brandId}`)
    ).map((l) => ({ from: l.fromNode, to: l.toNode }));
    const problem = validateLink(nodes, links, from, to);
    if (problem) return { ok: false, message: problem };
    const [row] = await tx
      .insert(agentLinks)
      .values({ brandId, fromNode: from, toNode: to, kind: 'user', createdBy: actor.id })
      .returning({ id: agentLinks.id });
    await audit(tx, brandId, actor, 'link_added', { from, to });
    const name = (id: string) => nodes.find((n) => n.id === id)!.name;
    const target = nodes.find((n) => n.id === to)!;
    const note =
      target.kind !== 'human' && target.status !== 'active'
        ? ' (заработает, когда агент станет активным)'
        : '';
    return {
      ok: true,
      linkId: row!.id,
      message: `Связь ${name(from)} → ${name(to)} добавлена${note}. Действует для новых задач.`,
    };
  });
}

export async function deleteLink(
  db: Db,
  brandId: string,
  linkId: string,
  actor: Actor,
): Promise<ChangeResult> {
  return db.transaction(async (tx) => {
    await lockWs(tx, brandId);
    const [link] = await tx
      .select()
      .from(agentLinks)
      .where(sql`${agentLinks.id} = ${linkId} and ${agentLinks.brandId} = ${brandId}`);
    if (!link) return { ok: false, message: 'Связь не найдена' };
    await tx.delete(agentLinks).where(sql`${agentLinks.id} = ${linkId}`);
    await audit(tx, brandId, actor, 'link_deleted', { from: link.fromNode, to: link.toNode });
    const names = await tx
      .select({ id: agentDefinitions.id, name: agentDefinitions.name })
      .from(agentDefinitions)
      .where(sql`${agentDefinitions.brandId} = ${brandId}`);
    const name = (id: string) => names.find((n) => n.id === id)?.name ?? id;
    return {
      ok: true,
      message: `Связь ${name(link.fromNode)} → ${name(link.toNode)} удалена. Действует для новых задач.`,
    };
  });
}

const clampPos = (v: number) => Math.max(-20000, Math.min(20000, Math.round(v)));

/** Node positions after a drag (saved on drop). Audited, not mirrored to Telegram. */
export async function saveLayout(
  db: Db,
  brandId: string,
  positions: Record<string, { x: number; y: number }>,
  actor: Actor,
  action = 'layout_moved',
): Promise<ChangeResult> {
  const ws = await loadWorkspace(db, brandId);
  const ids = Object.keys(positions).filter((id) => ws.nodes.some((n) => n.id === id));
  if (ids.length === 0) return { ok: false, message: 'Нечего сохранять' };
  await db.transaction(async (tx) => {
    const changes = [];
    for (const id of ids) {
      const p = { x: clampPos(positions[id]!.x), y: clampPos(positions[id]!.y) };
      changes.push({ node: id, from: ws.layout[id] ?? null, to: p });
      await tx
        .insert(agentLayout)
        .values({ brandId, nodeId: id, ...p, updatedBy: actor.id })
        .onConflictDoUpdate({
          target: [agentLayout.brandId, agentLayout.nodeId],
          set: { ...p, updatedBy: actor.id, updatedAt: sql`now()` },
        });
    }
    await audit(tx, brandId, actor, action, { changes });
  });
  return {
    ok: true,
    message: action === 'layout_auto' ? 'Агенты расставлены' : 'Положение сохранено',
  };
}

export async function autoArrange(db: Db, brandId: string, actor: Actor): Promise<ChangeResult> {
  const ws = await loadWorkspace(db, brandId);
  return saveLayout(db, brandId, autoLayout(ws.nodes, ws.links), actor, 'layout_auto');
}

/** A new registry agent appears on the board in a free spot (never on top of another card). */
export async function placeNewNode(db: DbOrTx, brandId: string, nodeId: string): Promise<void> {
  const rows = await db
    .select()
    .from(agentLayout)
    .where(sql`${agentLayout.brandId} = ${brandId}`);
  const links = await db
    .select({ from: agentLinks.fromNode, to: agentLinks.toNode })
    .from(agentLinks)
    .where(sql`${agentLinks.brandId} = ${brandId}`);
  const pos = Object.fromEntries(rows.map((r) => [r.nodeId, { x: r.x, y: r.y }]));
  const p = freeSpot(
    rows.map((r) => ({ x: r.x, y: r.y })),
    spareTop(pos, links),
  );
  await db
    .insert(agentLayout)
    .values({ brandId, nodeId, ...p })
    .onConflictDoNothing();
}

/**
 * Cards that overlap another card (e.g. a board laid out by an older version) are moved to
 * free spots; positions the owner chose and that do not overlap stay as they are.
 */
export async function resolveOverlaps(db: DbOrTx, brandId: string): Promise<number> {
  const rows = await db
    .select()
    .from(agentLayout)
    .where(sql`${agentLayout.brandId} = ${brandId}`)
    .orderBy(agentLayout.updatedAt);
  const links = await db
    .select({ from: agentLinks.fromNode, to: agentLinks.toNode })
    .from(agentLinks)
    .where(sql`${agentLinks.brandId} = ${brandId}`);
  const top = spareTop(Object.fromEntries(rows.map((r) => [r.nodeId, r])), links);
  const kept: { x: number; y: number }[] = [];
  let moved = 0;
  for (const r of rows) {
    if (!kept.some((k) => overlaps(k, r))) {
      kept.push({ x: r.x, y: r.y });
      continue;
    }
    const p = freeSpot(kept, top);
    kept.push(p);
    moved++;
    await db
      .update(agentLayout)
      .set({ ...p, updatedAt: sql`now()` })
      .where(sql`${agentLayout.brandId} = ${brandId} and ${agentLayout.nodeId} = ${r.nodeId}`);
  }
  return moved;
}

export const nextColor = (used: string[]) =>
  AGENT_COLORS.find((c) => !used.includes(c)) ?? AGENT_COLORS[used.length % AGENT_COLORS.length]!;

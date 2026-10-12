import type { Actor } from '@cms/core';
import { schema, sql, type Db, type DbOrTx } from '@cms/db';
import {
  AGENT_COLORS,
  BRIEF,
  OWNER,
  SYSTEM_LINKS,
  autoLayout,
  buildPipeline,
  freeSpot,
  overlaps,
  spareTop,
  deleteLinkProblem,
  validateLink,
  type GraphLink,
  type GraphNode,
  type NodeKind,
  type NodeStatus,
  type Pipeline,
} from './graph.js';
import { AGENTS } from './registry.js';
import { TOOLS } from './tools/registry.js';

const { agentDefinitions, agentLinks, agentLayout, auditLog } = schema;

export interface WorkspaceNode extends GraphNode {
  role: string;
  description: string;
  color: string;
  icon: string;
  modelRole: string | null;
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

type Seed = Omit<WorkspaceNode, 'spec'> & { spec?: Record<string, unknown> };

/** What the board starts with: two human nodes, the three working agents, two planned ones. */
function seedNodes(): Seed[] {
  const code = (id: string, color: string, icon: string): Seed => {
    const def = AGENTS.find((a) => a.id === id)!;
    return {
      id,
      name: def.name,
      role: def.role,
      description: def.description,
      kind: 'code',
      status: 'active',
      color,
      icon,
      modelRole: def.modelRole,
    };
  };
  return [
    {
      id: BRIEF,
      name: 'Бриф',
      role: 'вы ставите задачу',
      description: 'Отсюда начинается любая задача: бриф из панели или Telegram.',
      kind: 'human',
      status: 'active',
      color: 'neutral',
      icon: 'Б',
      modelRole: null,
    },
    code('ceo', 'violet', 'C'),
    code('copywriter', 'indigo', 'К'),
    code('critic', 'cyan', 'Ч'),
    {
      id: 'seo',
      name: 'SEO-менеджер',
      role: 'приёмка: ключи, хэштеги, заголовки',
      description: 'Проверяет и дополняет результат перед тем, как он попадёт к вам.',
      kind: 'constructor',
      status: 'planned',
      color: 'emerald',
      icon: 'S',
      modelRole: 'worker',
    },
    code('image', 'pink', 'И'),
    code('kp', 'amber', 'П'),
    ...TOOLS.map((t): Seed => ({
      id: t.id,
      name: t.name,
      role: t.role,
      description: t.description,
      kind: 'tool',
      status: 'active',
      color: t.color,
      icon: t.icon,
      modelRole: null,
    })),
    {
      id: OWNER,
      name: 'Вы',
      role: 'утверждаете результат',
      description: 'Гейт согласования: план и итоговый пакет утверждаете только вы.',
      kind: 'human',
      status: 'active',
      color: 'neutral',
      icon: 'Я',
      modelRole: null,
    },
  ];
}

const SEED_ACTOR = 'system:workspace';

/** Creates the default board once (idempotent; safe from several processes). */
export async function ensureWorkspace(db: Db, brandId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`workspace:${brandId}`}))`);
    const seeds = seedNodes();
    const [{ defs } = { defs: 0 }] = await tx
      .select({ defs: sql<number>`count(*)::int` })
      .from(agentDefinitions)
      .where(sql`${agentDefinitions.brandId} = ${brandId}`);
    // Seeded once: an agent the owner deleted (e.g. a constructor draft) does not come back.
    // Code agents and the two human nodes are always present.
    const always = new Set([BRIEF, OWNER, ...AGENTS.map((a) => a.id), ...TOOLS.map((t) => t.id)]);
    await tx
      .insert(agentDefinitions)
      .values(
        seeds
          .filter((s) => defs === 0 || always.has(s.id))
          .map((s) => ({ ...s, spec: s.spec ?? {}, brandId, createdBy: SEED_ACTOR })),
      )
      .onConflictDoNothing();
    await tx
      .insert(agentLinks)
      .values(
        SYSTEM_LINKS.map(([fromNode, toNode]) => ({
          brandId,
          fromNode,
          toNode,
          kind: 'system',
          createdBy: SEED_ACTOR,
        })),
      )
      .onConflictDoNothing();
    // Agents that were "planned" on the board and now exist in code become active once.
    const upgraded = await tx
      .update(agentDefinitions)
      .set({
        status: 'active',
        modelRole: sql`coalesce(${agentDefinitions.modelRole}, 'worker')`,
        updatedAt: sql`now()`,
      })
      .where(
        sql`${agentDefinitions.brandId} = ${brandId} and ${agentDefinitions.kind} = 'code' and ${agentDefinitions.status} = 'planned' and ${agentDefinitions.id} in ${AGENTS.map((a) => a.id)}`,
      )
      .returning({ id: agentDefinitions.id });
    for (const u of upgraded)
      await tx.insert(auditLog).values({
        brandId,
        actorKind: 'system',
        actorId: SEED_ACTOR,
        action: 'agent_activated',
        details: { agent: u.id, from: 'planned', to: 'active', reason: 'implemented in code' },
      });
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentLayout)
      .where(sql`${agentLayout.brandId} = ${brandId}`);
    if (n > 0) {
      // Nodes added by a newer version (tools, code agents) get a free spot on an existing board.
      const placed = new Set(
        (
          await tx
            .select({ id: agentLayout.nodeId })
            .from(agentLayout)
            .where(sql`${agentLayout.brandId} = ${brandId}`)
        ).map((r) => r.id),
      );
      const present = await tx
        .select({ id: agentDefinitions.id })
        .from(agentDefinitions)
        .where(sql`${agentDefinitions.brandId} = ${brandId}`);
      for (const { id } of present) if (!placed.has(id)) await placeNewNode(tx, brandId, id);
      // Boards laid out before cards had a fixed height may have cards on top of each other.
      await resolveOverlaps(tx, brandId);
    }
    if (n === 0) {
      const pos = autoLayout(
        seeds,
        SYSTEM_LINKS.map(([from, to]) => ({ from, to })),
      );
      await tx
        .insert(agentLayout)
        .values(Object.entries(pos).map(([nodeId, p]) => ({ brandId, nodeId, ...p })))
        .onConflictDoNothing();
    }
  });
}

export async function loadWorkspace(db: Db, brandId: string): Promise<Workspace> {
  let defs = await db
    .select()
    .from(agentDefinitions)
    .where(sql`${agentDefinitions.brandId} = ${brandId}`)
    .orderBy(agentDefinitions.createdAt);
  if (defs.length === 0) {
    await ensureWorkspace(db, brandId);
    defs = await db
      .select()
      .from(agentDefinitions)
      .where(sql`${agentDefinitions.brandId} = ${brandId}`)
      .orderBy(agentDefinitions.createdAt);
  }
  // Stable order: human "Бриф" first, "Вы" last, seeded agents in seed order, then as created.
  const seedOrder = seedNodes().map((n) => n.id);
  const rank = (id: string) => (id === BRIEF ? -1 : id === OWNER ? 1 : 0);
  const seedRank = (id: string) => {
    const i = seedOrder.indexOf(id);
    return i < 0 ? seedOrder.length : i;
  };
  const nodes: WorkspaceNode[] = defs
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d.id) - rank(b.d.id) || seedRank(a.d.id) - seedRank(b.d.id) || a.i - b.i)
    .map(({ d }) => ({
      id: d.id,
      name: d.name,
      role: d.role,
      description: d.description,
      kind: d.kind as NodeKind,
      status: d.status as NodeStatus,
      color: d.color,
      icon: d.icon,
      modelRole: d.modelRole,
      spec: d.spec as Record<string, unknown>,
    }));
  const links = (
    await db
      .select()
      .from(agentLinks)
      .where(sql`${agentLinks.brandId} = ${brandId}`)
      .orderBy(agentLinks.createdAt)
  ).map((l) => ({
    id: l.id,
    from: l.fromNode,
    to: l.toNode,
    kind: l.kind as GraphLink['kind'],
    createdBy: l.createdBy,
    createdAt: l.createdAt,
  }));
  const layout: Workspace['layout'] = {};
  for (const p of await db
    .select()
    .from(agentLayout)
    .where(sql`${agentLayout.brandId} = ${brandId}`))
    layout[p.nodeId] = { x: p.x, y: p.y };
  return { nodes, links, layout };
}

/** Execution plan for a new task from the current board. */
export async function currentPipeline(
  db: Db,
  brandId: string,
  sources: readonly string[] = [],
): Promise<Pipeline> {
  const w = await loadWorkspace(db, brandId);
  return buildPipeline(w.nodes, w.links, sources);
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
  await loadWorkspace(db, brandId); // seeds on first use
  return db.transaction(async (tx) => {
    await lockWs(tx, brandId);
    const nodes = (
      await tx
        .select()
        .from(agentDefinitions)
        .where(sql`${agentDefinitions.brandId} = ${brandId}`)
    ).map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind as NodeKind,
      status: d.status as NodeStatus,
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
    const problem = deleteLinkProblem({
      from: link.fromNode,
      to: link.toNode,
      kind: link.kind as GraphLink['kind'],
    });
    if (problem) return { ok: false, message: problem };
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

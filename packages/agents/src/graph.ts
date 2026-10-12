/**
 * The agent graph on the workspace board. A link A -> B means: A's result goes to B's input
 * and B runs after A. Pure functions only (validation, execution order, layout), shared by
 * the workflow, the panel API and tests.
 */

export const BRIEF = 'brief';
export const OWNER = 'me';
export const PLANNER = 'ceo';
export const COPYWRITER = 'copywriter';
export const CRITIC = 'critic';

export type NodeKind = 'human' | 'code' | 'constructor' | 'tool';
export type NodeStatus = 'active' | 'draft' | 'planned';

export interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  status: NodeStatus;
}

export interface GraphLink {
  from: string;
  to: string;
  kind: 'system' | 'user';
}

/** The working pipeline. These links cannot be deleted: without them the scenario breaks. */
export const SYSTEM_LINKS: readonly (readonly [string, string])[] = [
  [BRIEF, PLANNER],
  [PLANNER, COPYWRITER],
  [COPYWRITER, CRITIC],
  [CRITIC, OWNER],
];

export const isSystemLink = (from: string, to: string) =>
  SYSTEM_LINKS.some(([f, t]) => f === from && t === to);

/** Color tokens for agents, assigned round-robin and stored in the registry. */
export const AGENT_COLORS = [
  'violet',
  'indigo',
  'blue',
  'cyan',
  'pink',
  'emerald',
  'amber',
] as const;

const hasPath = (links: Pick<GraphLink, 'from' | 'to'>[], from: string, to: string): boolean => {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const l of links) if (l.from === n) stack.push(l.to);
  }
  return false;
};

/** Why a new link from -> to is not allowed (in Russian, for the owner), or null. */
export function validateLink(
  nodes: GraphNode[],
  links: Pick<GraphLink, 'from' | 'to'>[],
  from: string,
  to: string,
): string | null {
  const a = nodes.find((n) => n.id === from);
  const b = nodes.find((n) => n.id === to);
  if (!a || !b) return 'Такого узла нет на доске';
  if (from === to) return 'Нельзя связать агента с самим собой';
  if (to === BRIEF) return 'В «Бриф» связи не входят: это начало задачи';
  if (from === OWNER) return '«Вы» — последний шаг: дальше результат идёт только на экспорт';
  if (from === BRIEF && to !== PLANNER) return 'Бриф передаётся только CEO: сначала нужен план';
  if (to === PLANNER) return 'CEO получает только бриф';
  if (links.some((l) => l.from === from && l.to === to)) return 'Такая связь уже есть';
  if (hasPath(links, to, from)) return 'Получится цикл: агенты будут ждать друг друга бесконечно';
  return null;
}

export function deleteLinkProblem(link: Pick<GraphLink, 'from' | 'to' | 'kind'>): string | null {
  return link.kind === 'system' || isSystemLink(link.from, link.to)
    ? 'Это связь основного конвейера (Бриф → CEO → Копирайтер → Critic → Вы), её удалить нельзя'
    : null;
}

export interface PipelineStep {
  agent: string;
  name: string;
  /** Steps whose results this step receives and waits for. */
  after: string[];
  /** The step's result is checked by the Critic (link step -> Critic) before going further. */
  reviewed: boolean;
}

/** Snapshot stored in the plan: what will run, in which order, and what is switched off. */
export interface Pipeline {
  steps: PipelineStep[];
  /** Linked but not running yet (planned / draft agent), with the reason. */
  inactive: { agent: string; name: string; reason: string }[];
  links: { from: string; to: string }[];
}

/**
 * Execution order for one task. Work steps are the active agents reachable from CEO; the
 * Critic is a reviewer, not a step: "A -> Critic -> B" means B gets A's result after review.
 * An inactive node blocks the path through it (its links start working once it is active).
 */
export function buildPipeline(nodes: GraphNode[], links: GraphLink[]): Pipeline {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const active = (id: string) => {
    const n = byId.get(id);
    return !!n && n.kind !== 'human' && n.status === 'active';
  };
  const reach = new Set<string>();
  const stack = [PLANNER];
  while (stack.length) {
    const n = stack.pop()!;
    for (const l of links) {
      if (l.from !== n || reach.has(l.to) || !active(l.to)) continue;
      reach.add(l.to);
      stack.push(l.to);
    }
  }
  reach.delete(PLANNER);
  reach.delete(CRITIC);
  const work = nodes.filter((n) => reach.has(n.id)).map((n) => n.id);
  const has = (f: string, t: string) => links.some((l) => l.from === f && l.to === t);
  const criticOn = active(CRITIC);
  const deps = new Map(
    work.map((b) => [
      b,
      work.filter((a) => a !== b && (has(a, b) || (criticOn && has(a, CRITIC) && has(CRITIC, b)))),
    ]),
  );
  // Topological order, stable by registry order.
  const order: string[] = [];
  const left = new Set(work);
  while (left.size) {
    const ready = work.filter((w) => left.has(w) && deps.get(w)!.every((d) => !left.has(d)));
    if (ready.length === 0) throw new Error('agent graph has a cycle');
    for (const r of ready) {
      order.push(r);
      left.delete(r);
    }
  }
  const inactive = nodes
    .filter(
      (n) =>
        n.kind !== 'human' &&
        n.status !== 'active' &&
        links.some((l) => l.from === n.id || l.to === n.id),
    )
    .map((n) => ({
      agent: n.id,
      name: n.name,
      reason: n.status === 'planned' ? 'агент ещё не создан' : 'агент в черновике',
    }));
  return {
    steps: order.map((agent) => ({
      agent,
      name: byId.get(agent)!.name,
      after: deps.get(agent)!,
      reviewed: criticOn && has(agent, CRITIC),
    })),
    inactive,
    links: links.map((l) => ({ from: l.from, to: l.to })),
  };
}

/** The pipeline of tasks planned before the board existed: copywriter + critic only. */
export const DEFAULT_PIPELINE: Pipeline = {
  steps: [{ agent: COPYWRITER, name: 'Копирайтер', after: [], reviewed: true }],
  inactive: [],
  links: SYSTEM_LINKS.map(([from, to]) => ({ from, to })),
};

/** Is a link working right now (both ends active, or a human node)? */
export function linkActive(nodes: GraphNode[], link: Pick<GraphLink, 'from' | 'to'>): boolean {
  const ok = (id: string) => {
    const n = nodes.find((x) => x.id === id);
    return !!n && (n.kind === 'human' || n.status === 'active');
  };
  return ok(link.from) && ok(link.to);
}

export const NODE_W = 220;
export const NODE_H = 140;

/** Layered layout: column = longest path from "Бриф"; unlinked nodes go to an extra column. */
export function autoLayout(
  nodes: Pick<GraphNode, 'id'>[],
  links: Pick<GraphLink, 'from' | 'to'>[],
): Record<string, { x: number; y: number }> {
  const level = new Map<string, number>([[BRIEF, 0]]);
  for (let i = 0; i < nodes.length; i++) {
    for (const l of links) {
      const f = level.get(l.from);
      if (f === undefined) continue;
      if ((level.get(l.to) ?? -1) < f + 1) level.set(l.to, f + 1);
    }
  }
  const maxLevel = Math.max(
    0,
    ...[...level.entries()].filter(([k]) => k !== OWNER).map(([, v]) => v),
  );
  level.set(OWNER, maxLevel + 1);
  for (const n of nodes)
    if (!level.has(n.id)) level.set(n.id, maxLevel === 0 ? 1 : Math.max(1, maxLevel));
  const columns = new Map<number, string[]>();
  for (const n of nodes) {
    const l = level.get(n.id)!;
    columns.set(l, [...(columns.get(l) ?? []), n.id]);
  }
  const out: Record<string, { x: number; y: number }> = {};
  const tallest = Math.max(...[...columns.values()].map((c) => c.length));
  for (const [l, ids] of columns) {
    const offset = ((tallest - ids.length) * (NODE_H + 40)) / 2;
    ids.forEach((id, i) => {
      out[id] = { x: l * (NODE_W + 80), y: Math.round(offset + i * (NODE_H + 40)) };
    });
  }
  return out;
}

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

/**
 * Tool nodes that start from a file, not from the brief: their links bring the task's
 * transcript to the linked agents. Allowed targets are fixed (spec of stage 2.7).
 */
export const SOURCE_TOOLS = ['stt_voice', 'video_transcribe'] as const;
export const SOURCE_TARGETS: Record<string, readonly string[]> = {
  stt_voice: ['reels', 'kp', 'copywriter', 'seo'],
  video_transcribe: ['video_summary', 'reels', 'copywriter', 'seo'],
};
/** Tools that are never linked: they run from their own page after a human decision. */
export const UNLINKABLE_TOOLS = ['mailer_send'] as const;

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
  if (
    (UNLINKABLE_TOOLS as readonly string[]).includes(from) ||
    (UNLINKABLE_TOOLS as readonly string[]).includes(to)
  )
    return 'Отправка писем не связывается с агентами: она запускается со страницы «Рассылка» после вашего подтверждения';
  if ((SOURCE_TOOLS as readonly string[]).includes(to))
    return 'Расшифровка начинается с файла (голосовое или видео), в неё связи не входят';
  if ((SOURCE_TOOLS as readonly string[]).includes(from) && !SOURCE_TARGETS[from]!.includes(to))
    return `Расшифровку можно передать только агентам: ${SOURCE_TARGETS[from]!.join(', ')}`;
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
  /** Source tools linked to this step (stt_voice, video_transcribe): it gets their transcripts. */
  inputs?: string[];
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
export function buildPipeline(
  nodes: GraphNode[],
  links: GraphLink[],
  /** Source tools that have an attachment in this task (their links start working). */
  sources: readonly string[] = [],
): Pipeline {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const active = (id: string) => {
    const n = byId.get(id);
    return !!n && n.kind !== 'human' && n.status === 'active';
  };
  const liveSources = sources.filter((x) => active(x));
  const reach = new Set<string>();
  const stack = [PLANNER, ...liveSources];
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
  // Source tools are not steps: their output is the task's attachment, already there.
  for (const src of [...SOURCE_TOOLS, ...liveSources]) reach.delete(src);
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
      ...(liveSources.some((src) => has(src, agent))
        ? { inputs: liveSources.filter((src) => has(src, agent)) }
        : {}),
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
/** Every card has this fixed height (CSS .ws-node), so the layout never overlaps. */
export const NODE_H = 150;
export const GAP_X = 90;
export const GAP_Y = 40;
/** Unlinked agents (tools, drafts, planned) are laid out in rows of this many under the flow. */
const SPARE_PER_ROW = 6;

/**
 * Layered layout, left to right, without overlaps: Бриф → CEO → workers → Critic → SEO → Вы.
 * Column = longest path (sources without inputs start next to Бриф); "Вы" is always last.
 * Agents without links go to separate rows below the flow.
 */
export function autoLayout(
  nodes: Pick<GraphNode, 'id'>[],
  links: Pick<GraphLink, 'from' | 'to'>[],
): Record<string, { x: number; y: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const live = links.filter((l) => ids.has(l.from) && ids.has(l.to));
  const linked = new Set(live.flatMap((l) => [l.from, l.to]));
  linked.add(BRIEF);
  linked.add(OWNER);
  const level = new Map<string, number>();
  for (const id of linked)
    if (id === BRIEF) level.set(id, 0);
    else if (!live.some((l) => l.to === id)) level.set(id, 1);
  // Longest path; the graph is a DAG (validateLink refuses cycles), so |nodes| passes suffice.
  for (let i = 0; i < nodes.length; i++)
    for (const l of live) {
      const f = level.get(l.from);
      if (f !== undefined && (level.get(l.to) ?? -1) < f + 1) level.set(l.to, f + 1);
    }
  const maxLevel = Math.max(
    1,
    ...[...level.entries()].filter(([k]) => k !== OWNER).map(([, v]) => v),
  );
  level.set(OWNER, maxLevel + 1);
  const columns = new Map<number, string[]>();
  for (const n of nodes) {
    if (!linked.has(n.id)) continue;
    const l = level.get(n.id) ?? 1;
    columns.set(l, [...(columns.get(l) ?? []), n.id]);
  }
  const out: Record<string, { x: number; y: number }> = {};
  const stepX = NODE_W + GAP_X;
  const stepY = NODE_H + GAP_Y;
  const tallest = Math.max(1, ...[...columns.values()].map((c) => c.length));
  for (const [l, col] of columns) {
    const offset = ((tallest - col.length) * stepY) / 2;
    col.forEach((id, i) => {
      out[id] = { x: l * stepX, y: Math.round(offset + i * stepY) };
    });
  }
  const spare = nodes.filter((n) => !linked.has(n.id)).map((n) => n.id);
  const top = tallest * stepY + GAP_Y;
  spare.forEach((id, i) => {
    out[id] = {
      x: (1 + (i % SPARE_PER_ROW)) * stepX,
      y: top + Math.floor(i / SPARE_PER_ROW) * stepY,
    };
  });
  return out;
}

/** Top of the spare rows: one row below the lowest card that takes part in a link. */
export function spareTop(
  positions: Record<string, { x: number; y: number }>,
  links: Pick<GraphLink, 'from' | 'to'>[],
): number {
  const linked = new Set(links.flatMap((l) => [l.from, l.to]));
  const ys = Object.entries(positions)
    .filter(([id]) => linked.has(id))
    .map(([, p]) => p.y);
  return ys.length ? Math.max(...ys) + NODE_H + GAP_Y * 2 : 0;
}

/** Do two cards placed at these positions overlap (with a small margin)? */
export const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }, margin = 10) =>
  Math.abs(a.x - b.x) < NODE_W + margin && Math.abs(a.y - b.y) < NODE_H + margin;

/** A free spot for a new card: the first cell of the spare rows that nothing covers. */
export function freeSpot(
  taken: { x: number; y: number }[],
  /** Spare rows start here (below the linked flow), so a new card never lands inside it. */
  startY = 0,
): { x: number; y: number } {
  const stepX = NODE_W + GAP_X;
  const stepY = NODE_H + GAP_Y;
  const bottom = taken.length ? Math.max(...taken.map((p) => p.y)) : 0;
  for (let row = 0; row < 50; row++)
    for (let col = 1; col <= SPARE_PER_ROW; col++) {
      const p = { x: col * stepX, y: startY + row * stepY };
      if (!taken.some((t) => overlaps(t, p))) return p;
    }
  return { x: stepX, y: bottom + stepY };
}

/**
 * The agent graph on the workspace board. A link A -> B means: A's result goes to B's input
 * and B runs after A. Pure functions only (validation, execution order, layout), shared by
 * the workflow, the panel API and tests.
 *
 * There are no built-in agents: every agent is the owner's record with a team role. The
 * engine finds agents by role (planner, reviewer, acceptor) and by links, never by id.
 */

export const BRIEF = 'brief';
export const OWNER = 'me';

/** human: «Бриф» and «Вы» (entry and exit, not agents); custom: every agent. */
export type NodeKind = 'human' | 'custom';
export type NodeStatus = 'active' | 'draft';

/** What the engine uses an agent for. One role per agent. */
export const TEAM_ROLES = ['planner', 'reviewer', 'worker', 'acceptor'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const TEAM_ROLE_LABEL: Record<TeamRole, string> = {
  planner: 'Планировщик',
  reviewer: 'Проверяющий',
  worker: 'Исполнитель',
  acceptor: 'Приёмка',
};

export interface GraphNode {
  id: string;
  name: string;
  kind: NodeKind;
  status: NodeStatus;
  teamRole?: TeamRole | null;
  /** Code behaviour of the agent (copywriting, stt_voice, ...); null: an LLM agent by fields. */
  capability?: string | null;
}

export interface GraphLink {
  from: string;
  to: string;
}

/**
 * Capabilities that start from a file, not from the brief: links of such an agent bring the
 * task's transcript to the linked agents.
 */
export const SOURCE_CAPABILITIES = ['stt_voice', 'video_transcribe'] as const;
/** Capabilities that are never linked: they run from their own page after a human decision. */
export const UNLINKABLE_CAPABILITIES = ['mailer_send'] as const;
/** Capabilities without an LLM (code tools): no prompt, no output fields. */
export const TOOL_CAPABILITIES = [
  'stt_voice',
  'video_transcribe',
  'kp_render',
  'mailer_send',
] as const;

const isSource = (n: GraphNode | undefined) =>
  !!n?.capability && (SOURCE_CAPABILITIES as readonly string[]).includes(n.capability);
const isUnlinkable = (n: GraphNode | undefined) =>
  !!n?.capability && (UNLINKABLE_CAPABILITIES as readonly string[]).includes(n.capability);
const isAgent = (n: GraphNode | undefined): n is GraphNode => !!n && n.kind !== 'human';

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
  if (from === BRIEF && b.teamRole !== 'planner')
    return '«Бриф» передаётся только планировщику (агенту с ролью «Планировщик»): сначала нужен план';
  if (b.teamRole === 'planner' && from !== BRIEF) return 'Планировщик получает только бриф';
  if (isUnlinkable(a) || isUnlinkable(b))
    return 'Отправка писем не связывается с агентами: она запускается со страницы «Рассылка» после вашего подтверждения';
  if (isSource(b))
    return 'Расшифровка начинается с файла (голосовое или видео), в неё связи не входят';
  if (links.some((l) => l.from === from && l.to === to)) return 'Такая связь уже есть';
  if (hasPath(links, to, from)) return 'Получится цикл: агенты будут ждать друг друга бесконечно';
  return null;
}

export interface PipelineStep {
  agent: string;
  name: string;
  /** Steps whose results this step receives and waits for. */
  after: string[];
  /** The step's result is checked by a reviewer (link step -> reviewer) before going further. */
  reviewed: boolean;
  /** Which reviewer checks it (plans made before stage 7 have only `reviewed`). */
  reviewer?: string | null;
  /** Source agents linked to this step (voice/video -> text): it gets their transcripts. */
  inputs?: string[];
  /** The agent's capability when the plan was made (plans before stage 7 do not have it). */
  capability?: string | null;
}

/** Snapshot stored in the plan: what will run, in which order, and what is switched off. */
export interface Pipeline {
  /** 2: stage 7 (roles); absent: older plans. */
  version?: number;
  /** The planner that made the plan. */
  planner?: string;
  steps: PipelineStep[];
  /** Linked but not running yet (draft agent), with the reason. */
  inactive: { agent: string; name: string; reason: string }[];
  links: { from: string; to: string }[];
  /** Source agents (voice/video -> text) by capability. */
  sources?: { agent: string; capability: string }[];
  /** Things the owner should decide (e.g. two reviewers on one step): shown with the plan. */
  warnings?: string[];
}

/** Which planner takes a new task: the one linked from «Бриф», or the only active one. */
export function choosePlanner(
  nodes: GraphNode[],
  links: Pick<GraphLink, 'from' | 'to'>[],
): { id: string; problem?: undefined } | { id?: undefined; problem: string } {
  const planners = nodes.filter((n) => isAgent(n) && n.teamRole === 'planner');
  const active = planners.filter((n) => n.status === 'active');
  const names = (xs: GraphNode[]) => xs.map((n) => `«${n.name}»`).join(', ');
  const linked = active.filter((n) => links.some((l) => l.from === BRIEF && l.to === n.id));
  if (linked.length === 1) return { id: linked[0]!.id };
  if (linked.length > 1)
    return {
      problem: `С «Бриф» связаны несколько планировщиков (${names(linked)}). Оставьте одну связь: кто планирует, решаете вы.`,
    };
  if (active.length === 1) return { id: active[0]!.id };
  if (active.length > 1)
    return {
      problem: `Планировщиков несколько (${names(active)}). Свяжите «Бриф» с тем, кто должен планировать.`,
    };
  if (planners.length)
    return {
      problem: `Планировщик ${names(planners)} не включён: проверьте его тестом и включите.`,
    };
  return {
    problem:
      'Нет планировщика: создайте агента с ролью «Планировщик» или добавьте его из библиотеки.',
  };
}

/**
 * Execution order for one task. Work steps are the active agents reachable from the planner;
 * a reviewer is not a step: "A -> Reviewer -> B" means B gets A's result after review. An
 * inactive node blocks the path through it (its links start working once it is active).
 */
export function buildPipeline(
  nodes: GraphNode[],
  links: GraphLink[],
  /** Capabilities of the task's attachments (voice/video): their source agents' links work. */
  sourceCapabilities: readonly string[] = [],
  plannerId?: string,
): Pipeline {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const active = (id: string) => {
    const n = byId.get(id);
    return isAgent(n) && n.status === 'active';
  };
  const planner = plannerId ?? choosePlanner(nodes, links).id;
  const warnings: string[] = [];
  const liveSources = nodes.filter(
    (n) => active(n.id) && isSource(n) && sourceCapabilities.includes(n.capability!),
  );
  const reviewers = new Set(
    nodes.filter((n) => active(n.id) && n.teamRole === 'reviewer').map((n) => n.id),
  );
  const reach = new Set<string>();
  const stack = [...(planner ? [planner] : []), ...liveSources.map((n) => n.id)];
  while (stack.length) {
    const n = stack.pop()!;
    for (const l of links) {
      if (l.from !== n || reach.has(l.to) || !active(l.to)) continue;
      reach.add(l.to);
      stack.push(l.to);
    }
  }
  if (planner) reach.delete(planner);
  for (const r of reviewers) reach.delete(r);
  // Source agents are not steps: their output is the task's attachment, already there.
  for (const n of nodes) if (isSource(n)) reach.delete(n.id);
  const work = nodes.filter((n) => reach.has(n.id)).map((n) => n.id);
  const has = (f: string, t: string) => links.some((l) => l.from === f && l.to === t);
  const reviewerOf = new Map<string, string | null>();
  for (const w of work) {
    const rs = [...reviewers].filter((r) => has(w, r));
    if (rs.length > 1)
      warnings.push(
        `У шага «${byId.get(w)!.name}» несколько проверяющих (${rs.map((r) => `«${byId.get(r)!.name}»`).join(', ')}): шаг пойдёт без проверки, пока вы не оставите одну связь.`,
      );
    reviewerOf.set(w, rs.length === 1 ? rs[0]! : null);
  }
  const deps = new Map(
    work.map((b) => [
      b,
      work.filter(
        (a) => a !== b && (has(a, b) || [...reviewers].some((r) => has(a, r) && has(r, b))),
      ),
    ]),
  );
  // Topological order, stable by board order.
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
        isAgent(n) && n.status !== 'active' && links.some((l) => l.from === n.id || l.to === n.id),
    )
    .map((n) => ({ agent: n.id, name: n.name, reason: 'агент в черновике' }));
  return {
    version: 2,
    ...(planner ? { planner } : {}),
    steps: order.map((agent) => {
      const reviewer = reviewerOf.get(agent) ?? null;
      const inputs = liveSources.filter((src) => has(src.id, agent)).map((src) => src.id);
      return {
        agent,
        name: byId.get(agent)!.name,
        after: deps.get(agent)!,
        reviewed: reviewer !== null,
        reviewer,
        capability: byId.get(agent)!.capability ?? null,
        ...(inputs.length ? { inputs } : {}),
      };
    }),
    inactive,
    links: links.map((l) => ({ from: l.from, to: l.to })),
    sources: liveSources.map((n) => ({ agent: n.id, capability: n.capability! })),
    warnings,
  };
}

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
export const NODE_H = 164;
export const GAP_X = 90;
export const GAP_Y = 40;
/** Unlinked cards are laid out in rows of this many under the flow. */
const SPARE_PER_ROW = 6;

/**
 * Layered layout, left to right, without overlaps: Бриф → CEO → workers → Critic → SEO → Вы.
 * Column = longest path (sources without inputs start next to Бриф); "Вы" is always last.
 * Cards without links go below the flow, each group from a new row: agents, then tool agents,
 * then drafts.
 */
export function autoLayout(
  nodes: (Pick<GraphNode, 'id'> & Partial<Pick<GraphNode, 'kind' | 'status' | 'capability'>>)[],
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
  const spare = nodes.filter((n) => !linked.has(n.id));
  const tool = (n: (typeof spare)[number]) =>
    !!n.capability && (TOOL_CAPABILITIES as readonly string[]).includes(n.capability);
  const groups = [
    spare.filter((n) => !tool(n) && n.status !== 'draft'),
    spare.filter((n) => tool(n)),
    spare.filter((n) => !tool(n) && n.status === 'draft'),
  ];
  let row = 0;
  const top = tallest * stepY + GAP_Y;
  for (const g of groups) {
    g.forEach((n, i) => {
      out[n.id] = {
        x: (1 + (i % SPARE_PER_ROW)) * stepX,
        y: top + (row + Math.floor(i / SPARE_PER_ROW)) * stepY,
      };
    });
    row += Math.ceil(g.length / SPARE_PER_ROW);
  }
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

/** The free spot closest to where a card was dropped (spiral over the card grid around it). */
export function nearestFree(
  taken: { x: number; y: number }[],
  p: { x: number; y: number },
): { x: number; y: number } {
  if (!taken.some((t) => overlaps(t, p))) return p;
  const dx = NODE_W + GAP_X;
  const dy = NODE_H + GAP_Y;
  for (let r = 1; r < 30; r++)
    for (let i = -r; i <= r; i++)
      for (const [x, y] of [
        [i, -r],
        [i, r],
        [-r, i],
        [r, i],
      ] as const) {
        const q = { x: Math.max(0, p.x + x * dx), y: Math.max(0, p.y + y * dy) };
        if (!taken.some((t) => overlaps(t, q))) return q;
      }
  return freeSpot(taken);
}

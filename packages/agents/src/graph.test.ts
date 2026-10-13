import { describe, expect, it } from 'vitest';
import {
  autoLayout,
  buildPipeline,
  choosePlanner,
  freeSpot,
  linkActive,
  overlaps,
  validateLink,
  type GraphLink,
  type GraphNode,
  type TeamRole,
} from './graph.js';

// Fixture agents (the engine knows roles, not ids): p = planner, w = writer, r = reviewer.
const node = (
  id: string,
  teamRole: TeamRole | null = 'worker',
  status: GraphNode['status'] = 'active',
  capability: string | null = null,
): GraphNode => ({
  id,
  name: id,
  kind: teamRole === null ? 'human' : 'custom',
  status,
  teamRole,
  capability,
});
const NODES: GraphNode[] = [
  node('brief', null),
  node('p', 'planner'),
  node('w', 'worker', 'active', 'copywriting'),
  node('r', 'reviewer'),
  node('seo', 'acceptor'),
  node('image', 'worker', 'draft', 'image_generate'),
  node('reels'),
  node('stt', 'worker', 'active', 'stt_voice'),
  node('mail', 'worker', 'active', 'mailer_send'),
  node('me', null),
];
const link = (from: string, to: string): GraphLink => ({ from, to });
const team = (): GraphLink[] => [
  link('brief', 'p'),
  link('p', 'w'),
  link('w', 'r'),
  link('r', 'me'),
];

describe('link validation', () => {
  it('rejects self, into Бриф, out of Вы, brief to a non-planner, into a planner, duplicates and cycles', () => {
    const links = [...team(), link('w', 'seo')];
    expect(validateLink(NODES, links, 'seo', 'seo')).toMatch(/самим собой/);
    expect(validateLink(NODES, links, 'p', 'brief')).toMatch(/Бриф/);
    expect(validateLink(NODES, links, 'me', 'seo')).toMatch(/последний шаг/);
    expect(validateLink(NODES, links, 'brief', 'w')).toMatch(/только планировщику/);
    expect(validateLink(NODES, links, 'seo', 'p')).toMatch(/Планировщик получает только бриф/);
    expect(validateLink(NODES, links, 'w', 'seo')).toMatch(/уже есть/);
    expect(validateLink(NODES, links, 'seo', 'w')).toMatch(/цикл/);
    expect(validateLink(NODES, links, 'nobody', 'seo')).toMatch(/нет/);
    expect(validateLink(NODES, links, 'w', 'stt')).toMatch(/начинается с файла/);
    expect(validateLink(NODES, links, 'mail', 'r')).toMatch(/Рассылка/);
  });

  it('allows normal links, to drafts and to the owner; every link is equal (no system links)', () => {
    expect(validateLink(NODES, team(), 'w', 'seo')).toBeNull();
    expect(validateLink(NODES, team(), 'p', 'image')).toBeNull();
    expect(validateLink(NODES, team(), 'seo', 'me')).toBeNull();
    expect(validateLink(NODES, team(), 'stt', 'reels')).toBeNull();
  });
});

describe('planner by role', () => {
  it('the one linked from «Бриф», or the only active one; otherwise the owner decides', () => {
    expect(choosePlanner(NODES, team())).toEqual({ id: 'p' });
    expect(choosePlanner(NODES, [])).toEqual({ id: 'p' });
    const two = [...NODES, node('p2', 'planner')];
    expect(choosePlanner(two, [])).toMatchObject({ problem: expect.stringMatching(/несколько/) });
    expect(choosePlanner(two, [link('brief', 'p2')])).toEqual({ id: 'p2' });
    expect(choosePlanner(two, [link('brief', 'p'), link('brief', 'p2')])).toMatchObject({
      problem: expect.stringMatching(/Оставьте одну связь/),
    });
    const none = NODES.filter((n) => n.teamRole !== 'planner');
    expect(choosePlanner(none, [])).toMatchObject({
      problem: expect.stringMatching(/^Нет планировщика: создайте агента с ролью «Планировщик»/),
    });
    const draft = NODES.map((n) => (n.id === 'p' ? { ...n, status: 'draft' as const } : n));
    expect(choosePlanner(draft, [])).toMatchObject({
      problem: expect.stringMatching(/не включён/),
    });
  });
});

describe('pipeline from links', () => {
  it('a writer reviewed by the reviewer it is linked to', () => {
    const p = buildPipeline(NODES, team());
    expect(p.planner).toBe('p');
    expect(p.steps).toEqual([
      {
        agent: 'w',
        name: 'w',
        after: [],
        reviewed: true,
        reviewer: 'r',
        capability: 'copywriting',
      },
    ]);
  });

  it('no reviewer on the board: the step goes without review (visible in the plan)', () => {
    const p = buildPipeline(
      NODES.filter((n) => n.id !== 'r'),
      [link('brief', 'p'), link('p', 'w'), link('w', 'me')],
    );
    expect(p.steps[0]).toMatchObject({ agent: 'w', reviewed: false, reviewer: null });
  });

  it('two reviewers on one step: no guess — a warning for the owner', () => {
    const nodes = [...NODES, node('r2', 'reviewer')];
    const p = buildPipeline(nodes, [...team(), link('w', 'r2')]);
    expect(p.steps[0]).toMatchObject({ reviewer: null, reviewed: false });
    expect(p.warnings![0]).toMatch(/несколько проверяющих/);
  });

  it('a reviewer is a pass-through: w -> r -> seo means seo waits for w', () => {
    const p = buildPipeline(NODES, [...team(), link('r', 'seo'), link('seo', 'me')]);
    expect(p.steps.map((s) => [s.agent, s.after])).toEqual([
      ['w', []],
      ['seo', ['w']],
    ]);
  });

  it('parallel executors and a join', () => {
    const p = buildPipeline(NODES, [
      ...team(),
      link('p', 'reels'),
      link('reels', 'seo'),
      link('w', 'seo'),
    ]);
    expect(p.steps.map((s) => s.agent)).toEqual(['w', 'reels', 'seo']);
    expect(p.steps.find((s) => s.agent === 'seo')!.after).toEqual(['w', 'reels']);
    expect(p.steps.find((s) => s.agent === 'reels')!.reviewed).toBe(false);
  });

  it('a draft agent blocks the path and is listed as inactive; works once active', () => {
    const links = [...team(), link('p', 'image'), link('image', 'seo')];
    const p = buildPipeline(NODES, links);
    expect(p.steps.map((s) => s.agent)).toEqual(['w']);
    expect(p.inactive).toEqual([{ agent: 'image', name: 'image', reason: 'агент в черновике' }]);
    expect(linkActive(NODES, { from: 'p', to: 'image' })).toBe(false);
    const nowActive = NODES.map((n) =>
      n.id === 'image' ? { ...n, status: 'active' as const } : n,
    );
    expect(buildPipeline(nowActive, links).steps.map((s) => s.agent)).toEqual([
      'w',
      'image',
      'seo',
    ]);
  });

  it('agents not reachable from the planner do not run; no planner — no steps', () => {
    expect(
      buildPipeline(NODES, [...team(), link('reels', 'seo')]).steps.map((s) => s.agent),
    ).toEqual(['w']);
    expect(
      buildPipeline(
        NODES.filter((n) => n.teamRole !== 'planner'),
        team(),
      ).steps,
    ).toEqual([]);
  });

  it('a source agent (voice -> text) feeds the agents it is linked to when the task has a file', () => {
    const p = buildPipeline(NODES, [...team(), link('stt', 'reels')], ['stt_voice']);
    expect(p.steps.find((s) => s.agent === 'reels')).toMatchObject({ inputs: ['stt'] });
    expect(p.sources).toEqual([{ agent: 'stt', capability: 'stt_voice' }]);
  });
});

describe('auto layout', () => {
  it('puts nodes in columns by distance from the brief, owner last', () => {
    const pos = autoLayout(NODES, [...team(), link('r', 'seo')]);
    expect(pos.brief!.x).toBe(0);
    expect(pos.p!.x).toBeGreaterThan(pos.brief!.x);
    expect(pos.seo!.x).toBeGreaterThan(pos.r!.x);
    expect(pos.me!.x).toBeGreaterThan(pos.seo!.x);
    expect(Object.keys(pos).sort()).toEqual(NODES.map((n) => n.id).sort());
  });

  it('never overlaps: 16 cards, links and unlinked tools, plus free spots for new agents', () => {
    const many = [
      ...NODES,
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `extra${i}`,
        name: `Extra ${i}`,
        kind: 'custom' as const,
        status: 'active' as const,
        capability: 'kp_render',
      })),
    ];
    expect(many.length).toBeGreaterThanOrEqual(12);
    const pos = autoLayout(many, [...team(), link('r', 'seo'), link('w', 'extra0')]);
    const all = Object.values(pos);
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i]!, all[j]!, 0)).toBe(false);
    const spot = freeSpot(all);
    expect(all.some((p) => overlaps(p, spot, 0))).toBe(false);
  });

  it('unlinked cards: agents, then tool agents, then drafts — each group from a new row', () => {
    const nodes = [
      ...NODES,
      { id: 'agent1', name: 'A', kind: 'custom' as const, status: 'active' as const },
      {
        id: 'tool1',
        name: 'T',
        kind: 'custom' as const,
        status: 'active' as const,
        capability: 'kp_render',
      },
      { id: 'draft1', name: 'D', kind: 'custom' as const, status: 'draft' as const },
    ];
    const pos = autoLayout(nodes, team());
    const flowBottom = Math.max(pos.p!.y, pos.w!.y, pos.me!.y);
    expect(pos.agent1!.y).toBeGreaterThan(flowBottom);
    expect(pos.tool1!.y).toBeGreaterThan(pos.agent1!.y);
    expect(pos.draft1!.y).toBeGreaterThan(pos.tool1!.y);
  });
});

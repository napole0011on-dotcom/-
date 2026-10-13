import { describe, expect, it } from 'vitest';
import {
  SYSTEM_LINKS,
  autoLayout,
  freeSpot,
  overlaps,
  buildPipeline,
  deleteLinkProblem,
  linkActive,
  validateLink,
  type GraphLink,
  type GraphNode,
} from './graph.js';

const node = (
  id: string,
  kind: GraphNode['kind'] = 'code',
  status: GraphNode['status'] = 'active',
): GraphNode => ({
  id,
  name: id,
  kind,
  status,
});
const NODES: GraphNode[] = [
  node('brief', 'human'),
  node('ceo'),
  node('copywriter'),
  node('critic'),
  node('seo', 'constructor'),
  node('image', 'code', 'planned'),
  node('reels', 'code'),
  node('me', 'human'),
];
const sys = (): GraphLink[] => SYSTEM_LINKS.map(([from, to]) => ({ from, to, kind: 'system' }));
const user = (from: string, to: string): GraphLink => ({ from, to, kind: 'user' });

describe('link validation', () => {
  it('rejects self, into Бриф, out of Вы, brief bypassing CEO, into CEO, duplicates and cycles', () => {
    const links = [...sys(), user('copywriter', 'seo')];
    expect(validateLink(NODES, links, 'seo', 'seo')).toMatch(/самим собой/);
    expect(validateLink(NODES, links, 'ceo', 'brief')).toMatch(/Бриф/);
    expect(validateLink(NODES, links, 'me', 'seo')).toMatch(/последний шаг/);
    expect(validateLink(NODES, links, 'brief', 'copywriter')).toMatch(/только CEO/);
    expect(validateLink(NODES, links, 'seo', 'ceo')).toMatch(/CEO получает только бриф/);
    expect(validateLink(NODES, links, 'copywriter', 'seo')).toMatch(/уже есть/);
    expect(validateLink(NODES, links, 'seo', 'copywriter')).toMatch(/цикл/);
    expect(validateLink(NODES, links, 'nobody', 'seo')).toMatch(/нет/);
  });

  it('allows normal links, including to planned agents and to the owner', () => {
    expect(validateLink(NODES, sys(), 'copywriter', 'seo')).toBeNull();
    expect(validateLink(NODES, sys(), 'ceo', 'image')).toBeNull();
    expect(validateLink(NODES, sys(), 'seo', 'me')).toBeNull();
  });

  it('system links cannot be deleted, user links can', () => {
    expect(deleteLinkProblem({ from: 'ceo', to: 'copywriter', kind: 'system' })).toMatch(/нельзя/);
    expect(deleteLinkProblem({ from: 'copywriter', to: 'seo', kind: 'user' })).toBeNull();
  });
});

describe('pipeline from links', () => {
  it('default board: copywriter reviewed by critic', () => {
    const p = buildPipeline(NODES, sys());
    expect(p.steps).toEqual([
      { agent: 'copywriter', name: 'copywriter', after: [], reviewed: true },
    ]);
  });

  it('critic is a pass-through reviewer: copywriter -> critic -> seo means seo waits for copywriter', () => {
    const p = buildPipeline(NODES, [...sys(), user('critic', 'seo'), user('seo', 'me')]);
    expect(p.steps.map((s) => [s.agent, s.after])).toEqual([
      ['copywriter', []],
      ['seo', ['copywriter']],
    ]);
  });

  it('parallel executors and a join', () => {
    const p = buildPipeline(NODES, [
      ...sys(),
      user('ceo', 'reels'),
      user('reels', 'seo'),
      user('copywriter', 'seo'),
    ]);
    expect(p.steps.map((s) => s.agent)).toEqual(['copywriter', 'reels', 'seo']);
    expect(p.steps.find((s) => s.agent === 'seo')!.after).toEqual(['copywriter', 'reels']);
    expect(p.steps.find((s) => s.agent === 'reels')!.reviewed).toBe(false);
  });

  it('planned agent blocks the path and is listed as inactive; works once active', () => {
    const links = [...sys(), user('ceo', 'image'), user('image', 'seo')];
    const p = buildPipeline(NODES, links);
    expect(p.steps.map((s) => s.agent)).toEqual(['copywriter']);
    expect(p.inactive).toEqual([{ agent: 'image', name: 'image', reason: 'агент ещё не создан' }]);
    expect(linkActive(NODES, { from: 'ceo', to: 'image' })).toBe(false);
    const nowActive = NODES.map((n) =>
      n.id === 'image' ? { ...n, status: 'active' as const } : n,
    );
    expect(buildPipeline(nowActive, links).steps.map((s) => s.agent)).toEqual([
      'copywriter',
      'image',
      'seo',
    ]);
  });

  it('agents not reachable from CEO do not run', () => {
    expect(
      buildPipeline(NODES, [...sys(), user('reels', 'seo')]).steps.map((s) => s.agent),
    ).toEqual(['copywriter']);
  });
});

describe('auto layout', () => {
  it('puts nodes in columns by distance from the brief, owner last', () => {
    const pos = autoLayout(NODES, [...sys(), user('critic', 'seo')]);
    expect(pos.brief!.x).toBe(0);
    expect(pos.ceo!.x).toBeGreaterThan(pos.brief!.x);
    expect(pos.seo!.x).toBeGreaterThan(pos.critic!.x);
    expect(pos.me!.x).toBeGreaterThan(pos.seo!.x);
    expect(Object.keys(pos).sort()).toEqual(NODES.map((n) => n.id).sort());
  });

  it('never overlaps: 16 cards, links and unlinked tools, plus free spots for new agents', () => {
    const many = [
      ...NODES,
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `extra${i}`,
        name: `Extra ${i}`,
        kind: 'tool' as const,
        status: 'active' as const,
      })),
    ];
    expect(many.length).toBeGreaterThanOrEqual(12);
    const pos = autoLayout(many, [...sys(), user('critic', 'seo'), user('copywriter', 'extra0')]);
    const all = Object.values(pos);
    for (let i = 0; i < all.length; i++)
      for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i]!, all[j]!, 0)).toBe(false);
    const spot = freeSpot(all);
    expect(all.some((p) => overlaps(p, spot, 0))).toBe(false);
  });

  it('unlinked cards: agents, then tools, then planned agents — each group from a new row', () => {
    const nodes = [
      ...NODES,
      { id: 'draft1', name: 'D', kind: 'constructor' as const, status: 'draft' as const },
      { id: 'tool1', name: 'T', kind: 'tool' as const, status: 'active' as const },
      { id: 'plan1', name: 'P', kind: 'constructor' as const, status: 'planned' as const },
    ];
    const pos = autoLayout(nodes, sys());
    const flowBottom = Math.max(pos.ceo!.y, pos.copywriter!.y, pos.me!.y);
    expect(pos.draft1!.y).toBeGreaterThan(flowBottom);
    expect(pos.tool1!.y).toBeGreaterThan(pos.draft1!.y);
    expect(pos.plan1!.y).toBeGreaterThan(pos.tool1!.y);
  });
});

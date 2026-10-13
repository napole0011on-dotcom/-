import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../api';
import { handoffEdges, replayFrames } from './replay';

const links = [
  { from: 'ceo', to: 'copywriter' },
  { from: 'copywriter', to: 'critic' },
  { from: 'critic', to: 'seo' },
  { from: 'critic', to: 'me' },
  { from: 'seo', to: 'me' },
];
let id = 0;
const ev = (agent: string, type: string, payload: RunEvent['payload'] = null): RunEvent => ({
  id: ++id,
  at: '2026-10-13T10:00:00Z',
  agent,
  type,
  text: `${agent} ${type}`,
  costUsd: null,
  payload,
});

describe('replay', () => {
  it('a hand-off travels directly or through the Critic', () => {
    expect(handoffEdges(links, 'seo', 'me')).toEqual(['seo>me']);
    expect(handoffEdges(links, 'copywriter', 'seo')).toEqual(['copywriter>critic', 'critic>seo']);
    expect(handoffEdges(links, 'ceo', 'seo')).toEqual([]);
  });

  it('builds a frame per event: who works, which edges flow, decision labels so far', () => {
    const frames = replayFrames(
      [
        ev('copywriter', 'start'),
        ev('copywriter', 'done'),
        ev('copywriter', 'handoff', {
          to: ['seo'],
          mode: 'router',
          reasons: { seo: 'нужны ключевые слова' },
          confidence: 0.8,
        }),
        ev('seo', 'start'),
      ],
      links,
    );
    expect(frames).toHaveLength(4);
    expect(frames[0]!.states).toEqual({ copywriter: 'work' });
    expect(frames[2]!.flows).toEqual(['copywriter>critic', 'critic>seo']);
    expect(frames[2]!.labels).toEqual({ 'critic>seo': 'диспетчер: нужны ключевые слова · 80%' });
    // The label stays, the flow does not.
    expect(frames[3]!.flows).toEqual([]);
    expect(frames[3]!.labels!['critic>seo']).toMatch(/^диспетчер/);
    expect(frames[3]!.states).toEqual({ copywriter: 'done', seo: 'work' });
  });
});

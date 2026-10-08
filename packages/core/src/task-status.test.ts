import { describe, expect, it } from 'vitest';
import {
  TASK_STATUSES,
  allowedTransitions,
  checkTransition,
  isTerminal,
  type Actor,
} from './task-status.js';

const human: Actor = { kind: 'human', id: 'u1' };
const agent: Actor = { kind: 'agent', id: 'ceo' };
const system: Actor = { kind: 'system', id: 'scheduler' };

describe('task status machine', () => {
  it('follows the happy path from draft to exported', () => {
    const path = [
      ['draft', 'planned', agent],
      ['planned', 'awaiting_plan_approval', agent],
      ['awaiting_plan_approval', 'in_progress', human],
      ['in_progress', 'in_review', agent],
      ['in_review', 'revision', agent],
      ['revision', 'in_review', agent],
      ['in_review', 'awaiting_final_approval', agent],
      ['awaiting_final_approval', 'approved', human],
      ['approved', 'exported', system],
    ] as const;
    for (const [from, to, actor] of path)
      expect(checkTransition(from, to, actor), `${from}->${to}`).toBeNull();
  });

  it('rejects transitions not in the table', () => {
    expect(checkTransition('draft', 'approved', human)).toMatch(/not in the allowed list/);
    expect(checkTransition('in_progress', 'published', human)).toMatch(/not in the allowed list/);
    expect(checkTransition('planned', 'in_progress', human)).toMatch(/not in the allowed list/);
  });

  it('gate decisions require a human: nothing is approved by agents or timeouts', () => {
    for (const actor of [agent, system]) {
      expect(checkTransition('awaiting_plan_approval', 'in_progress', actor)).toMatch(
        /requires a human/,
      );
      expect(checkTransition('awaiting_final_approval', 'approved', actor)).toMatch(
        /requires a human/,
      );
      expect(checkTransition('approved', 'published', actor)).toMatch(/requires a human/);
    }
  });

  it('agents/system may still cancel or fail outside the gates', () => {
    expect(checkTransition('in_progress', 'failed', system)).toBeNull();
    expect(checkTransition('awaiting_plan_approval', 'cancelled', system)).toBeNull();
  });

  it('terminal statuses have no exits; every target is a known status', () => {
    expect(isTerminal('published')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('failed')).toBe(false);
    for (const s of TASK_STATUSES) {
      for (const t of allowedTransitions(s)) expect(TASK_STATUSES).toContain(t);
    }
  });

  it('every non-terminal status can be cancelled or failed (no dead ends)', () => {
    for (const s of TASK_STATUSES) {
      if (isTerminal(s)) continue;
      const exits = allowedTransitions(s);
      expect(
        exits.some((t) => t === 'cancelled' || t === 'failed' || t === 'published'),
        s,
      ).toBe(true);
    }
  });
});

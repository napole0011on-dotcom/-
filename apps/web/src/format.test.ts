import { describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, STATUS_LABEL, actorLabel, ago, percent, usd } from './format';
import { matchRoute } from './router';

describe('panel formatting', () => {
  it('formats money with sub-cent precision', () => {
    expect(usd(0)).toBe('$0');
    expect(usd(0.0367)).toBe('$0.04');
    expect(usd(0.00412)).toBe('$0.0041');
    expect(usd(5)).toBe('$5.00');
  });

  it('formats relative time', () => {
    const now = Date.parse('2026-10-09T12:00:00Z');
    expect(ago('2026-10-09T11:59:50Z', now)).toBe('только что');
    expect(ago('2026-10-09T11:55:00Z', now)).toBe('5 мин назад');
    expect(ago('2026-10-09T09:00:00Z', now)).toBe('3 ч назад');
    expect(ago(null, now)).toBe('—');
  });

  it('puts every task status on exactly one board column', () => {
    const all = BOARD_COLUMNS.flatMap((c) => c.statuses);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(Object.keys(STATUS_LABEL).sort());
  });

  it('labels actors and percentages', () => {
    expect(actorLabel('human:panel:owner')).toBe('вы (панель)');
    expect(actorLabel('human:tg:42')).toBe('вы (Telegram)');
    expect(actorLabel('tg:42')).toBe('вы (Telegram)');
    expect(percent(null)).toBe('—');
    expect(percent(0.875)).toBe('88%');
  });
});

describe('router', () => {
  it('matches params and rejects other paths', () => {
    expect(matchRoute('/tasks/:id', '/tasks/abc')).toEqual({ id: 'abc' });
    expect(matchRoute('/tasks/:id', '/tasks')).toBeNull();
    expect(matchRoute('/tasks/new', '/tasks/abc')).toBeNull();
    expect(matchRoute('/', '/')).toEqual({});
  });
});

import { describe, expect, it } from 'vitest';
import { collapseDiff, diffStats, lineDiff } from './diff';

describe('lineDiff', () => {
  it('marks added, removed and unchanged lines in order', () => {
    const d = lineDiff('a\nb\nc', 'a\nc\nd');
    expect(d).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ]);
    expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
  });

  it('handles identical and empty texts', () => {
    expect(diffStats(lineDiff('x\ny', 'x\ny'))).toEqual({ added: 0, removed: 0 });
    expect(lineDiff('', 'new')).toEqual([
      { kind: 'del', text: '' },
      { kind: 'add', text: 'new' },
    ]);
  });
});

describe('collapseDiff', () => {
  it('folds long unchanged runs, keeps context around changes', () => {
    const before = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
    const after = ['1', '2', '3', '4', '5', '6', '7', 'X'].join('\n');
    expect(collapseDiff(lineDiff(before, after), 1)).toEqual([
      { kind: 'skip', count: 6 },
      { kind: 'same', text: '7' },
      { kind: 'del', text: '8' },
      { kind: 'add', text: 'X' },
    ]);
  });
});

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/**
 * Line diff (longest common subsequence). Prompts are at most 32 KB, a few hundred lines,
 * so the O(n·m) table is fine and a dependency is not needed.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: 'del', text: a[i++]! });
    else out.push({ kind: 'add', text: b[j++]! });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++]! });
  while (j < m) out.push({ kind: 'add', text: b[j++]! });
  return out;
}

export const diffStats = (d: DiffLine[]) => ({
  added: d.filter((l) => l.kind === 'add').length,
  removed: d.filter((l) => l.kind === 'del').length,
});

export type DiffRow = DiffLine | { kind: 'skip'; count: number };

/** Keeps `context` unchanged lines around each change and folds the rest into "skip" rows. */
export function collapseDiff(d: DiffLine[], context = 2): DiffRow[] {
  const near = d.map((_, i) =>
    d.slice(Math.max(0, i - context), i + context + 1).some((l) => l.kind !== 'same'),
  );
  const out: DiffRow[] = [];
  d.forEach((l, i) => {
    if (l.kind !== 'same' || near[i]) out.push(l);
    else {
      const last = out.at(-1);
      if (last?.kind === 'skip') last.count++;
      else out.push({ kind: 'skip', count: 1 });
    }
  });
  return out;
}

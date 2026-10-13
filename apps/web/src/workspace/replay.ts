import type { RunEvent } from '../api';
import type { DemoFrame } from './demo';

type Link = { from: string; to: string };

/** Board edges a hand-off from `from` to `to` travels along (directly, or through the Critic). */
export function handoffEdges(links: Link[], from: string, to: string): string[] {
  const has = (a: string, b: string) => links.some((l) => l.from === a && l.to === b);
  if (has(from, to)) return [`${from}>${to}`];
  if (has(from, 'critic') && has('critic', to)) return [`${from}>critic`, `critic>${to}`];
  return [];
}

const MODE_SHORT: Record<string, string> = {
  single: 'по связи',
  end: 'готово',
  router: 'диспетчер',
  fallback: 'по связям',
  manual: 'вручную',
  limit: 'лимит',
};

/** Short edge label: why the result went this way (≤ 48 characters). */
function labelOf(mode: string, reason: string | undefined, confidence: unknown): string {
  const conf = typeof confidence === 'number' ? ` · ${Math.round(confidence * 100)}%` : '';
  const text = reason ? `${MODE_SHORT[mode] ?? mode}: ${reason}` : (MODE_SHORT[mode] ?? mode);
  const full = `${text}${conf}`;
  return full.length > 48 ? `${full.slice(0, 47)}…` : full;
}

/**
 * One board frame per event of a task: who is working, which edges carry a result right now
 * and the dispatcher's decision labels so far. Used for «Повтор» and for the labels of a task.
 */
export function replayFrames(events: RunEvent[], links: Link[]): DemoFrame[] {
  const states: Record<string, 'work' | 'done'> = {};
  const labels: Record<string, string> = {};
  const frames: DemoFrame[] = [];
  for (const e of events) {
    let flows: string[] = [];
    if (e.type === 'start') states[e.agent] = 'work';
    else if (e.type === 'done' || e.type === 'error') states[e.agent] = 'done';
    else if (e.type === 'handoff') {
      const p = (e.payload ?? {}) as {
        to?: string[];
        mode?: string;
        reasons?: Record<string, string>;
        confidence?: unknown;
      };
      for (const to of p.to ?? []) {
        const path = handoffEdges(links, e.agent, to);
        flows = [...flows, ...path];
        const last = path.at(-1);
        if (last) labels[last] = labelOf(p.mode ?? '', p.reasons?.[to], p.confidence);
      }
      states[e.agent] = 'done';
    }
    frames.push({
      states: { ...states },
      doing: {},
      event: e.text,
      eventAgent: e.agent,
      flows,
      labels: { ...labels },
    });
  }
  return frames;
}

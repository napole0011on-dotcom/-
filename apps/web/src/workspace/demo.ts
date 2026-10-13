import type { Pipeline } from '@cms/agents/graph';
import type { WorkspaceData } from '../api';
import { handoffEdges } from './replay';

export interface DemoFrame {
  states: Record<string, 'work' | 'done'>;
  doing: Record<string, string>;
  event: string;
  eventAgent: string;
  /** Edges ("from>to") carrying a result in this frame. */
  flows?: string[];
  /** Dispatcher decision labels on edges ("from>to" -> text). */
  labels?: Record<string, string>;
}

const TOPIC = 'Анонс осеннего меню';

/**
 * "Показать пример" (mock only): a scripted run over the CURRENT board, no models called,
 * nothing written. Layers follow the pipeline order; reviewed steps pass through their reviewer.
 */
export function demoScript(pipe: Pipeline, ws: WorkspaceData): DemoFrame[] {
  const name = (id: string) => ws.nodes.find((n) => n.id === id)?.name ?? id;
  const frames: DemoFrame[] = [];
  const done: Record<string, 'done'> = {};
  const labels: Record<string, string> = {};
  const push = (
    work: string[],
    event: string,
    eventAgent: string,
    doing: Record<string, string> = {},
    flows: string[] = [],
  ) =>
    frames.push({
      states: { ...done, ...Object.fromEntries(work.map((w) => [w, 'work' as const])) },
      doing,
      event,
      eventAgent,
      flows,
      labels: { ...labels },
    });

  const planner = pipe.planner ?? pipe.links.find((l) => l.from === 'brief')?.to;
  if (planner) {
    push([planner], `${name(planner)} · разбирает бриф и строит план`, planner, {
      [planner]: `${TOPIC}: план`,
    });
    done[planner] = 'done';
    push([], `${name(planner)} · план готов, вы утвердили`, planner);
  }

  const left = new Set(pipe.steps.map((s) => s.agent));
  while (left.size) {
    const layer = pipe.steps
      .filter((s) => left.has(s.agent) && s.after.every((a) => !left.has(a)))
      .map((s) => s.agent);
    if (layer.length === 0) break;
    // Results flow in along the links the step waits for (the first layer gets the plan).
    const flows = layer.flatMap((a) => {
      const after = pipe.steps.find((s) => s.agent === a)!.after;
      return (after.length ? after : planner ? [planner] : []).flatMap((f) => {
        const path = handoffEdges(pipe.links, f, a);
        if (path.length) labels[path.at(-1)!] = 'пример: по связи';
        return path;
      });
    });
    push(
      layer,
      `${layer.map(name).join(', ')} · ${layer.length > 1 ? 'начали' : 'начал'} работу`,
      layer[0]!,
      Object.fromEntries(layer.map((a) => [a, TOPIC])),
      flows,
    );
    // Each reviewer checks the steps linked to it (plans before stage 7: no reviewer id).
    const byReviewer = new Map<string, string[]>();
    for (const st of pipe.steps.filter((x) => layer.includes(x.agent) && x.reviewed)) {
      const r = st.reviewer ?? pipe.links.find((l) => l.from === st.agent)?.to;
      if (r) byReviewer.set(r, [...(byReviewer.get(r) ?? []), st.agent]);
    }
    for (const [reviewer, reviewed] of byReviewer) {
      push(
        [reviewer, ...reviewed],
        `${name(reviewer)} · проверяет: ${reviewed.map(name).join(', ')}`,
        reviewer,
        { [reviewer]: `${TOPIC}: проверка по критериям` },
      );
      done[reviewer] = 'done';
      push([], `${name(reviewer)} · вердикт: принято`, reviewer);
    }
    for (const a of layer) {
      done[a] = 'done';
      left.delete(a);
    }
    push([], `${layer.map(name).join(', ')} · готово`, layer[0]!);
  }
  push([], 'Пакет ждёт вашего решения', 'me');
  return frames;
}

import type { Pipeline } from '@cms/agents/graph';
import type { WorkspaceData } from '../api';

export interface DemoFrame {
  states: Record<string, 'work' | 'done'>;
  doing: Record<string, string>;
  event: string;
  eventAgent: string;
}

const TOPIC = 'Анонс осеннего меню';

/**
 * "Показать пример" (mock only): a scripted run over the CURRENT board, no models called,
 * nothing written. Layers follow the pipeline order; reviewed steps pass through the Critic.
 */
export function demoScript(pipe: Pipeline, ws: WorkspaceData): DemoFrame[] {
  const name = (id: string) => ws.nodes.find((n) => n.id === id)?.name ?? id;
  const frames: DemoFrame[] = [];
  const done: Record<string, 'done'> = {};
  const push = (
    work: string[],
    event: string,
    eventAgent: string,
    doing: Record<string, string> = {},
  ) =>
    frames.push({
      states: { ...done, ...Object.fromEntries(work.map((w) => [w, 'work' as const])) },
      doing,
      event,
      eventAgent,
    });

  push(['ceo'], 'CEO · разбирает бриф и строит план', 'ceo', { ceo: `${TOPIC}: план` });
  done.ceo = 'done';
  push([], 'CEO · план готов, вы утвердили', 'ceo');

  const left = new Set(pipe.steps.map((s) => s.agent));
  while (left.size) {
    const layer = pipe.steps
      .filter((s) => left.has(s.agent) && s.after.every((a) => !left.has(a)))
      .map((s) => s.agent);
    if (layer.length === 0) break;
    push(
      layer,
      `${layer.map(name).join(', ')} · ${layer.length > 1 ? 'начали' : 'начал'} работу`,
      layer[0]!,
      Object.fromEntries(
        layer.map((a) => [a, a === 'copywriter' ? `${TOPIC}: 3 варианта текста` : `${TOPIC}`]),
      ),
    );
    const reviewed = pipe.steps
      .filter((s) => layer.includes(s.agent) && s.reviewed)
      .map((s) => s.agent);
    if (reviewed.length) {
      push(
        ['critic', ...reviewed],
        `Critic · проверяет: ${reviewed.map(name).join(', ')}`,
        'critic',
        {
          critic: `${TOPIC}: проверка по чек-листу`,
        },
      );
      done.critic = 'done';
      push([], 'Critic · вердикт: принято', 'critic');
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

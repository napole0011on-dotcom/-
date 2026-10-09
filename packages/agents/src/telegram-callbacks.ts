/**
 * Inline-button payloads. Telegram limits callback_data to 1-64 bytes, so we use short
 * prefixes plus one UUID (36 chars): the longest payload is 41 bytes.
 */
export type Callback =
  | { type: 'plan'; action: 'approve' | 'change' | 'cancel'; taskId: string }
  | { type: 'item'; action: 'approve'; variant: number | null; artifactId: string }
  | { type: 'item'; action: 'revise' | 'regenerate'; artifactId: string }
  | {
      type: 'task';
      action: 'approve_all' | 'cancel' | 'reject_ask' | 'reject' | 'reopen';
      taskId: string;
    }
  | { type: 'budget'; extraUsd: number; taskId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const cb = {
  plan: (action: 'ok' | 'ch' | 'no', taskId: string) => `p:${action}:${taskId}`,
  item: (action: 'ok' | 'v1' | 'v2' | 'v3' | 'ed' | 're', artifactId: string) =>
    `a:${action}:${artifactId}`,
  /** rj = ask to confirm rejection, ry = rejection confirmed, ro = reopen (undo rejection). */
  task: (action: 'all' | 'no' | 'rj' | 'ry' | 'ro', taskId: string) => `t:${action}:${taskId}`,
  budget: (extraUsd: 1 | 5, taskId: string) => `b:${extraUsd}:${taskId}`,
};

export function parseCallback(data: string): Callback | null {
  const [kind, action, id] = data.split(':');
  if (!kind || !action || !id || !UUID.test(id)) return null;
  if (kind === 'p') {
    const a = ({ ok: 'approve', ch: 'change', no: 'cancel' } as const)[
      action as 'ok' | 'ch' | 'no'
    ];
    return a ? { type: 'plan', action: a, taskId: id } : null;
  }
  if (kind === 'a') {
    if (action === 'ok') return { type: 'item', action: 'approve', variant: null, artifactId: id };
    if (/^v[1-3]$/.test(action))
      return { type: 'item', action: 'approve', variant: Number(action[1]), artifactId: id };
    if (action === 'ed') return { type: 'item', action: 'revise', artifactId: id };
    if (action === 're') return { type: 'item', action: 'regenerate', artifactId: id };
    return null;
  }
  if (kind === 't') {
    if (action === 'all') return { type: 'task', action: 'approve_all', taskId: id };
    if (action === 'no') return { type: 'task', action: 'cancel', taskId: id };
    if (action === 'rj') return { type: 'task', action: 'reject_ask', taskId: id };
    if (action === 'ry') return { type: 'task', action: 'reject', taskId: id };
    if (action === 'ro') return { type: 'task', action: 'reopen', taskId: id };
    return null;
  }
  if (kind === 'b' && (action === '1' || action === '5'))
    return { type: 'budget', extraUsd: Number(action), taskId: id };
  return null;
}

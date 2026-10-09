import type { AgentStatus, Platform, TaskStatus } from './api';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: 'черновик',
  planned: 'план готовится',
  awaiting_plan_approval: 'ждёт утверждения плана',
  in_progress: 'в работе',
  in_review: 'проверка Critic',
  revision: 'доработка',
  awaiting_final_approval: 'ждёт вашего согласования',
  approved: 'утверждено',
  rejected: 'отклонено',
  exported: 'экспортировано',
  published: 'опубликовано',
  failed: 'ошибка',
  cancelled: 'отменено',
};

export type StatusTone = 'neutral' | 'accent' | 'info' | 'success' | 'danger' | 'muted';

export const STATUS_TONE: Record<TaskStatus, StatusTone> = {
  draft: 'neutral',
  planned: 'info',
  awaiting_plan_approval: 'accent',
  in_progress: 'info',
  in_review: 'info',
  revision: 'info',
  awaiting_final_approval: 'accent',
  approved: 'success',
  rejected: 'muted',
  exported: 'success',
  published: 'success',
  failed: 'danger',
  cancelled: 'muted',
};

export const BOARD_COLUMNS: { title: string; statuses: TaskStatus[] }[] = [
  { title: 'Планирование', statuses: ['draft', 'planned'] },
  { title: 'Ждут вас', statuses: ['awaiting_plan_approval', 'awaiting_final_approval'] },
  { title: 'В работе', statuses: ['in_progress', 'in_review', 'revision'] },
  { title: 'Готово', statuses: ['approved', 'exported', 'published'] },
  { title: 'Закрыто', statuses: ['failed', 'cancelled', 'rejected'] },
];

export const AGENT_STATUS: Record<AgentStatus, { label: string; tone: StatusTone }> = {
  idle: { label: 'свободен', tone: 'neutral' },
  working: { label: 'работает', tone: 'info' },
  waiting_approval: { label: 'ждёт согласования', tone: 'accent' },
  error: { label: 'ошибка', tone: 'danger' },
  paused: { label: 'на паузе', tone: 'muted' },
  disabled: { label: 'выключен', tone: 'danger' },
};

export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram_post: 'пост Instagram',
  instagram_carousel: 'карусель Instagram',
  instagram_reels: 'Reels',
  telegram_post: 'пост Telegram',
};

export const PROVIDER_LABEL: Record<string, string> = {
  mock: 'mock (без API)',
  anthropic: 'Anthropic',
  tokenharbor: 'Token Harbor',
};

export const CHECK_LABEL: Record<string, string> = {
  briefFit: 'соответствие брифу',
  brandVoice: 'голос бренда',
  clichesAndBureaucratese: 'штампы и канцелярит',
  facts: 'фактура',
  lengthAndFormat: 'длина и формат',
};

export const DECISION_LABEL: Record<string, string> = {
  approved: 'утверждено',
  changes_requested: 'правка',
  rejected: 'отклонено',
  regenerate: 'перегенерация',
  cancelled: 'отменено',
};

/** Money with enough precision to see cents of cents on cheap calls. */
export function usd(v: number): string {
  if (v === 0) return '$0';
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "только что", "5 мин назад", "3 ч назад", otherwise a date. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'только что';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} мин назад`;
  if (s < 86_400) return `${Math.round(s / 3600)} ч назад`;
  return dateTime(iso);
}

export function percent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate * 100)}%`;
}

/** Actor id from audit log/approvals in human words. */
export function actorLabel(actor: string): string {
  if (actor.includes('panel')) return 'вы (панель)';
  if (/(^|:)tg:/.test(actor)) return 'вы (Telegram)';
  if (actor.startsWith('human')) return 'вы';
  if (actor.startsWith('agent:')) return actor.slice('agent:'.length);
  return actor.replace(/^system:/, 'система: ');
}

export const ROLE_LABEL: Record<string, string> = {
  ceo: 'CEO',
  worker: 'Копирайтер',
  critic: 'Critic',
  classifier: 'классификатор',
};

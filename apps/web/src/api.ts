// HTTP client and response types of the panel API (apps/api/src/panel/routes.ts).

export type TaskStatus =
  | 'draft'
  | 'planned'
  | 'awaiting_plan_approval'
  | 'in_progress'
  | 'in_review'
  | 'revision'
  | 'awaiting_final_approval'
  | 'approved'
  | 'rejected'
  | 'exported'
  | 'published'
  | 'failed'
  | 'cancelled';

export type Platform =
  'instagram_post' | 'instagram_carousel' | 'instagram_reels' | 'telegram_post';
export type ModelRole = 'ceo' | 'critic' | 'worker' | 'classifier';

export interface SessionInfo {
  csrfToken: string;
  expiresAt: string;
  idleMinutes: number;
}

export interface LlmStatus {
  provider: 'mock' | 'anthropic' | 'tokenharbor';
  gatewayHost: string | null;
  structuredOutputs: boolean;
  rateLimit: { perMinute: number; perHour: number };
  costSafetyFactor: number;
  models: Record<ModelRole, string>;
  unpricedModels: string[];
  budget: { dailyUsd: number; monthlyUsd: number; taskUsd: number };
}

export type AgentStatus = 'idle' | 'working' | 'waiting_approval' | 'error' | 'paused';

export interface AgentCard {
  id: string;
  name: string;
  role: string;
  description: string;
  status: AgentStatus;
  currentTask: {
    id: string;
    title: string | null;
    since: string | null;
    runId: string | null;
  } | null;
  lastRunAt: string | null;
  lastRunId: string | null;
  success: { ok: number; failed: number; rate: number | null };
  spentTodayUsd: number;
  model: { name: string; role: ModelRole; source: '.env' | 'panel' };
  promptVersion: string;
}

export interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  paused: boolean;
  pauseReason: string | null;
  createdAt: string;
  statusChangedAt: string;
  spentUsd: number;
}

export interface Deliverable {
  id: string;
  platform: Platform;
  topic: string;
  goal: string;
  notes: string;
}

export interface Plan {
  summary: string;
  assumptions: string[];
  questions: string[];
  deliverables: Deliverable[];
}

export interface PlanEstimate {
  expectedUsd: number;
  maxUsd: number;
  expectedMinutes: number;
  steps: { agent: string; what: string }[];
}

export interface Variant {
  angle: string;
  hook: string;
  body: string;
  cta: string;
}

export interface CopyItem {
  deliverableId: string;
  variants: Variant[];
  slides: string[] | null;
  reelsScript:
    | { fromSec: number; toSec: number; visual: string; voiceover: string; onScreenText: string }[]
    | null;
}

export type CheckName =
  'briefFit' | 'brandVoice' | 'clichesAndBureaucratese' | 'facts' | 'lengthAndFormat';

export interface Verdict {
  deliverableId: string;
  verdict: 'pass' | 'fail';
  passed: boolean;
  checks: Record<CheckName, { ok: boolean; comment: string }>;
  issues: { variant: number | null; problem: string; fix: string }[];
  summary: string;
}

export interface ItemView {
  artifactId: string;
  version: number;
  deliverable: Deliverable;
  item: CopyItem;
  critic: Verdict;
  criticRound: number;
  criticRejected: boolean;
  ownerComment: string | null;
  promptVersion: string | null;
}

export type Decision = 'approved' | 'changes_requested' | 'rejected' | 'regenerate' | 'cancelled';

export interface TaskActions {
  decidePlan: boolean;
  decideItems: boolean;
  rejectPackage: boolean;
  reopenPackage: boolean;
  cancel: boolean;
}

export interface TaskDetail {
  task: {
    id: string;
    title: string;
    status: TaskStatus;
    brief: string;
    paused: boolean;
    pauseReason: string | null;
    createdAt: string;
    statusChangedAt: string;
    spentUsd: number;
    budgetUsd: number;
  };
  actions: TaskActions;
  plans: {
    id: string;
    version: number;
    createdAt: string;
    promptVersion: string | null;
    model: string | null;
    plan: Plan;
  }[];
  copies: (ItemView & {
    slot: string;
    createdAt: string;
    runId: string | null;
    model: string | null;
    decision: {
      decision: Decision;
      choice: number | null;
      comment: string | null;
      by: string;
      at: string;
    } | null;
  })[];
  decisions: {
    gate: 'plan' | 'final' | 'budget';
    decision: Decision;
    artifactVersion: number | null;
    choice: number | null;
    comment: string | null;
    by: string;
    at: string;
  }[];
  history: { at: string; actor: string; action: string; from: string | null; to: string | null }[];
  runs: {
    id: string;
    agent: string;
    status: string;
    attempt: number;
    createdAt: string;
    finishedAt: string | null;
    error: { message?: string } | null;
  }[];
}

export interface Approvals {
  plans: {
    taskId: string;
    title: string;
    waitingSince: string;
    planArtifactId: string;
    version: number;
    plan: Plan;
    estimate: PlanEstimate;
    spentUsd: number;
    taskBudgetUsd: number;
  }[];
  packages: {
    taskId: string;
    title: string;
    status: TaskStatus;
    waitingSince: string;
    totalCount: number;
    pendingCount: number;
    canReject: boolean;
    items: ItemView[];
  }[];
  count: number;
}

export interface RunCardData {
  run: {
    id: string;
    agent: string;
    status: string;
    attempt: number;
    input: unknown;
    output: unknown;
    error: unknown;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
  };
  task: { id: string; title: string } | null;
  invocations: {
    agent: string;
    status: string;
    promptVersion: string | null;
    model: string | null;
    costUsd: number;
    latencyMs: number | null;
    startedAt: string;
    error: unknown;
  }[];
  llmCalls: {
    id: string;
    agent: string;
    promptVersion: string | null;
    requestedModel: string;
    servedModel: string | null;
    attempt: number;
    status: string;
    stopReason: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    costUsd: number;
    latencyMs: number | null;
    createdAt: string;
    hasFullText: boolean;
    error: unknown;
  }[];
  artifacts: {
    id: string;
    slot: string;
    version: number;
    promptVersion: string | null;
    critic: Verdict | null;
  }[];
}

export interface BudgetLine {
  scope: string;
  spentUsd: number;
  limitUsd: number;
  level: 'ok' | 'warn' | 'over';
}

export interface Spend {
  warnRatio: number;
  day: BudgetLine;
  month: BudgetLine;
  taskLimitUsd: number;
  byAgent: { agent: string | null; todayUsd: number; monthUsd: number; calls: number }[];
  pausedTasks: { id: string; title: string; reason: string | null }[];
  reconciliations: {
    at: string;
    provider: string;
    balanceUsd: number;
    walletSpentUsd: number | null;
    recordedRawUsd: number;
  }[];
}

export interface ActionResult {
  ok: boolean;
  message: string;
  taskId?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}

// The CSRF token lives in memory only: a fresh one comes from /api/login or /api/session.
let csrfToken: string | null = null;
let onUnauthorized: () => void = () => undefined;

export const setCsrfToken = (t: string | null) => {
  csrfToken = t;
};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

// Idle timeout must count the owner's inactivity, not the panel's polling: requests carry
// X-Panel-Activity only if the owner clicked, typed or moved the mouse in the last minute.
const ACTIVE_WINDOW_MS = 60_000;
let lastActivity = Date.now();
if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(ev, () => (lastActivity = Date.now()), { passive: true });
  }
}

async function request<T>(method: 'GET' | 'POST', url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (Date.now() - lastActivity < ACTIVE_WINDOW_MS) headers['X-Panel-Activity'] = '1';
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401 && url !== '/api/login') onUnauthorized();
  if (!res.ok) {
    const msg =
      typeof data.message === 'string'
        ? data.message
        : typeof data.error === 'string'
          ? data.error
          : `Ошибка ${res.status}`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T = ActionResult>(url: string, body?: unknown) => request<T>('POST', url, body),
};

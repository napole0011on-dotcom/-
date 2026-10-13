import type { Composition } from '@cms/agents/blocks';
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
  controls: { allPaused: boolean; changedAt: string | null; changedBy: string | null };
  health: {
    state: 'ok' | 'degraded' | 'down';
    retryInSeconds: number | null;
    consecutiveFailures: number;
    lastError: {
      status?: number | null;
      requestId?: string | null;
      body?: string | null;
      message?: string;
    } | null;
    lastErrorAt: string | null;
    lastOkAt: string | null;
  };
}

export type AgentStatus = 'idle' | 'working' | 'waiting_approval' | 'error' | 'paused' | 'disabled';

export interface AgentControlsView {
  paused: boolean;
  disabled: boolean;
  allPaused: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface AgentCard {
  id: string;
  name: string;
  role: string;
  description: string;
  kind: NodeKind;
  /** Registry status: a constructor agent is a draft until it passes a test and is switched on. */
  registryStatus: NodeStatus;
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
  runs30: number;
  spentTodayUsd: number;
  model: {
    name: string;
    env: string;
    role: ModelRole;
    source: '.env' | 'panel';
    /** Panel model not in the current price list: ignored, .env is used. */
    ignoredOverride: string | null;
  };
  /** null: a new constructor agent without a saved prompt yet. */
  promptVersion: string | null;
  /** Label of a newer prompt version from the file that is not active yet. */
  pendingFilePrompt: string | null;
  controls: AgentControlsView;
  /** Runs held in the queue because this agent is paused/disabled or everything is stopped. */
  waitingRuns: number;
}

export interface PromptVersion {
  id: string;
  version: number;
  label: string;
  text: string;
  source: 'file' | 'panel';
  fileVersion: number | null;
  createdBy: string;
  createdAt: string;
  active: boolean;
}

export type FieldType = 'text' | 'long_text' | 'list' | 'number' | 'boolean' | 'items';

export interface SubFieldSpec {
  key: string;
  label: string;
  type: 'text' | 'long_text' | 'number' | 'boolean';
  hint?: string;
}

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hint?: string;
  minItems?: number;
  fields?: SubFieldSpec[];
}

export interface AgentTestRecord {
  ok: boolean;
  at: string;
  message: string;
  specHash: string;
  promptVersion: string;
}

export interface ConstructorView {
  fields: FieldSpec[];
  criteria: string[];
  lastTest: AgentTestRecord | null;
  /** Hash of the saved fields + criteria (null while they are incomplete). */
  specHash: string | null;
  /** What still blocks switching the agent on (empty when active or ready). */
  activationProblems: string[];
}

export interface AgentSettings {
  agent: {
    id: string;
    name: string;
    role: string;
    description: string;
    kind: NodeKind;
    status: NodeStatus;
    color: string;
    icon: string;
  };
  constructor: ConstructorView | null;
  controls: AgentControlsView;
  model: {
    name: string;
    env: string;
    source: '.env' | 'panel';
    role: ModelRole;
    allowed: string[];
    ignoredOverride: string | null;
  };
  prompts: {
    maxBytes: number;
    active: PromptVersion | null;
    pendingFile: PromptVersion | null;
    versions: PromptVersion[];
  };
}

export interface AgentTestResult {
  ok: boolean;
  message: string;
  agent: string;
  promptVersion: string | null;
  model: string | null;
  latencyMs: number;
  input: unknown;
  output: unknown;
  render?: { title: string; lines: string[] } | null;
  review?: { passed: boolean; summary: string; issues: { problem: string; fix: string }[] } | null;
  recorded?: boolean;
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
  /** "Копирайтер" / "все агенты остановлены" while a run of the task waits in the queue. */
  waitingFor: string | null;
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

/** Dispatcher decision for one finished step (who got its result). */
export interface RouteView {
  agent: string;
  name: string;
  candidates: { agent: string; name: string }[];
  /** null: not decided yet; [] — to «Вы». */
  targets: string[] | null;
  mode: 'single' | 'end' | 'router' | 'fallback' | 'manual' | 'limit' | null;
  needHelp: boolean;
  reasons: Record<string, string>;
}

export interface TaskDetail {
  routes: RouteView[];
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
    waitingFor: string | null;
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
  nodes: (NodeItem & {
    slot: string;
    createdAt: string;
    runId: string | null;
    model: string | null;
    decision: { decision: Decision; comment: string | null; by: string; at: string } | null;
  })[];
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
    waitingFor: string | null;
  }[];
}

/** Result of another agent of the graph (SEO, Image, ...). */
export interface NodeItem {
  artifactId: string;
  version: number;
  agent: string;
  agentName: string;
  title: string;
  lines: string[];
  critic: { passed: boolean; summary: string; issues: { problem: string; fix: string }[] } | null;
  criticRejected: boolean;
  ownerComment: string | null;
  promptVersion?: string | null;
  files: { name: string; mimeType: string }[];
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
    nodeItems: NodeItem[];
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
  /** Agent id after creating a constructor agent. */
  id?: string;
  /** «Собрать в агента»: what to fix, or what did not fully work. */
  problems?: string[];
  warnings?: string[];
  /** Blocks: the version just saved. */
  version?: number;
}

/** Agent library: system (read-only) and the owner's templates, latest versions. */
export interface LibraryTemplate {
  id: string;
  slug: string;
  version: number;
  system: boolean;
  category: string;
  name: string;
  role: string;
  description: string;
  requiresKey: string | null;
}
export interface LibraryData {
  categories: string[];
  templates: LibraryTemplate[];
}

/** Agents from blocks: the composition, its versions and the options of the blocks. */
export interface BlocksData {
  agentId: string;
  version: number | null;
  composition: Composition;
  builtVersion: number | null;
  versions: {
    version: number;
    note: string;
    createdAt: string;
    createdBy: string;
    built: boolean;
  }[];
  agent: { id: string; name: string; kind: string; status: string; color: string; icon: string };
  models: string[];
  tools: { id: string; name: string }[];
  agents: { id: string; name: string; status: string }[];
  problems: string[];
}

export type NodeKind = 'human' | 'code' | 'constructor' | 'tool';
export type NodeStatus = 'active' | 'draft' | 'planned';

export interface WorkspaceNodeData {
  id: string;
  name: string;
  role: string;
  description: string;
  kind: NodeKind;
  status: NodeStatus;
  color: string;
  icon: string;
  position: { x: number; y: number };
  card: AgentCard | null;
  /** Tool steps: permissions and read-only parameters from .env. */
  tool: {
    permissions: { reads: string[]; writes: string[]; hosts: string[] };
    params: Record<string, string>;
  } | null;
}

export interface WorkspaceLinkData {
  id: string;
  from: string;
  to: string;
  kind: 'system' | 'user';
  active: boolean;
  deletable: boolean;
}

export interface WorkspaceData {
  nodes: WorkspaceNodeData[];
  links: WorkspaceLinkData[];
}

export interface LiveEvent {
  id: number;
  at: string;
  agent: string;
  taskId: string | null;
  runId: string | null;
  kind: string;
  text: string;
  costUsd: number | null;
  payload?: Record<string, unknown> | null;
}

/** An event of one task in board terms (view run_events): «Ход задачи» and the replay. */
export interface RunEvent {
  id: number;
  at: string;
  agent: string;
  /** start | handoff | done | error | wait, or another agent_events kind (plan_ready, verdict…). */
  type: string;
  text: string;
  costUsd: number | null;
  payload: Record<string, unknown> | null;
}

export interface PipelineData {
  steps: { agent: string; name: string; after: string[]; reviewed: boolean; inputs?: string[] }[];
  inactive: { agent: string; name: string; reason: string }[];
  links: { from: string; to: string }[];
}

export interface TaskPathData {
  taskId: string;
  title: string;
  status: TaskStatus;
  pipeline: PipelineData | null;
  nodes: {
    agent: string;
    state: 'pending' | 'running' | 'waiting' | 'done' | 'failed';
    verdict: boolean | null;
    costUsd: number;
  }[];
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
  const form = body instanceof FormData;
  if (method === 'POST') {
    // A FormData upload sets its own multipart Content-Type with the boundary.
    if (!form) headers['Content-Type'] = 'application/json';
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  }
  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: method === 'POST' ? (form ? body : JSON.stringify(body ?? {})) : undefined,
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

export type TranscriptStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TranscriptRow {
  id: string;
  name: string;
  kind: 'voice' | 'video';
  source: 'telegram' | 'panel';
  status: TranscriptStatus;
  progress: number;
  durationSec: number | null;
  preview: string;
  error: string | null;
  createdAt: string;
}

export interface TranscriptDetail {
  id: string;
  name: string;
  kind: 'voice' | 'video';
  status: TranscriptStatus;
  error: string | null;
  language: string | null;
  provider: string | null;
  model: string | null;
  durationSec: number | null;
  chunksDone: number;
  chunksTotal: number | null;
  segments: { start: number; end: number; text: string }[];
  files: string[];
  mediaAvailable: boolean;
  mediaExpiresAt: string;
  mimeType: string;
  createdAt: string;
}

export interface CampaignView {
  id: string;
  title: string;
  subject: string;
  bodyText: string;
  bodyHtml: string;
  status: 'draft' | 'tested' | 'confirmed' | 'sending' | 'stopping' | 'stopped' | 'done';
  testSentAt: string | null;
  recipients: number | null;
  confirmedAt: string | null;
  createdAt: string;
  report: { queued: number; sent: number; failed: number; stopped: number; suppressed: number };
}

export interface MailingData {
  provider: 'mock' | 'smtp';
  testTo: boolean;
  unsubscribeUrl: boolean;
  limits: { batchSize: number; batchPauseSeconds: number; maxPerDay: number };
  audience: {
    total: number;
    withConsent: number;
    withoutConsent: number;
    unsubscribed: number;
    suppressed: number;
    eligible: number;
  };
  drafts: { artifactId: string; task: string; subject: string; createdAt: string }[];
  campaigns: CampaignView[];
}

import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { TASK_STATUSES } from '@cms/core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
/** Money: numeric keeps exact decimals; drizzle returns it as a string. */
const usd = (name: string) => numeric(name, { precision: 14, scale: 8 });

/** Tenant root. Every domain table carries brand_id. */
export const brands = pgTable('brands', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** Brand profile (tone, vocabulary, banned words, audience, visual style...). Shape is validated in code. */
  profile: jsonb('profile').notNull().default({}),
  profileVersion: integer('profile_version').notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const taskStatus = pgEnum('task_status', TASK_STATUSES);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    /** Sub-tasks point at the CEO task that created them. */
    parentId: uuid('parent_id'),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    brief: jsonb('brief').notNull().default({}),
    status: taskStatus('status').notNull().default('draft'),
    /** Bumped on every status change; useful for optimistic checks from UIs. */
    version: integer('version').notNull().default(1),
    budgetUsd: usd('budget_usd').notNull(),
    /** Pause is a flag, not a status: the task resumes where it stopped. */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pauseReason: text('pause_reason'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tasks_brand_status_idx').on(t.brandId, t.status),
    index('tasks_parent_idx').on(t.parentId),
  ],
);

export const runStatus = pgEnum('run_status', ['queued', 'running', 'succeeded', 'failed', 'dead']);

/** One execution of one agent for one task. Retries reuse the run (attempt++). */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    agent: text('agent').notNull(),
    /** Prevents duplicate runs for the same step (e.g. "task:<id>:copywriter:v2"). */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    status: runStatus('status').notNull().default('queued'),
    attempt: integer('attempt').notNull().default(0),
    input: jsonb('input').notNull().default({}),
    output: jsonb('output'),
    error: jsonb('error'),
    promptVersion: text('prompt_version'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('runs_task_idx').on(t.taskId),
    index('runs_status_heartbeat_idx').on(t.status, t.heartbeatAt),
  ],
);

/** Versioned agent output. A new version is created on every revision; old ones are kept. */
export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    runId: uuid('run_id').references(() => runs.id),
    /** Logical slot inside the task, e.g. "copy:post-1". Versions are per slot. */
    slot: text('slot').notNull(),
    kind: text('kind').notNull(),
    version: integer('version').notNull(),
    content: jsonb('content').notNull(),
    storageKey: text('storage_key'),
    agent: text('agent').notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: text('model'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('artifacts_task_slot_version_uq').on(t.taskId, t.slot, t.version),
    check('artifacts_version_positive', sql`${t.version} > 0`),
  ],
);

export const approvalGate = pgEnum('approval_gate', ['plan', 'final', 'budget']);
export const approvalDecision = pgEnum('approval_decision', [
  'approved',
  'changes_requested',
  'rejected',
  'regenerate',
  'cancelled',
]);

/** Every human decision, with the exact artifact version it was made on. */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    gate: approvalGate('gate').notNull(),
    artifactId: uuid('artifact_id').references(() => artifacts.id),
    artifactVersion: integer('artifact_version'),
    decision: approvalDecision('decision').notNull(),
    comment: text('comment'),
    /** Which variant (1-3) the owner picked when approving copy; null = all / not applicable. */
    choice: integer('choice'),
    decidedBy: text('decided_by').notNull(),
    /** e.g. Telegram callback id: pressing the button twice records one decision. */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [index('approvals_task_idx').on(t.taskId)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    taskId: uuid('task_id').references(() => tasks.id),
    actorKind: text('actor_kind').notNull(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    details: jsonb('details').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_log_task_idx').on(t.taskId, t.id)],
);

export const costStatus = pgEnum('cost_status', ['reserved', 'final', 'released']);

/**
 * Money spent (or reserved) per call. A reservation is written before an external call
 * so parallel calls cannot overshoot the budget; it becomes `final` with the real cost.
 */
export const costRecords = pgTable(
  'cost_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    taskId: uuid('task_id').references(() => tasks.id),
    runId: uuid('run_id').references(() => runs.id),
    agent: text('agent').notNull(),
    kind: text('kind').notNull(), // 'llm' | 'image'
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: costStatus('status').notNull().default('reserved'),
    reservedUsd: usd('reserved_usd').notNull(),
    /** Counted against budgets: token cost x LLM_COST_SAFETY_FACTOR. */
    costUsd: usd('cost_usd').notNull().default('0'),
    /** Token cost from the price list, without the safety factor (used for reconciliation). */
    rawCostUsd: usd('raw_cost_usd').notNull().default('0'),
    estimated: boolean('estimated').notNull().default(false),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    units: integer('units').notNull().default(0),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    createdAt: createdAt(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (t) => [
    index('cost_records_brand_created_idx').on(t.brandId, t.createdAt),
    index('cost_records_task_idx').on(t.taskId),
  ],
);

/** Human-approved extra budget, e.g. "+$2 for today" after a pause. */
export const budgetOverrides = pgTable(
  'budget_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    scope: text('scope').notNull(), // 'day' | 'month' | 'task'
    /** '2026-10-08' for day, '2026-10' for month, task id for task. */
    periodKey: text('period_key').notNull(),
    extraUsd: usd('extra_usd').notNull(),
    approvedBy: text('approved_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('budget_overrides_lookup_idx').on(t.brandId, t.scope, t.periodKey)],
);

/** One row per LLM HTTP request (including schema-repair retries). */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    taskId: uuid('task_id').references(() => tasks.id),
    runId: uuid('run_id').references(() => runs.id),
    agent: text('agent').notNull(),
    promptVersion: text('prompt_version').notNull(),
    requestedModel: text('requested_model').notNull(),
    servedModel: text('served_model'),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull(), // 'ok' | 'invalid_output' | 'error'
    stopReason: text('stop_reason'),
    /** Full request/response; null when LLM_STORE_FULL_TEXT=false. */
    request: jsonb('request'),
    response: jsonb('response'),
    error: jsonb('error'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costUsd: usd('cost_usd').notNull().default('0'),
    latencyMs: integer('latency_ms').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('llm_calls_run_idx').on(t.runId), index('llm_calls_task_idx').on(t.taskId)],
);

/**
 * Generic idempotency for side effects (LLM calls, Telegram button presses, exports).
 * `in_progress` rows carry a lease so a crashed worker does not block the key forever.
 */
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  status: text('status').notNull(), // 'in_progress' | 'completed'
  result: jsonb('result'),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

/**
 * Wallet balance snapshots for reconciling our cost accounting with what the provider
 * actually charged (/reconcile in the bot). Append-only by convention.
 */
export const walletSnapshots = pgTable(
  'wallet_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    provider: text('provider').notNull(),
    balanceUsd: usd('balance_usd').notNull(),
    /** Our raw recorded spend for this provider since the previous snapshot. */
    recordedRawUsd: usd('recorded_raw_usd').notNull().default('0'),
    /** Balance decrease since the previous snapshot (null for the first one or after a top-up). */
    walletSpentUsd: usd('wallet_spent_usd'),
    source: text('source').notNull(), // 'manual' | 'api'
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('wallet_snapshots_lookup_idx').on(t.brandId, t.provider, t.createdAt)],
);

export const invocationStatus = pgEnum('invocation_status', [
  'running',
  'succeeded',
  'failed',
  'waiting',
]);

/**
 * One call of one agent (CEO, Copywriter, Critic, ...), possibly several inside one run.
 * Agent cards in the panel are built from these rows.
 */
export const agentInvocations = pgTable(
  'agent_invocations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    agent: text('agent').notNull(),
    taskId: uuid('task_id').references(() => tasks.id),
    runId: uuid('run_id').references(() => runs.id),
    status: invocationStatus('status').notNull().default('running'),
    /** Prompt version the result was produced with, e.g. "copywriter@4#a1b2c3d4". */
    promptVersion: text('prompt_version').notNull(),
    model: text('model').notNull(),
    costUsd: usd('cost_usd').notNull().default('0'),
    latencyMs: integer('latency_ms'),
    error: jsonb('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('agent_invocations_agent_started_idx').on(t.agent, t.startedAt),
    index('agent_invocations_run_idx').on(t.runId),
  ],
);

/** Web panel sessions. Only a SHA-256 of the session token is stored. */
export const panelSessions = pgTable('panel_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  csrfToken: text('csrf_token').notNull(),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Single-row login throttle (one owner): consecutive failures and lock deadline. */
export const panelLoginState = pgTable('panel_login_state', {
  id: integer('id').primaryKey(),
  failedCount: integer('failed_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  updatedAt: updatedAt(),
});

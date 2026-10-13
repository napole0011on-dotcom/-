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
  primaryKey,
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
    /** Set while the run waits in the queue for a paused/disabled agent, e.g. "agent:copywriter" or "all". */
    waitingFor: text('waiting_for'),
    /** When the run started waiting (provider down, agent paused): limits the wait. */
    waitingSince: timestamp('waiting_since', { withTimezone: true }),
    /** 0..100 for long tool steps (video transcription); null = not reported. */
    progress: integer('progress'),
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

export const promptSource = pgEnum('prompt_source', ['file', 'panel']);

/**
 * Every version of every agent's system prompt. The DB is the source of truth once seeded;
 * prompts/*.md files only add versions (never activate them by themselves, except the very first).
 */
export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    agent: text('agent').notNull(),
    /** 1, 2, 3, ... per agent; the label is "<agent>@<version>#<hash>". */
    version: integer('version').notNull(),
    text: text('text').notNull(),
    /** First 8 hex chars of sha256(text). */
    hash: text('hash').notNull(),
    source: promptSource('source').notNull(),
    /** "version: N" from the file front matter (file versions only). */
    fileVersion: integer('file_version'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('prompt_versions_agent_version_uq').on(t.brandId, t.agent, t.version),
    uniqueIndex('prompt_versions_agent_hash_uq').on(t.brandId, t.agent, t.hash),
  ],
);

/** Owner's per-agent controls: pause, on/off, model override, active prompt. */
export const agentSettings = pgTable(
  'agent_settings',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    agent: text('agent').notNull(),
    paused: boolean('paused').notNull().default(false),
    disabled: boolean('disabled').notNull().default(false),
    /** null = model from LLM_MODEL_* in .env. */
    modelOverride: text('model_override'),
    activePromptId: uuid('active_prompt_id').references(() => promptVersions.id),
    updatedBy: text('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.brandId, t.agent] })],
);

/** "Stop everything": while all_paused is true no new run starts (running ones finish). */
export const globalControls = pgTable('global_controls', {
  brandId: uuid('brand_id')
    .primaryKey()
    .references(() => brands.id),
  allPaused: boolean('all_paused').notNull().default(false),
  changedBy: text('changed_by'),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Agent registry shown on the workspace board: code agents (CEO, Copywriter, Critic, ...),
 * agents built in the constructor, tool steps and the two human nodes ("Бриф", "Вы").
 */
export const agentDefinitions = pgTable(
  'agent_definitions',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    id: text('id').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    description: text('description').notNull().default(''),
    /** human | code | constructor | tool */
    kind: text('kind').notNull(),
    /** active | draft | planned */
    status: text('status').notNull().default('active'),
    /** Color token name (violet, indigo, ...), assigned round-robin and kept. */
    color: text('color').notNull(),
    icon: text('icon').notNull(),
    /** Which LLM_MODEL_* role the agent uses (null for humans and tools). */
    modelRole: text('model_role'),
    /** Constructor/tool specification (output fields, critic criteria, permissions). */
    spec: jsonb('spec').notNull().default({}),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.brandId, t.id] })],
);

/** A -> B: the result of A goes to B's input and B runs after A. */
export const agentLinks = pgTable(
  'agent_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    fromNode: text('from_node').notNull(),
    toNode: text('to_node').notNull(),
    /** system (pipeline, cannot be deleted) | user */
    kind: text('kind').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agent_links_pair_uq').on(t.brandId, t.fromNode, t.toNode)],
);

/** Node positions on the board. */
export const agentLayout = pgTable(
  'agent_layout',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    nodeId: text('node_id').notNull(),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    updatedBy: text('updated_by'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.brandId, t.nodeId] })],
);

/** "Что происходит сейчас": short live events; a trigger NOTIFYs listeners (panel SSE). */
export const agentEvents = pgTable(
  'agent_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    agent: text('agent').notNull(),
    taskId: uuid('task_id').references(() => tasks.id),
    runId: uuid('run_id').references(() => runs.id),
    /** started | finished | failed | plan_ready | verdict | waiting_owner | decision | exported | info */
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    costUsd: usd('cost_usd'),
    /** Extra data for the board and the replay: {to: [...], reason, confidence, artifactId}. */
    payload: jsonb('payload'),
  },
  (t) => [
    index('agent_events_brand_id_idx').on(t.brandId, t.id),
    index('agent_events_task_idx').on(t.taskId, t.id),
  ],
);

/** Uploaded audio/video (Telegram voice, panel upload). The file itself lives in object storage. */
export const mediaFiles = pgTable(
  'media_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    /** voice | video */
    kind: text('kind').notNull(),
    /** telegram | panel */
    source: text('source').notNull(),
    originalName: text('original_name').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    durationSec: numeric('duration_sec', { precision: 10, scale: 2 }),
    /** The media file is deleted from storage after this moment (transcripts stay). */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('media_files_brand_idx').on(t.brandId, t.createdAt)],
);

/** Result of a voice/video transcription; chunks are appended as they finish (no lost work). */
export const transcripts = pgTable(
  'transcripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => mediaFiles.id),
    taskId: uuid('task_id').references(() => tasks.id),
    /** queued | running | done | failed | cancelled */
    status: text('status').notNull().default('queued'),
    provider: text('provider'),
    model: text('model'),
    language: text('language'),
    durationSec: numeric('duration_sec', { precision: 10, scale: 2 }),
    /** Raw recognised text and its segments [{start, end, text}]. */
    text: text('text').notNull().default(''),
    segments: jsonb('segments').notNull().default([]),
    chunksDone: integer('chunks_done').notNull().default(0),
    chunksTotal: integer('chunks_total'),
    /** Storage keys of transcript.txt / subtitles.srt / subtitles.vtt / transcript.json. */
    files: jsonb('files').notNull().default([]),
    error: text('error'),
    /** Telegram chat that waits for the result (voice messages). */
    notifyChatId: text('notify_chat_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('transcripts_brand_idx').on(t.brandId, t.createdAt)],
);

/** Mailing contacts. Sending is allowed only with a stored consent (date + source). */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    email: text('email').notNull(),
    /** Merge fields: {name: "Анна", ...}. */
    fields: jsonb('fields').notNull().default({}),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    consentSource: text('consent_source'),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('contacts_brand_email_uq').on(t.brandId, t.email)],
);

/** Never send to these (unsubscribed, complaint, bounce). Only the hash of the address is kept. */
export const suppressions = pgTable(
  'suppressions',
  {
    brandId: uuid('brand_id')
      .notNull()
      .references(() => brands.id),
    emailHash: text('email_hash').notNull(),
    /** unsubscribe | complaint | bounce | manual */
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.brandId, t.emailHash] })],
);

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  brandId: uuid('brand_id')
    .notNull()
    .references(() => brands.id),
  /** The approved mailer_draft artifact the letter comes from. */
  artifactId: uuid('artifact_id')
    .notNull()
    .references(() => artifacts.id),
  title: text('title').notNull(),
  subject: text('subject').notNull(),
  bodyText: text('body_text').notNull(),
  bodyHtml: text('body_html').notNull(),
  /** draft | tested | confirmed | sending | stopping | stopped | done */
  status: text('status').notNull().default('draft'),
  testSentAt: timestamp('test_sent_at', { withTimezone: true }),
  /** Recipients at confirmation and the hash of their list (no addresses in logs). */
  recipients: integer('recipients'),
  listHash: text('list_hash'),
  confirmedBy: text('confirmed_by'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** One row per (campaign, contact): the idempotency of a send. */
export const campaignSends = pgTable(
  'campaign_sends',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id),
    /** queued | sent | failed | stopped | suppressed */
    status: text('status').notNull().default('queued'),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('campaign_sends_uq').on(t.campaignId, t.contactId)],
);

/** Health of an LLM provider (circuit breaker), shared by the bot (worker) and the API (header). */
export const providerStatus = pgTable('provider_status', {
  provider: text('provider').primaryKey(),
  /** ok | degraded (errors, still trying) | down (calls wait until open_until) */
  state: text('state').notNull().default('ok'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  /** Last error: status, request id, short body, human text (never keys or prompt text). */
  lastError: jsonb('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
  lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
  openUntil: timestamp('open_until', { withTimezone: true }),
  updatedAt: updatedAt(),
});

/**
 * Dispatcher decisions: after a step produced a result (identified by `fromSig`), to whom it
 * goes next. One row per (task, agent, result); the next steps start only after it exists.
 */
export const routeDecisions = pgTable(
  'route_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id),
    fromAgent: text('from_agent').notNull(),
    fromSig: text('from_sig').notNull(),
    /** Steps that receive the result (empty = straight to the owner's gate). */
    targets: jsonb('targets').notNull().default([]),
    /** single (one system link) | end (no next step) | router (LLM) | fallback | manual | limit */
    mode: text('mode').notNull(),
    reasons: jsonb('reasons').notNull().default({}),
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    needHelp: boolean('need_help').notNull().default(false),
    decidedBy: text('decided_by').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('route_decisions_uq').on(t.taskId, t.fromAgent, t.fromSig)],
);

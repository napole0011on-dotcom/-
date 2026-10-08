/**
 * Helpers for integration tests (real Postgres, fake LLM). Not used in production code.
 */
import type pg from 'pg';
import {
  createLogger,
  loadPricing,
  findRepoRoot,
  type Actor,
  type AppConfig,
  type BudgetConfig,
  type LlmConfig,
  type TaskStatus,
} from '@cms/core';
import { createDb, createPool, createTempDatabase, migrateUp, schema, type Db } from '@cms/db';
import { MockNotifier } from '@cms/providers';
import path from 'node:path';
import type { BudgetContext } from './budget.js';
import type { LlmRequest, LlmResponse, LlmTransport } from './llm/transport.js';
import { createTask, transitionTask } from './transitions.js';

export const HUMAN: Actor = { kind: 'human', id: 'tg:1' };
export const SYSTEM: Actor = { kind: 'system', id: 'test' };
export const silentLogger = createLogger({ level: 'silent' });

export interface TestDb {
  db: Db;
  pool: pg.Pool;
  config: AppConfig;
  close: () => Promise<void>;
}

export async function setupTestDb(): Promise<TestDb> {
  const tmp = await createTempDatabase();
  const pool = createPool(tmp.config.db, { max: 10 });
  const client = await pool.connect();
  try {
    await migrateUp(client);
  } finally {
    client.release();
  }
  return {
    db: createDb(pool),
    pool,
    config: tmp.config,
    close: async () => {
      await pool.end();
      await tmp.drop();
    },
  };
}

export async function seedBrand(db: Db, slug = `brand-${Math.random().toString(36).slice(2, 8)}`) {
  const [b] = await db.insert(schema.brands).values({ slug, name: slug }).returning();
  return b!;
}

/** Path through the state machine to reach any status, using the right actor at each gate. */
const PATH: TaskStatus[] = [
  'draft',
  'planned',
  'awaiting_plan_approval',
  'in_progress',
  'in_review',
  'awaiting_final_approval',
];

export async function seedTask(
  db: Db,
  brandId: string,
  opts: { status?: TaskStatus; budgetUsd?: number } = {},
): Promise<string> {
  const { id } = await createTask(db, {
    brandId,
    kind: 'content_week',
    title: 'Test task',
    budgetUsd: opts.budgetUsd ?? 2,
    actor: HUMAN,
  });
  const target = opts.status ?? 'draft';
  const idx = PATH.indexOf(target);
  if (idx < 0) throw new Error(`seedTask: unsupported target status ${target}`);
  for (let i = 1; i <= idx; i++) {
    await transitionTask(db, { taskId: id, to: PATH[i]!, actor: HUMAN });
  }
  return id;
}

export function budgetCtx(overrides: Partial<BudgetConfig> = {}, now?: () => Date): BudgetContext {
  return {
    config: { dailyUsd: 5, monthlyUsd: 50, taskUsd: 2, warnRatio: 0.8, ...overrides },
    timeZone: 'Europe/Moscow',
    ...(now ? { now } : {}),
  };
}

export function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    apiKey: 'test',
    models: {
      ceo: 'claude-opus-5-5',
      critic: 'claude-opus-5-5',
      worker: 'claude-sonnet-5-5',
      classifier: 'claude-haiku-5-5',
    },
    timeoutMs: 5_000,
    maxRetries: 0,
    storeFullText: true,
    refusalFallback: true,
    pricingFile: path.join(findRepoRoot(), 'config', 'model-pricing.json'),
    ...overrides,
  };
}

export const pricing = () => loadPricing(llmConfig().pricingFile);

/** Builds an Anthropic-shaped response. */
export function fakeResponse(
  text: string,
  opts: {
    model?: string;
    input?: number;
    output?: number;
    cacheRead?: number;
    stopReason?: LlmResponse['stop_reason'];
    iterations?: NonNullable<LlmResponse['usage']['iterations']>;
  } = {},
): LlmResponse {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'message',
    role: 'assistant',
    model: opts.model ?? 'claude-sonnet-5-5',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: opts.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: opts.input ?? 1000,
      output_tokens: opts.output ?? 500,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      iterations: opts.iterations ?? null,
    },
  } as unknown as LlmResponse;
}

/** Fake transport: replays scripted responses/errors and records every request. */
export class FakeTransport implements LlmTransport {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly script: Array<LlmResponse | Error | (() => LlmResponse | Error)>) {}

  create(params: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(params));
    const next = this.script.shift();
    if (!next) return Promise.reject(new Error('FakeTransport: no more scripted responses'));
    const item = typeof next === 'function' ? next() : next;
    return item instanceof Error ? Promise.reject(item) : Promise.resolve(item);
  }
}

export { MockNotifier };

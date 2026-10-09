import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BudgetExceededError, TransientError, findRepoRoot, loadPricing } from '@cms/core';
import { schema, sql } from '@cms/db';
import { LlmClient, extractJson } from './llm/client.js';
import { processRun } from './queue.js';
import { reconcileWallet, parseUsd } from './reconcile.js';
import { createRun, getRun } from './runs.js';
import {
  FakeTransport,
  HUMAN,
  MockNotifier,
  budgetCtx,
  fakeResponse,
  llmConfig,
  pricing,
  seedBrand,
  seedTask,
  setupTestDb,
  silentLogger,
  type TestDb,
} from './testkit.js';

const FREE = 'claude-haiku-5.5:free';
const gatewayPricing = () =>
  loadPricing(path.join(findRepoRoot(), 'config', 'model-pricing.tokenharbor.json'));
const Out = z.object({ greeting: z.string().min(5), wordCount: z.number().int().min(1) });

describe('Token Harbor mode (Postgres + fake transport)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());

  async function setup(
    script: ConstructorParameters<typeof FakeTransport>[0],
    opts: { budgetUsd?: number; factor?: number; pricingFile?: 'gateway' | 'anthropic' } = {},
  ) {
    const brand = await seedBrand(t.db);
    const taskId = await seedTask(t.db, brand.id, {
      status: 'in_progress',
      budgetUsd: opts.budgetUsd ?? 2,
    });
    const transport = new FakeTransport(script);
    const config = llmConfig({
      provider: 'tokenharbor',
      baseUrl: 'https://tokenharbor.ai',
      structuredOutputs: false,
      refusalFallback: false,
      costSafetyFactor: opts.factor ?? 1.2,
    });
    const client = new LlmClient({
      db: t.db,
      transport,
      pricing: opts.pricingFile === 'anthropic' ? pricing() : gatewayPricing(),
      config,
      budget: budgetCtx(),
      notifier: new MockNotifier(),
      logger: silentLogger,
    });
    const call = (model = FREE, key = `k-${Math.random()}`) =>
      client.callStructured({
        ctx: {
          brandId: brand.id,
          taskId,
          runId: null,
          agent: 'copywriter',
          promptVersion: 'copywriter@1',
        },
        model,
        system: [{ text: 'You are a copywriter.', cache: true }],
        prompt: 'Say hi',
        schema: Out,
        maxTokens: 2000,
        effort: 'low',
        idempotencyKey: key,
      });
    const costs = () =>
      t.db
        .select()
        .from(schema.costRecords)
        .where(sql`${schema.costRecords.taskId} = ${taskId}`);
    return { brand, taskId, transport, call, costs };
  }

  it('without structured outputs: schema goes to the system prompt, no output_config.format, cache_control kept', async () => {
    const s = await setup([
      fakeResponse('{"greeting":"Привет, друзья!","wordCount":2}', { model: FREE }),
    ]);
    const r = await s.call();
    expect(r.output).toEqual({ greeting: 'Привет, друзья!', wordCount: 2 });
    const req = s.transport.requests[0]! as unknown as Record<string, unknown> & {
      system: { text: string; cache_control?: unknown }[];
    };
    expect(req.output_config).toEqual({ effort: 'low' });
    expect(req).not.toHaveProperty('fallbacks');
    expect(req.system[0]).toMatchObject({
      text: 'You are a copywriter.',
      cache_control: { type: 'ephemeral' },
    });
    const schemaBlock = req.system.at(-1)!;
    expect(schemaBlock.cache_control).toBeUndefined();
    expect(schemaBlock.text).toMatch(/JSON Schema/);
    expect(schemaBlock.text).toMatch(/"greeting"/);
  });

  it('accepts JSON wrapped in ```json fences, and retries with Zod errors when the JSON is wrong', async () => {
    const s = await setup([
      fakeResponse('Вот ответ:\n```json\n{"greeting":"Hi","wordCount":0}\n```', { model: FREE }),
      fakeResponse('```json\n{"greeting":"Привет всем!","wordCount":2}\n```', { model: FREE }),
    ]);
    const r = await s.call();
    expect(r).toMatchObject({ attempts: 2, output: { greeting: 'Привет всем!', wordCount: 2 } });
    expect(JSON.stringify(s.transport.requests[1]!.messages.at(-1))).toMatch(/greeting|wordCount/);
  });

  it('the free model costs exactly $0 and is not "unknown"; a tiny budget does not pause it', async () => {
    const s = await setup(
      [
        fakeResponse('{"greeting":"Привет!!","wordCount":1}', {
          model: FREE,
          input: 50_000,
          output: 8_000,
        }),
      ],
      {
        budgetUsd: 0.0001,
      },
    );
    const r = await s.call();
    expect([r.costUsd, r.rawCostUsd]).toEqual([0, 0]);
    const [c] = await s.costs();
    expect(c).toMatchObject({
      status: 'final',
      costUsd: '0.00000000',
      rawCostUsd: '0.00000000',
      estimated: false,
      provider: 'tokenharbor',
    });
  });

  it('an unknown model behind the gateway is priced at unknownModelRates, never at zero', async () => {
    const s = await setup(
      [fakeResponse('{"greeting":"Привет!!","wordCount":1}', { model: 'claude-sonnet-x' })],
      { budgetUsd: 0.01 },
    );
    await expect(s.call('claude-sonnet-x')).rejects.toBeInstanceOf(BudgetExceededError);
    expect(s.transport.requests).toHaveLength(0);
  });

  it('safety factor x1.2: reservation and recorded cost are multiplied, raw cost kept for reconciliation', async () => {
    const s = await setup(
      [
        fakeResponse('{"greeting":"Привет!!","wordCount":1}', {
          model: 'claude-sonnet-5-5',
          input: 1000,
          output: 1000,
        }),
      ],
      {
        pricingFile: 'anthropic',
      },
    );
    const r = await s.call('claude-sonnet-5-5');
    expect(r.rawCostUsd).toBe(0.012);
    expect(r.costUsd).toBe(0.0144);
    const [c] = await s.costs();
    expect(c).toMatchObject({ costUsd: '0.01440000', rawCostUsd: '0.01200000' });
    expect(Number(c!.reservedUsd)).toBeGreaterThan(0.0144);
  });

  it('extractJson: plain, fenced, wrapped in text; fails clearly without an object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Ответ: {"a":3} — готово')).toEqual({ a: 3 });
    expect(() => extractJson('нет json')).toThrow(/no JSON/);
  });

  it('429 with Retry-After: the run is re-queued after that delay, without burning queue retries', async () => {
    const brand = await seedBrand(t.db);
    const taskId = await seedTask(t.db, brand.id, { status: 'in_progress' });
    const { run } = await createRun(t.db, {
      brandId: brand.id,
      taskId,
      agent: 'copywriter',
      idempotencyKey: `ra:${taskId}`,
    });
    const delayed: [string, number][] = [];
    const deps = {
      db: t.db,
      notifier: new MockNotifier(),
      logger: silentLogger,
      staleAfterSeconds: 60,
      enqueueAfter: (id: string, s: number) => Promise.resolve(delayed.push([id, s])),
    };
    const rateLimited = new TransientError('llm_rate_limited', '429', {
      status: 429,
      retryAfterSeconds: 42,
    });
    const outcome = await processRun(
      deps,
      run.id,
      () => Promise.reject(rateLimited),
      new AbortController().signal,
    );
    expect(outcome).toBe('retry');
    expect(delayed).toEqual([[run.id, 43]]);
    expect((await getRun(t.db, run.id))!.status).toBe('queued');
    // Without Retry-After the normal path rethrows for pg-boss backoff.
    await expect(
      processRun(
        deps,
        run.id,
        () => Promise.reject(new TransientError('net', 'reset')),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(TransientError);
    expect(Anthropic).toBeDefined();
  });
});

describe('/reconcile wallet reconciliation (Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());

  async function record(brandId: string, raw: number, factor = 1.2) {
    await t.db.insert(schema.costRecords).values({
      brandId,
      agent: 'copywriter',
      kind: 'llm',
      provider: 'tokenharbor',
      model: 'm',
      status: 'final',
      reservedUsd: '0',
      costUsd: (raw * factor).toFixed(8),
      rawCostUsd: raw.toFixed(8),
      idempotencyKey: `rec-${Math.random()}`,
    });
  }

  it('baseline -> ok -> undercount with a suggested factor -> top-up', async () => {
    const { id: brandId } = await seedBrand(t.db);
    const rec = (balanceUsd: number) =>
      reconcileWallet(t.db, {
        brandId,
        provider: 'tokenharbor',
        balanceUsd,
        costSafetyFactor: 1.2,
        actor: HUMAN,
      });

    expect((await rec(10)).kind).toBe('baseline');

    await record(brandId, 1.0); // budgeted 1.2
    const ok = await rec(8.9); // wallet -1.10, within our 1.2 budgeted
    expect(ok).toMatchObject({ kind: 'ok', recordedRawUsd: 1, recordedBudgetUsd: 1.2 });
    expect(ok.walletSpentUsd).toBeCloseTo(1.1);

    await record(brandId, 1.0); // budgeted 1.2, but the gateway charged 2.0
    const bad = await rec(6.9);
    expect(bad.kind).toBe('undercount');
    expect(bad.suggestedFactor).toBe(2.2); // 2.0 / 1.0 * 1.1, rounded up to 0.05
    expect(bad.message).toMatch(/LLM_COST_SAFETY_FACTOR=2\.20/);

    expect((await rec(20)).kind).toBe('topup');
    const audit = await t.db
      .select()
      .from(schema.auditLog)
      .where(
        sql`${schema.auditLog.brandId} = ${brandId} and ${schema.auditLog.action} = 'wallet_reconciled'`,
      );
    expect(audit).toHaveLength(4);
  });

  it('only a human can reconcile; amounts are parsed leniently', async () => {
    const { id: brandId } = await seedBrand(t.db);
    await expect(
      reconcileWallet(t.db, {
        brandId,
        provider: 'tokenharbor',
        balanceUsd: 5,
        costSafetyFactor: 1.2,
        actor: { kind: 'system', id: 'x' },
      }),
    ).rejects.toThrow(/human/);
    expect([
      parseUsd('12,34'),
      parseUsd('$12.34'),
      parseUsd(' 7 '),
      parseUsd('abc'),
      parseUsd('-1'),
    ]).toEqual([12.34, 12.34, 7, null, null]);
  });
});

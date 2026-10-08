import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BudgetExceededError, PermanentError, TransientError } from '@cms/core';
import { schema, sql } from '@cms/db';
import {
  FakeTransport,
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
} from '../testkit.js';
import { LlmClient, MAX_SCHEMA_RETRIES, type StructuredCallInput } from './client.js';

const Caption = z.object({
  hook: z.string().min(5),
  body: z.string().min(10),
  cta: z.string().min(3),
});
type Caption = z.infer<typeof Caption>;

const GOOD: Caption = {
  hook: 'Хватит листать',
  body: 'Вот три идеи на неделю без воды.',
  cta: 'Сохрани',
};

describe('LlmClient (Postgres + fake transport)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());

  async function setup(
    script: ConstructorParameters<typeof FakeTransport>[0],
    opts: { budgetUsd?: number; storeFullText?: boolean; dailyUsd?: number } = {},
  ) {
    const brand = await seedBrand(t.db);
    const taskId = await seedTask(t.db, brand.id, {
      status: 'in_progress',
      budgetUsd: opts.budgetUsd ?? 2,
    });
    const transport = new FakeTransport(script);
    const notifier = new MockNotifier();
    const client = new LlmClient({
      db: t.db,
      transport,
      pricing: pricing(),
      config: llmConfig(
        opts.storeFullText === undefined ? {} : { storeFullText: opts.storeFullText },
      ),
      budget: budgetCtx(opts.dailyUsd ? { dailyUsd: opts.dailyUsd } : {}),
      notifier,
      logger: silentLogger,
    });
    const input = (key = `k-${Math.random()}`): StructuredCallInput<Caption> => ({
      ctx: {
        brandId: brand.id,
        taskId,
        runId: null,
        agent: 'copywriter',
        promptVersion: 'copywriter@1',
      },
      model: 'claude-sonnet-5-5',
      system: [
        { text: 'You are a copywriter.', cache: true },
        { text: 'Brand profile: ...', cache: true },
      ],
      prompt: 'Write a caption.',
      schema: Caption,
      maxTokens: 2000,
      idempotencyKey: key,
    });
    const calls = () =>
      t.db
        .select()
        .from(schema.llmCalls)
        .where(sql`${schema.llmCalls.taskId} = ${taskId}`)
        .orderBy(schema.llmCalls.createdAt);
    const costs = () =>
      t.db
        .select()
        .from(schema.costRecords)
        .where(sql`${schema.costRecords.taskId} = ${taskId}`);
    return { brand, taskId, transport, notifier, client, input, calls, costs };
  }

  it('returns validated output and records the call, cost, model and prompt version', async () => {
    const s = await setup([fakeResponse(JSON.stringify(GOOD), { input: 1000, output: 500 })]);
    const r = await s.client.callStructured(s.input());
    expect(r).toMatchObject({
      output: GOOD,
      servedModel: 'claude-sonnet-5-5',
      attempts: 1,
      replayed: false,
      costUsd: 0.007,
    });

    const [call] = await s.calls();
    expect(call).toMatchObject({
      status: 'ok',
      agent: 'copywriter',
      promptVersion: 'copywriter@1',
      requestedModel: 'claude-sonnet-5-5',
      servedModel: 'claude-sonnet-5-5',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: '0.00700000',
    });
    expect(call!.latencyMs).toBeGreaterThanOrEqual(0);
    const [cost] = await s.costs();
    expect(cost).toMatchObject({ status: 'final', costUsd: '0.00700000', agent: 'copywriter' });

    // Request shape: cached system blocks, structured output, server-side refusal fallback.
    const req = s.transport.requests[0]! as unknown as Record<string, unknown>;
    expect(req.system).toEqual([
      { type: 'text', text: 'You are a copywriter.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Brand profile: ...', cache_control: { type: 'ephemeral' } },
    ]);
    expect((req.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    expect(req).toMatchObject({ fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect(req).not.toHaveProperty('tool_choice');
    expect(req).not.toHaveProperty('thinking');
  });

  it('invalid output is retried with the validation errors, then accepted', async () => {
    const s = await setup([
      fakeResponse(JSON.stringify({ hook: 'Hi', body: 'short', cta: 'x' })),
      fakeResponse(JSON.stringify(GOOD)),
    ]);
    const r = await s.client.callStructured(s.input());
    expect(r.attempts).toBe(2);
    expect(r.output).toEqual(GOOD);

    // Second request = original prompt + model's bad answer + feedback naming the fields.
    const second = s.transport.requests[1]!.messages;
    expect(second).toHaveLength(3);
    expect(second[1]!.role).toBe('assistant');
    expect(JSON.stringify(second[2]!.content)).toMatch(/hook/);
    expect(JSON.stringify(second[2]!.content)).toMatch(/body/);

    expect((await s.calls()).map((c) => c.status)).toEqual(['invalid_output', 'ok']);
    expect(await s.costs()).toHaveLength(2); // both attempts are paid for and recorded
  });

  it(`gives up after ${MAX_SCHEMA_RETRIES} repairs with a permanent error`, async () => {
    const bad = () => fakeResponse('not json at all');
    const s = await setup([bad(), bad(), bad(), bad()]);
    const err = await s.client.callStructured(s.input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermanentError);
    expect(err).toMatchObject({ code: 'llm_invalid_output' });
    expect(s.transport.requests).toHaveLength(1 + MAX_SCHEMA_RETRIES);
  });

  it('a truncated answer (max_tokens) is treated as invalid and retried', async () => {
    const s = await setup([
      fakeResponse('{"hook": "Хватит', { stopReason: 'max_tokens' }),
      fakeResponse(JSON.stringify(GOOD)),
    ]);
    expect((await s.client.callStructured(s.input())).attempts).toBe(2);
    expect(JSON.stringify(s.transport.requests[1]!.messages[2]!.content)).toMatch(/max_tokens/);
  });

  it('refusal is a permanent error and is not retried', async () => {
    const refusal = fakeResponse('', { stopReason: 'refusal' });
    const s = await setup([refusal]);
    await expect(s.client.callStructured(s.input())).rejects.toMatchObject({ code: 'llm_refusal' });
    expect(s.transport.requests).toHaveLength(1);
    expect((await s.calls())[0]!.status).toBe('refused');
  });

  it('429 after SDK retries -> transient error, reservation released, nothing billed', async () => {
    const s = await setup([
      new Anthropic.RateLimitError(429, undefined, 'slow down', new Headers()),
    ]);
    const err = await s.client.callStructured(s.input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientError);
    const [cost] = await s.costs();
    expect(cost!.status).toBe('released');
    expect((await s.calls())[0]!.status).toBe('error');
  });

  it('a 400 is permanent', async () => {
    const s = await setup([new Anthropic.BadRequestError(400, undefined, 'bad', new Headers())]);
    await expect(s.client.callStructured(s.input())).rejects.toBeInstanceOf(PermanentError);
  });

  it('same idempotency key -> one API call, one charge (queue redelivery)', async () => {
    const s = await setup([fakeResponse(JSON.stringify(GOOD))]);
    const input = s.input('run-123:step-1');
    const a = await s.client.callStructured(input);
    const b = await s.client.callStructured(input);
    expect(a.replayed).toBe(false);
    expect(b).toMatchObject({ replayed: true, output: GOOD });
    expect(s.transport.requests).toHaveLength(1);
    expect(await s.costs()).toHaveLength(1);
  });

  it('after a transient failure the same key can be retried', async () => {
    const s = await setup([
      new Anthropic.InternalServerError(503, undefined, 'down', new Headers()),
      fakeResponse(JSON.stringify(GOOD)),
    ]);
    const input = s.input('retry-key');
    await expect(s.client.callStructured(input)).rejects.toBeInstanceOf(TransientError);
    await expect(s.client.callStructured(input)).resolves.toMatchObject({ output: GOOD });
  });

  it('over budget -> BudgetExceededError before any API call', async () => {
    // maxTokens 2000 on Sonnet = $0.02 of output alone; task budget is $0.01.
    const s = await setup([fakeResponse(JSON.stringify(GOOD))], { budgetUsd: 0.01 });
    await expect(s.client.callStructured(s.input())).rejects.toBeInstanceOf(BudgetExceededError);
    expect(s.transport.requests).toHaveLength(0);
    expect(await s.calls()).toHaveLength(0);
  });

  it('crossing 80% of the daily budget sends one warning', async () => {
    // $0.5 daily budget; one call costs 0.45 (output 45k tokens on sonnet).
    const s = await setup([fakeResponse(JSON.stringify(GOOD), { input: 0, output: 45_000 })], {
      dailyUsd: 0.5,
      budgetUsd: 5,
    });
    const input = { ...s.input(), maxTokens: 1000 };
    await s.client.callStructured(input);
    expect(s.notifier.sent.map((m) => m.text).join('\n')).toMatch(/день/);
  });

  it('LLM_STORE_FULL_TEXT=false keeps metadata but not prompt/response text', async () => {
    const s = await setup([fakeResponse(JSON.stringify(GOOD))], { storeFullText: false });
    await s.client.callStructured(s.input());
    const [call] = await s.calls();
    expect(call).toMatchObject({ request: null, response: null, status: 'ok', inputTokens: 1000 });
  });
});

import Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { schema, sql } from '@cms/db';
import { processRun, type RunDeps } from '../queue.js';
import { createRun } from '../runs.js';
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
import { LlmClient } from './client.js';
import { ProviderHealth, ProviderUnavailableError } from './health.js';

const Out = z.object({ ok: z.boolean() });
const GOOD = fakeResponse(JSON.stringify({ ok: true }));
const SECRET = 'sk-ant-api03-SECRETSECRETSECRET';

/** What nginx in front of a dead upstream answers: HTML, a request id, maybe an echoed key. */
const bad502 = (n = 1) =>
  new Anthropic.InternalServerError(
    502,
    undefined,
    `<html><head><title>502 Bad Gateway</title></head><body>upstream connect error; key=${SECRET} ${'x'.repeat(600)}</body></html>`,
    new Headers({ 'x-request-id': `req_${n}` }),
  );

describe('LLM provider outages (Postgres + fake gateway)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());
  beforeEach(async () => {
    await t.db.delete(schema.providerStatus);
  });

  async function setup(script: ConstructorParameters<typeof FakeTransport>[0], maxRetries = 2) {
    const brand = await seedBrand(t.db);
    const taskId = await seedTask(t.db, brand.id, { status: 'in_progress' });
    const transport = new FakeTransport(script);
    const notifier = new MockNotifier();
    const config = llmConfig({
      provider: 'tokenharbor',
      maxRetries,
      breaker: { threshold: 3, cooldownSeconds: 60 },
    });
    const client = new LlmClient({
      db: t.db,
      transport,
      pricing: pricing(),
      config,
      budget: budgetCtx(),
      notifier,
      logger: silentLogger,
    });
    const call = (key: string) =>
      client.callStructured({
        ctx: { brandId: brand.id, taskId, runId: null, agent: 'ceo', promptVersion: 'ceo@1' },
        model: 'claude-sonnet-5-5',
        system: [{ text: 'sys' }],
        prompt: 'p',
        schema: Out,
        maxTokens: 100,
        idempotencyKey: key,
      });
    return { brand, taskId, transport, notifier, client, call };
  }

  it('502 -> retry with backoff -> success; the error is logged with status, request id and a short redacted body', async () => {
    const s = await setup([bad502(1), GOOD]);
    const r = await s.call('k1');
    expect(r.output).toEqual({ ok: true });
    expect(s.transport.requests).toHaveLength(2);
    const calls = await t.db
      .select()
      .from(schema.llmCalls)
      .where(sql`${schema.llmCalls.taskId} = ${s.taskId}`)
      .orderBy(schema.llmCalls.createdAt);
    expect(calls.map((c) => c.status)).toEqual(['error', 'ok']);
    const e = calls[0]!.error as { details: Record<string, unknown>; try: number };
    expect(e.details).toMatchObject({ status: 502, requestId: 'req_1', provider: 'tokenharbor' });
    expect(e.details.userMessage).toBe('Token Harbor вернул 502 (шлюз не получил ответ от модели)');
    expect(String(e.details.body).length).toBeLessThanOrEqual(300);
    expect(String(e.details.body)).toMatch(/^502 Bad Gateway upstream connect error/);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect(e.try).toBe(1);
    const events = await t.db
      .select()
      .from(schema.agentEvents)
      .where(sql`${schema.agentEvents.taskId} = ${s.taskId}`);
    expect(events.map((x) => x.text)).toEqual([
      expect.stringMatching(
        /^Token Harbor вернул 502 \(шлюз не получил ответ от модели\), повтор через \d+ с$/,
      ),
    ]);
    expect(
      (await new ProviderHealth(t.db, 'tokenharbor', { threshold: 3, cooldownSeconds: 60 }).view())
        .state,
    ).toBe('ok');
  });

  it('502 in a row -> breaker opens -> the run waits (not failed) -> provider back -> the run finishes by itself', async () => {
    const s = await setup([bad502(1), bad502(2), bad502(3), GOOD]);
    const { run } = await createRun(t.db, {
      brandId: s.brand.id,
      taskId: s.taskId,
      agent: 'ceo',
      idempotencyKey: 'run-ceo',
    });
    const later: { id: string; s: number }[] = [];
    const deps: RunDeps = {
      db: t.db,
      notifier: s.notifier,
      logger: silentLogger,
      staleAfterSeconds: 60,
      enqueueAfter: (id, sec) => Promise.resolve(later.push({ id, s: sec })),
      provider: { recheckSeconds: 60, waitMaxMinutes: 60 },
      gate: async () => {
        const v = await s.client.health!.view();
        return v.state === 'down' && (v.retryInSeconds ?? 0) > 0 ? 'provider:tokenharbor' : null;
      },
    };
    const handler = async () => ({ out: (await s.call('run-ceo:plan')).output });
    expect(await processRun(deps, run.id, handler, new AbortController().signal)).toBe('waiting');
    const [held] = await t.db
      .select()
      .from(schema.runs)
      .where(sql`${schema.runs.id} = ${run.id}`);
    expect(held).toMatchObject({
      status: 'queued',
      waitingFor: 'provider:tokenharbor',
      attempt: 0,
    });
    expect(held!.waitingSince).not.toBeNull();
    expect(later).toEqual([{ id: run.id, s: 61 }]);
    const [task] = await t.db
      .select()
      .from(schema.tasks)
      .where(sql`${schema.tasks.id} = ${s.taskId}`);
    expect(task!.status).toBe('in_progress');
    expect((await s.client.health!.view()).state).toBe('down');

    // While down, a redelivery does not touch the provider at all.
    expect(await processRun(deps, run.id, handler, new AbortController().signal)).toBe('waiting');
    expect(s.transport.requests).toHaveLength(3);
    await expect(s.client.health!.before()).rejects.toBeInstanceOf(ProviderUnavailableError);

    // Cooldown over -> one probe goes through, the gateway answers, everything continues.
    await t.db.update(schema.providerStatus).set({ openUntil: new Date(Date.now() - 1000) });
    expect(await processRun(deps, run.id, handler, new AbortController().signal)).toBe('succeeded');
    expect((await s.client.health!.view()).state).toBe('ok');
    const [done] = await t.db
      .select()
      .from(schema.runs)
      .where(sql`${schema.runs.id} = ${run.id}`);
    expect(done).toMatchObject({ status: 'succeeded', waitingSince: null });
  });

  it('waiting longer than the limit pauses the task and tells the owner', async () => {
    const s = await setup([bad502(1), bad502(2), bad502(3)]);
    const { run } = await createRun(t.db, {
      brandId: s.brand.id,
      taskId: s.taskId,
      agent: 'ceo',
      idempotencyKey: 'run-limit',
    });
    const deps: RunDeps = {
      db: t.db,
      notifier: s.notifier,
      logger: silentLogger,
      staleAfterSeconds: 60,
      enqueueAfter: () => Promise.resolve(),
      provider: { recheckSeconds: 60, waitMaxMinutes: 30 },
      providerPauseButtons: (id) => [[{ text: '▶️ Продолжить', data: `t:rs:${id}` }]],
    };
    const handler = async () => ({ out: (await s.call('run-limit:plan')).output });
    expect(await processRun(deps, run.id, handler, new AbortController().signal)).toBe('waiting');
    await t.db
      .update(schema.runs)
      .set({ waitingSince: sql`now() - interval '31 minutes'` })
      .where(sql`${schema.runs.id} = ${run.id}`);
    expect(await processRun(deps, run.id, handler, new AbortController().signal)).toBe('paused');
    const [task] = await t.db
      .select()
      .from(schema.tasks)
      .where(sql`${schema.tasks.id} = ${s.taskId}`);
    expect(task).toMatchObject({ status: 'in_progress', pauseReason: 'provider_unavailable' });
    expect(s.notifier.sent.at(-1)!.text).toMatch(/Token Harbor недоступен дольше 30 мин/);
    expect(s.notifier.sent.at(-1)!.buttons![0]![0]!.data).toBe(`t:rs:${s.taskId}`);
  });

  it('a 400 is not retried and does not trip the breaker; LLM_FALLBACK_MODEL is used after the main model fails', async () => {
    const s = await setup([new Anthropic.BadRequestError(400, undefined, 'bad', new Headers())]);
    await expect(s.call('k400')).rejects.toMatchObject({ code: 'llm_request_rejected' });
    expect((await s.client.health!.view()).consecutiveFailures).toBe(0);

    const brand = await seedBrand(t.db);
    const taskId = await seedTask(t.db, brand.id, { status: 'in_progress' });
    const transport = new FakeTransport([bad502(1), GOOD]);
    const client = new LlmClient({
      db: t.db,
      transport,
      pricing: pricing(),
      config: llmConfig({
        provider: 'tokenharbor',
        maxRetries: 0,
        fallbackModel: 'claude-haiku-5-5',
      }),
      budget: budgetCtx(),
      notifier: new MockNotifier(),
      logger: silentLogger,
    });
    const r = await client.callStructured({
      ctx: { brandId: brand.id, taskId, runId: null, agent: 'ceo', promptVersion: 'ceo@1' },
      model: 'claude-sonnet-5-5',
      system: [],
      prompt: 'p',
      schema: Out,
      maxTokens: 100,
      idempotencyKey: 'kfb',
    });
    expect(r.output).toEqual({ ok: true });
    expect(transport.requests.map((x) => x.model)).toEqual([
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
    ]);
    expect(
      () =>
        new LlmClient({
          db: t.db,
          transport,
          pricing: pricing(),
          config: llmConfig({ fallbackModel: 'not-in-price-list' }),
          budget: budgetCtx(),
          notifier: new MockNotifier(),
          logger: silentLogger,
        }),
    ).toThrow(/not in the price list/);
  });
});

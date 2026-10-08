import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetExceededError, PermanentError, TransientError } from '@cms/core';
import { schema, sql } from '@cms/db';
import { remindStaleApprovals, runMaintenance } from './maintenance.js';
import { processRun, RunQueue, type RunDeps, type RunHandler } from './queue.js';
import { createRun, getRun } from './runs.js';
import {
  MockNotifier,
  seedBrand,
  seedTask,
  setupTestDb,
  silentLogger,
  type TestDb,
} from './testkit.js';

describe('agent runs and queue (Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());

  async function setup(staleAfterSeconds = 60) {
    const brand = await seedBrand(t.db);
    const taskId = await seedTask(t.db, brand.id, { status: 'in_progress' });
    const notifier = new MockNotifier();
    const deps: RunDeps = { db: t.db, notifier, logger: silentLogger, staleAfterSeconds };
    const { run } = await createRun(t.db, {
      brandId: brand.id,
      taskId,
      agent: 'copywriter',
      idempotencyKey: `task:${taskId}:copywriter:v1`,
    });
    const taskRow = async () =>
      (
        await t.db
          .select()
          .from(schema.tasks)
          .where(sql`${schema.tasks.id} = ${taskId}`)
      )[0]!;
    return { brand, taskId, notifier, deps, run, taskRow };
  }
  const signal = new AbortController().signal;

  it('createRun is idempotent per key', async () => {
    const s = await setup();
    const again = await createRun(t.db, {
      brandId: s.brand.id,
      taskId: s.taskId,
      agent: 'copywriter',
      idempotencyKey: `task:${s.taskId}:copywriter:v1`,
    });
    expect(again).toMatchObject({ created: false, run: { id: s.run.id } });
  });

  it('success: run succeeded with output; a duplicate delivery is skipped', async () => {
    const s = await setup();
    let executions = 0;
    const handler: RunHandler = () => Promise.resolve({ n: ++executions });
    expect(await processRun(s.deps, s.run.id, handler, signal)).toBe('succeeded');
    expect(await processRun(s.deps, s.run.id, handler, signal)).toBe('skipped');
    expect(executions).toBe(1);
    expect(await getRun(t.db, s.run.id)).toMatchObject({
      status: 'succeeded',
      output: { n: 1 },
      attempt: 1,
    });
  });

  it('two workers racing for the same run: only one executes it', async () => {
    const s = await setup();
    let executions = 0;
    const handler: RunHandler = async () => {
      executions++;
      await new Promise((r) => setTimeout(r, 50));
      return {};
    };
    const outcomes = await Promise.all(
      [1, 2, 3].map(() => processRun(s.deps, s.run.id, handler, signal)),
    );
    expect(executions).toBe(1);
    expect(outcomes.sort()).toEqual(['skipped', 'skipped', 'succeeded']);
  });

  it('transient error: run goes back to queued and the error is rethrown for retry', async () => {
    const s = await setup();
    const handler: RunHandler = () => Promise.reject(new TransientError('llm_rate_limited', '429'));
    await expect(processRun(s.deps, s.run.id, handler, signal)).rejects.toBeInstanceOf(
      TransientError,
    );
    expect(await getRun(t.db, s.run.id)).toMatchObject({
      status: 'queued',
      attempt: 1,
      error: { code: 'llm_rate_limited' },
    });
    // Next delivery succeeds.
    expect(await processRun(s.deps, s.run.id, () => Promise.resolve({}), signal)).toBe('succeeded');
    expect((await getRun(t.db, s.run.id))!.attempt).toBe(2);
  });

  it('permanent error: run failed, task failed, human notified, no rethrow', async () => {
    const s = await setup();
    const handler: RunHandler = () =>
      Promise.reject(new PermanentError('llm_invalid_output', 'bad JSON'));
    expect(await processRun(s.deps, s.run.id, handler, signal)).toBe('failed');
    expect(await getRun(t.db, s.run.id)).toMatchObject({ status: 'failed' });
    expect((await s.taskRow()).status).toBe('failed');
    expect(s.notifier.sent[0]!.text).toMatch(/copywriter.*bad JSON/);
  });

  it('budget exceeded: task paused with reason, run stays queued, human asked; paused task is not executed', async () => {
    const s = await setup();
    const handler: RunHandler = () => Promise.reject(new BudgetExceededError('day', 5, 4.9, 0.3));
    expect(await processRun(s.deps, s.run.id, handler, signal)).toBe('paused');
    expect(await s.taskRow()).toMatchObject({ status: 'in_progress', pauseReason: 'budget:day' });
    expect((await getRun(t.db, s.run.id))!.status).toBe('queued');
    expect(s.notifier.sent[0]!.text).toMatch(/паузе.*бюджет.*подтверждения/s);

    let executed = false;
    expect(
      await processRun(s.deps, s.run.id, () => ((executed = true), Promise.resolve({})), signal),
    ).toBe('paused');
    expect(executed).toBe(false);
  });

  it('a run whose worker died (no heartbeat) can be reclaimed; maintenance re-queues it', async () => {
    const s = await setup(1);
    await t.db
      .update(schema.runs)
      .set({ status: 'running', heartbeatAt: sql`now() - interval '10 seconds'` })
      .where(sql`${schema.runs.id} = ${s.run.id}`);
    const enqueued: string[] = [];
    await runMaintenance({
      db: t.db,
      notifier: s.notifier,
      logger: silentLogger,
      staleAfterSeconds: 1,
      reservationTtlSeconds: 3600,
      approvalReminderHours: 12,
      enqueue: (id) => Promise.resolve(enqueued.push(id)),
    });
    expect(enqueued).toContain(s.run.id);
    expect((await getRun(t.db, s.run.id))!.status).toBe('queued');
  });

  it('approval reminders: once per period, auto-pause after the second, never auto-approve', async () => {
    const brand = await seedBrand(t.db);
    const taskId = await seedTask(t.db, brand.id, { status: 'awaiting_final_approval' });
    const notifier = new MockNotifier();
    const since = (
      await t.db
        .select()
        .from(schema.tasks)
        .where(sql`${schema.tasks.id} = ${taskId}`)
    )[0]!.statusChangedAt;
    const at = (h: number) => new Date(since.getTime() + h * 3_600_000 + 1000);

    expect((await remindStaleApprovals(t.db, notifier, 12, at(5))).reminded).not.toContain(taskId);
    expect((await remindStaleApprovals(t.db, notifier, 12, at(13))).reminded).toContain(taskId);
    expect((await remindStaleApprovals(t.db, notifier, 12, at(14))).reminded).not.toContain(taskId);
    const third = await remindStaleApprovals(t.db, notifier, 12, at(25));
    expect(third).toMatchObject({ reminded: [taskId], paused: [taskId] });
    expect(notifier.sent.filter((m) => m.text.includes('Напоминание'))).toHaveLength(2);

    const row = (
      await t.db
        .select()
        .from(schema.tasks)
        .where(sql`${schema.tasks.id} = ${taskId}`)
    )[0]!;
    expect(row).toMatchObject({
      status: 'awaiting_final_approval',
      pauseReason: 'approval_timeout',
    });
  });

  describe('with pg-boss', () => {
    let queue: RunQueue;
    const notifier = new MockNotifier();
    const behaviour = new Map<string, () => Promise<Record<string, unknown>>>();
    const executions = new Map<string, number>();

    beforeAll(async () => {
      queue = await RunQueue.start({
        config: {
          ...t.config,
          queue: {
            retryLimit: 2,
            retryDelaySeconds: 1,
            jobTimeoutSeconds: 60,
            runStaleAfterSeconds: 60,
          },
        },
        deps: { db: t.db, notifier, logger: silentLogger, staleAfterSeconds: 60 },
      });
      await queue.work(
        (run) => {
          executions.set(run.id, (executions.get(run.id) ?? 0) + 1);
          return (behaviour.get(run.id) ?? (() => Promise.resolve({})))();
        },
        { pollingIntervalSeconds: 0.5 },
      );
    }, 60_000);
    afterAll(async () => queue?.stop());

    const waitFor = async (fn: () => Promise<boolean>, ms = 20_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await fn()) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('timed out waiting for condition');
    };

    it('enqueueing the same run twice executes it once', async () => {
      const s = await setup();
      await queue.enqueue(s.run.id);
      await queue.enqueue(s.run.id);
      await waitFor(async () => (await getRun(t.db, s.run.id))!.status === 'succeeded');
      await new Promise((r) => setTimeout(r, 1500));
      expect(executions.get(s.run.id)).toBe(1);
    });

    it('transient failures are retried with backoff, then succeed', async () => {
      const s = await setup();
      let n = 0;
      behaviour.set(s.run.id, () =>
        ++n < 2
          ? Promise.reject(new TransientError('net', 'flaky'))
          : Promise.resolve({ ok: true }),
      );
      await queue.enqueue(s.run.id);
      await waitFor(async () => (await getRun(t.db, s.run.id))!.status === 'succeeded');
      expect(executions.get(s.run.id)).toBe(2);
    });

    it('exhausted retries land in the dead-letter queue: run dead, task failed, reason kept', async () => {
      const s = await setup();
      behaviour.set(s.run.id, () =>
        Promise.reject(new TransientError('llm_server_error', 'upstream 503')),
      );
      await queue.enqueue(s.run.id);
      await waitFor(async () => (await getRun(t.db, s.run.id))!.status === 'dead', 40_000);
      expect(executions.get(s.run.id)).toBe(3); // 1 + retryLimit 2
      const run = (await getRun(t.db, s.run.id))!;
      expect(run.error).toMatchObject({
        code: 'retries_exhausted',
        message: expect.stringMatching(/upstream 503/) as unknown,
      });
      expect((await s.taskRow()).status).toBe('failed');
    }, 60_000);
  });
});

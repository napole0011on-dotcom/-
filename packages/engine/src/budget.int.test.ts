import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BudgetExceededError, PermanentError } from '@cms/core';
import { schema, sql } from '@cms/db';
import {
  approveBudgetOverride,
  budgetStatus,
  checkBudgetWarnings,
  finalizeCost,
  periodKeys,
  releaseCost,
  releaseStaleReservations,
  reserveCost,
  type ReserveInput,
} from './budget.js';
import {
  HUMAN,
  MockNotifier,
  SYSTEM,
  budgetCtx,
  seedBrand,
  seedTask,
  setupTestDb,
  type TestDb,
} from './testkit.js';

let seq = 0;
const reserveInput = (
  brandId: string,
  taskId: string | null,
  estimateUsd: number,
): ReserveInput => ({
  brandId,
  taskId,
  runId: null,
  agent: 'copywriter',
  kind: 'llm',
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  estimateUsd,
  idempotencyKey: `test-${++seq}`,
});

describe('periodKeys', () => {
  it('uses the app time zone, not UTC', () => {
    // 2026-10-31 22:30 UTC is already Nov 1st in Moscow (UTC+3).
    expect(periodKeys(new Date('2026-10-31T22:30:00Z'), 'Europe/Moscow')).toEqual({
      day: '2026-11-01',
      month: '2026-11',
    });
    expect(periodKeys(new Date('2026-10-31T22:30:00Z'), 'UTC')).toEqual({
      day: '2026-10-31',
      month: '2026-10',
    });
  });
});

describe('budget accounting (Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());

  const spentOf = async (brandId: string, taskId: string | null, scope: 'task' | 'day' | 'month') =>
    (await budgetStatus(t.db, budgetCtx(), brandId, taskId)).find((s) => s.scope === scope)!;

  it('counts reservations, then the actual cost; released reservations do not count', async () => {
    const { id: brandId } = await seedBrand(t.db);
    const taskId = await seedTask(t.db, brandId, { status: 'in_progress' });
    const ctx = budgetCtx();

    const r1 = await reserveCost(t.db, ctx, reserveInput(brandId, taskId, 0.5));
    expect((await spentOf(brandId, taskId, 'task')).spentUsd).toBeCloseTo(0.5);

    await finalizeCost(t.db, r1.id, {
      costUsd: 0.12,
      model: 'claude-sonnet-5-5',
      estimated: false,
      inputTokens: 10,
      outputTokens: 5,
    });
    expect((await spentOf(brandId, taskId, 'task')).spentUsd).toBeCloseTo(0.12);

    const r2 = await reserveCost(t.db, ctx, reserveInput(brandId, taskId, 0.3));
    await releaseCost(t.db, r2.id);
    for (const scope of ['task', 'day', 'month'] as const) {
      expect((await spentOf(brandId, taskId, scope)).spentUsd, scope).toBeCloseTo(0.12);
    }

    const [row] = await t.db
      .select()
      .from(schema.costRecords)
      .where(sql`${schema.costRecords.id} = ${r1.id}`);
    expect(row).toMatchObject({
      status: 'final',
      costUsd: '0.12000000',
      inputTokens: 10,
      outputTokens: 5,
      agent: 'copywriter',
    });
  });

  it('re-reserving with the same idempotency key does not double count', async () => {
    const { id: brandId } = await seedBrand(t.db);
    const input = reserveInput(brandId, null, 1);
    const a = await reserveCost(t.db, budgetCtx(), input);
    const b = await reserveCost(t.db, budgetCtx(), input);
    expect(a.id).toBe(b.id);
    expect((await spentOf(brandId, null, 'day')).spentUsd).toBeCloseTo(1);
  });

  it('refuses a call that would exceed the task budget', async () => {
    const { id: brandId } = await seedBrand(t.db);
    const taskId = await seedTask(t.db, brandId, { status: 'in_progress', budgetUsd: 1 });
    await reserveCost(t.db, budgetCtx(), reserveInput(brandId, taskId, 0.8));
    const err = await reserveCost(t.db, budgetCtx(), reserveInput(brandId, taskId, 0.3)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({ scope: 'task', limitUsd: 1 });
  });

  it('refuses a call that would exceed the daily budget, across tasks', async () => {
    const { id: brandId } = await seedBrand(t.db);
    const ctx = budgetCtx({ dailyUsd: 1, taskUsd: 10 });
    const t1 = await seedTask(t.db, brandId, { status: 'in_progress', budgetUsd: 10 });
    const t2 = await seedTask(t.db, brandId, { status: 'in_progress', budgetUsd: 10 });
    await reserveCost(t.db, ctx, reserveInput(brandId, t1, 0.7));
    await expect(reserveCost(t.db, ctx, reserveInput(brandId, t2, 0.4))).rejects.toMatchObject({
      scope: 'day',
    });
  });

  it('parallel reservations never overshoot the limit (advisory lock)', async () => {
    const { id: brandId } = await seedBrand(t.db);
    const ctx = budgetCtx({ dailyUsd: 1 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => reserveCost(t.db, ctx, reserveInput(brandId, null, 0.3))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await spentOf(brandId, null, 'day')).spentUsd).toBeCloseTo(0.9);
  });

  it('a human-approved override raises the limit; agents/system cannot approve', async () => {
    const { id: brandId } = await seedBrand(t.db);
    const ctx = budgetCtx({ dailyUsd: 1 });
    await reserveCost(t.db, ctx, reserveInput(brandId, null, 0.9));
    await expect(reserveCost(t.db, ctx, reserveInput(brandId, null, 0.5))).rejects.toBeInstanceOf(
      BudgetExceededError,
    );

    const { day } = periodKeys(new Date(), ctx.timeZone);
    await expect(
      approveBudgetOverride(t.db, {
        brandId,
        scope: 'day',
        periodKey: day,
        extraUsd: 1,
        actor: SYSTEM,
      }),
    ).rejects.toBeInstanceOf(PermanentError);
    await approveBudgetOverride(t.db, {
      brandId,
      scope: 'day',
      periodKey: day,
      extraUsd: 1,
      actor: HUMAN,
    });

    await expect(reserveCost(t.db, ctx, reserveInput(brandId, null, 0.5))).resolves.toBeDefined();
    const audit = await t.db
      .select()
      .from(schema.auditLog)
      .where(
        sql`${schema.auditLog.brandId} = ${brandId} and ${schema.auditLog.action} = 'budget_override_approved'`,
      );
    expect(audit).toHaveLength(1);
  });

  it('warns once per scope and period when spend crosses 80%', async () => {
    const { id: brandId } = await seedBrand(t.db);
    const ctx = budgetCtx({ dailyUsd: 10, monthlyUsd: 100 });
    const notifier = new MockNotifier();
    const r = await reserveCost(t.db, ctx, reserveInput(brandId, null, 9));
    await finalizeCost(t.db, r.id, { costUsd: 8.5, model: 'm', estimated: false });

    const first = await checkBudgetWarnings(t.db, ctx, notifier, brandId, null);
    const second = await checkBudgetWarnings(t.db, ctx, notifier, brandId, null);
    expect(first.map((s) => s.scope)).toEqual(['day']);
    expect(second).toEqual([]);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.text).toMatch(/\$8\.50 из \$10\.00/);
  });

  it('stale reservations from crashed workers are released', async () => {
    const { id: brandId } = await seedBrand(t.db);
    const r = await reserveCost(t.db, budgetCtx(), reserveInput(brandId, null, 2));
    await t.db
      .update(schema.costRecords)
      .set({ createdAt: sql`now() - interval '2 hours'` })
      .where(sql`${schema.costRecords.id} = ${r.id}`);
    expect(await releaseStaleReservations(t.db, 3600)).toBeGreaterThanOrEqual(1);
    expect((await spentOf(brandId, null, 'month')).spentUsd).toBe(0);
  });
});

import { sql, schema, type DbOrTx } from '@cms/db';
import {
  BudgetExceededError,
  PermanentError,
  type Actor,
  type BudgetConfig,
  type BudgetScope,
  type Logger,
} from '@cms/core';
import type { Notifier } from '@cms/providers';
import { withIdempotency } from './idempotency.js';

const { costRecords, budgetOverrides, tasks, auditLog } = schema;

/** Calendar keys in the app time zone: { day: '2026-10-08', month: '2026-10' }. */
export function periodKeys(now: Date, timeZone: string): { day: string; month: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const month = `${get('year')}-${get('month')}`;
  return { day: `${month}-${get('day')}`, month };
}

export interface BudgetContext {
  config: BudgetConfig;
  timeZone: string;
  now?: () => Date;
}

export interface ScopeStatus {
  scope: BudgetScope;
  periodKey: string;
  spentUsd: number;
  limitUsd: number;
}

/** Reserved amounts count as spent until finalized or released. */
const spentExpr = sql<string>`coalesce(sum(case when ${costRecords.status} = 'reserved' then ${costRecords.reservedUsd} when ${costRecords.status} = 'final' then ${costRecords.costUsd} else 0 end), 0)`;

async function overridesSum(db: DbOrTx, brandId: string, scope: BudgetScope, periodKey: string) {
  const [row] = await db
    .select({ extra: sql<string>`coalesce(sum(${budgetOverrides.extraUsd}), 0)` })
    .from(budgetOverrides)
    .where(
      sql`${budgetOverrides.brandId} = ${brandId} and ${budgetOverrides.scope} = ${scope} and ${budgetOverrides.periodKey} = ${periodKey}`,
    );
  return Number(row!.extra);
}

/** Current spend and effective limits (base + human-approved overrides) for each scope. */
export async function budgetStatus(
  db: DbOrTx,
  ctx: BudgetContext,
  brandId: string,
  taskId: string | null,
): Promise<ScopeStatus[]> {
  const now = (ctx.now ?? (() => new Date()))();
  const { day, month } = periodKeys(now, ctx.timeZone);
  const tz = ctx.timeZone;

  const [agg] = await db
    .select({
      day: sql<string>`coalesce(sum(case when (${costRecords.createdAt} at time zone ${tz})::date = ${day}::date then (case when ${costRecords.status} = 'reserved' then ${costRecords.reservedUsd} when ${costRecords.status} = 'final' then ${costRecords.costUsd} else 0 end) else 0 end), 0)`,
      month: spentExpr,
    })
    .from(costRecords)
    .where(
      sql`${costRecords.brandId} = ${brandId} and to_char(${costRecords.createdAt} at time zone ${tz}, 'YYYY-MM') = ${month}`,
    );

  const result: ScopeStatus[] = [
    {
      scope: 'day',
      periodKey: day,
      spentUsd: Number(agg!.day),
      limitUsd: ctx.config.dailyUsd + (await overridesSum(db, brandId, 'day', day)),
    },
    {
      scope: 'month',
      periodKey: month,
      spentUsd: Number(agg!.month),
      limitUsd: ctx.config.monthlyUsd + (await overridesSum(db, brandId, 'month', month)),
    },
  ];

  if (taskId) {
    const [t] = await db
      .select({ budget: tasks.budgetUsd })
      .from(tasks)
      .where(sql`${tasks.id} = ${taskId}`);
    const [spent] = await db
      .select({ spent: spentExpr })
      .from(costRecords)
      .where(sql`${costRecords.taskId} = ${taskId}`);
    result.unshift({
      scope: 'task',
      periodKey: taskId,
      spentUsd: Number(spent!.spent),
      limitUsd:
        Number(t?.budget ?? ctx.config.taskUsd) + (await overridesSum(db, brandId, 'task', taskId)),
    });
  }
  return result;
}

export interface ReserveInput {
  brandId: string;
  taskId: string | null;
  runId: string | null;
  agent: string;
  kind: 'llm' | 'image';
  provider: string;
  model: string;
  estimateUsd: number;
  idempotencyKey: string;
}

/**
 * Reserves the worst-case cost of an external call before it is made. Serialised per
 * brand with an advisory lock, so parallel calls cannot jointly overshoot a limit.
 * Throws BudgetExceededError when spent + estimate would exceed any limit.
 * Re-reserving with the same idempotency key returns the existing reservation.
 */
export async function reserveCost(
  db: DbOrTx,
  ctx: BudgetContext,
  input: ReserveInput,
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'budget:' + input.brandId}))`);

    const [existing] = await tx
      .select({ id: costRecords.id })
      .from(costRecords)
      .where(sql`${costRecords.idempotencyKey} = ${input.idempotencyKey}`);
    if (existing) return existing;

    for (const s of await budgetStatus(tx, ctx, input.brandId, input.taskId)) {
      if (s.spentUsd + input.estimateUsd > s.limitUsd + 1e-9) {
        throw new BudgetExceededError(s.scope, s.limitUsd, s.spentUsd, input.estimateUsd);
      }
    }

    const [row] = await tx
      .insert(costRecords)
      .values({
        brandId: input.brandId,
        taskId: input.taskId,
        runId: input.runId,
        agent: input.agent,
        kind: input.kind,
        provider: input.provider,
        model: input.model,
        status: 'reserved',
        reservedUsd: input.estimateUsd.toFixed(8),
        idempotencyKey: input.idempotencyKey,
      })
      .returning({ id: costRecords.id });
    return row!;
  });
}

export interface FinalCost {
  /** Amount counted against budgets (already multiplied by the safety factor). */
  costUsd: number;
  /** Price-list cost without the safety factor; defaults to costUsd. */
  rawCostUsd?: number;
  model: string;
  estimated: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  units?: number;
}

/** Replaces the reservation with the actual cost reported by the provider. */
export async function finalizeCost(db: DbOrTx, id: string, cost: FinalCost): Promise<void> {
  await db
    .update(costRecords)
    .set({
      status: 'final',
      costUsd: cost.costUsd.toFixed(8),
      rawCostUsd: (cost.rawCostUsd ?? cost.costUsd).toFixed(8),
      model: cost.model,
      estimated: cost.estimated,
      inputTokens: cost.inputTokens ?? 0,
      outputTokens: cost.outputTokens ?? 0,
      cacheReadTokens: cost.cacheReadTokens ?? 0,
      cacheWriteTokens: cost.cacheWriteTokens ?? 0,
      units: cost.units ?? 0,
      finalizedAt: sql`now()`,
    })
    .where(sql`${costRecords.id} = ${id} and ${costRecords.status} = 'reserved'`);
}

/** The call failed before anything was billed: free the reservation. */
export async function releaseCost(db: DbOrTx, id: string): Promise<void> {
  await db
    .update(costRecords)
    .set({ status: 'released', finalizedAt: sql`now()` })
    .where(sql`${costRecords.id} = ${id} and ${costRecords.status} = 'reserved'`);
}

/** Reservations left behind by crashed workers stop blocking the budget after a while. */
export async function releaseStaleReservations(
  db: DbOrTx,
  olderThanSeconds: number,
): Promise<number> {
  const rows = await db
    .update(costRecords)
    .set({ status: 'released', finalizedAt: sql`now()` })
    .where(
      sql`${costRecords.status} = 'reserved' and ${costRecords.createdAt} < now() - make_interval(secs => ${olderThanSeconds})`,
    )
    .returning({ id: costRecords.id });
  return rows.length;
}

/**
 * Sends a one-time warning per scope and period once spend crosses warnRatio
 * (e.g. 80% of today's budget). Deduplicated through idempotency keys.
 */
export async function checkBudgetWarnings(
  db: DbOrTx,
  ctx: BudgetContext,
  notifier: Notifier,
  brandId: string,
  taskId: string | null,
  logger?: Logger,
): Promise<ScopeStatus[]> {
  const warned: ScopeStatus[] = [];
  for (const s of await budgetStatus(db, ctx, brandId, taskId)) {
    if (s.limitUsd <= 0 || s.spentUsd < s.limitUsd * ctx.config.warnRatio) continue;
    const pct = Math.round(ctx.config.warnRatio * 100);
    const key = `budget-warn:${brandId}:${s.scope}:${s.periodKey}:${pct}:${s.limitUsd.toFixed(2)}`;
    const { replayed } = await withIdempotency(db, key, async () => {
      await notifier.send({
        text: `Бюджет (${scopeLabel(s.scope)}): потрачено $${s.spentUsd.toFixed(2)} из $${s.limitUsd.toFixed(2)} — больше ${pct}%.`,
      });
      return { sentAt: new Date().toISOString() };
    });
    if (!replayed) {
      warned.push(s);
      logger?.warn({ brandId, taskId, budget: s }, 'budget warning threshold crossed');
    }
  }
  return warned;
}

export function scopeLabel(scope: BudgetScope): string {
  return scope === 'day' ? 'день' : scope === 'month' ? 'месяц' : 'задача';
}

/** A human approves extra budget for a scope/period. Only humans can do this. */
export async function approveBudgetOverride(
  db: DbOrTx,
  input: {
    brandId: string;
    scope: BudgetScope;
    periodKey: string;
    extraUsd: number;
    actor: Actor;
    taskId?: string;
  },
): Promise<void> {
  if (input.actor.kind !== 'human') {
    throw new PermanentError(
      'budget_override_requires_human',
      'Only a human can approve extra budget',
    );
  }
  if (!(input.extraUsd > 0))
    throw new PermanentError('invalid_amount', 'extraUsd must be positive');
  await db.transaction(async (tx) => {
    await tx.insert(budgetOverrides).values({
      brandId: input.brandId,
      scope: input.scope,
      periodKey: input.periodKey,
      extraUsd: input.extraUsd.toFixed(8),
      approvedBy: input.actor.id,
    });
    await tx.insert(auditLog).values({
      brandId: input.brandId,
      taskId: input.taskId ?? null,
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      action: 'budget_override_approved',
      details: { scope: input.scope, periodKey: input.periodKey, extraUsd: input.extraUsd },
    });
  });
}

import { sql, schema, type DbOrTx } from '@cms/db';
import { errorToJson, TransientError, type Logger } from '@cms/core';
import type { Notifier } from '@cms/providers';
import { releaseStaleReservations } from './budget.js';
import { withIdempotency } from './idempotency.js';
import { findStaleRuns, requeueRun } from './runs.js';
import { pauseTask } from './transitions.js';

const { tasks } = schema;

const SYSTEM = { kind: 'system', id: 'maintenance' } as const;

/**
 * Tasks waiting for a human decision get a reminder every `hours`. After the second
 * reminder the task is also flagged as paused (visible in the UI). Nothing is ever
 * approved automatically: leaving the gate requires a human (see task-status.ts).
 */
export async function remindStaleApprovals(
  db: DbOrTx,
  notifier: Notifier,
  hours: number,
  now: Date = new Date(),
): Promise<{ reminded: string[]; paused: string[] }> {
  const waiting = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      since: tasks.statusChangedAt,
      pausedAt: tasks.pausedAt,
    })
    .from(tasks)
    .where(
      sql`${tasks.status} in ('awaiting_plan_approval', 'awaiting_final_approval') and ${tasks.statusChangedAt} < ${now.toISOString()}::timestamptz - make_interval(hours => ${hours})`,
    );

  const reminded: string[] = [];
  const paused: string[] = [];
  for (const t of waiting) {
    const n = Math.floor((now.getTime() - t.since.getTime()) / (hours * 3_600_000));
    const gate = t.status === 'awaiting_plan_approval' ? 'план' : 'итоговый пакет';
    // One reminder per task, per waiting period, per N-hours step.
    const key = `remind:${t.id}:${t.since.toISOString()}:${n}`;
    const { replayed } = await withIdempotency(db, key, async () => {
      await notifier.send({
        text: `Напоминание: жду вашего решения по задаче «${t.title}» (${gate}) уже ${n * hours} ч.`,
      });
      return { n };
    });
    if (!replayed) reminded.push(t.id);
    if (n >= 2 && !t.pausedAt && (await pauseTask(db, t.id, 'approval_timeout', SYSTEM)))
      paused.push(t.id);
  }
  return { reminded, paused };
}

export interface MaintenanceDeps {
  db: DbOrTx;
  notifier: Notifier;
  logger: Logger;
  staleAfterSeconds: number;
  reservationTtlSeconds: number;
  approvalReminderHours: number;
  enqueue: (runId: string) => Promise<unknown>;
}

/** One maintenance pass: recover crashed runs, free stuck budget reservations, remind about gates. */
export async function runMaintenance(deps: MaintenanceDeps): Promise<void> {
  for (const run of await findStaleRuns(deps.db, deps.staleAfterSeconds)) {
    await requeueRun(
      deps.db,
      run.id,
      new TransientError('stale_run', 'worker stopped sending heartbeats'),
    );
    await deps.enqueue(run.id);
    deps.logger.warn({ runId: run.id, taskId: run.taskId }, 'stale run re-queued');
  }
  const released = await releaseStaleReservations(deps.db, deps.reservationTtlSeconds);
  if (released > 0) deps.logger.warn({ released }, 'released stale budget reservations');
  try {
    await remindStaleApprovals(deps.db, deps.notifier, deps.approvalReminderHours);
  } catch (err) {
    deps.logger.error({ err: errorToJson(err) }, 'approval reminders failed');
  }
}

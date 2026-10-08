import { schema, type DbOrTx, sql } from '@cms/db';
import { PgBoss } from 'pg-boss';
import {
  BudgetExceededError,
  PermanentError,
  errorToJson,
  isRetryable,
  type AppConfig,
  type Logger,
} from '@cms/core';
import type { Notifier, NotifierButton } from '@cms/providers';
import { scopeLabel } from './budget.js';
import {
  claimRun,
  completeRun,
  failRun,
  getRun,
  heartbeatRun,
  requeueRun,
  type Run,
} from './runs.js';
import { pauseTask, transitionTask } from './transitions.js';

const { tasks } = schema;

export const QUEUE_RUNS = 'agent-runs';
export const QUEUE_RUNS_DEAD = 'agent-runs-dead';
export const QUEUE_MAINTENANCE = 'maintenance';

const SYSTEM = { kind: 'system', id: 'queue' } as const;

export interface RunContext {
  /** Aborted when the job times out or the worker shuts down. Pass it to LLM calls. */
  signal: AbortSignal;
  heartbeat: () => Promise<void>;
  logger: Logger;
}

export type RunHandler = (run: Run, ctx: RunContext) => Promise<Record<string, unknown>>;

export interface RunDeps {
  db: DbOrTx;
  notifier: Notifier;
  logger: Logger;
  staleAfterSeconds: number;
  /** Buttons for the budget-pause message (e.g. "+$1 and continue"); provided by the UI layer. */
  pauseButtons?: (taskId: string) => NotifierButton[][];
}

export type RunOutcome = 'succeeded' | 'skipped' | 'paused' | 'failed' | 'retry';

/**
 * Executes one delivery of a run job. Safe to call more than once for the same run:
 * claiming is atomic, finished runs are skipped.
 *  - success            -> run succeeded
 *  - BudgetExceeded     -> run back to queued, task paused, human notified (no retry)
 *  - transient error    -> run back to queued, error rethrown so the queue retries with backoff
 *  - permanent error    -> run failed, task failed, human notified (no retry)
 */
export async function processRun(
  deps: RunDeps,
  runId: string,
  handler: RunHandler,
  signal: AbortSignal,
): Promise<RunOutcome> {
  const { db, logger } = deps;
  const run = await claimRun(db, runId, deps.staleAfterSeconds);
  if (!run) {
    logger.info(
      { runId },
      'run not claimable (finished or running elsewhere); skipping duplicate delivery',
    );
    return 'skipped';
  }
  const log = logger.child({ runId, taskId: run.taskId, agent: run.agent, attempt: run.attempt });

  const [task] = await db
    .select({ pausedAt: tasks.pausedAt })
    .from(tasks)
    .where(sql`${tasks.id} = ${run.taskId}`);
  if (task?.pausedAt) {
    await requeueRun(db, run.id, new Error('task is paused'));
    log.info('task is paused; run left queued');
    return 'paused';
  }

  const beat = setInterval(
    () =>
      void heartbeatRun(db, run.id).catch((e: unknown) =>
        log.warn({ err: errorToJson(e) }, 'heartbeat failed'),
      ),
    Math.max(1_000, Math.floor((deps.staleAfterSeconds * 1000) / 3)),
  );
  try {
    const output = await handler(run, {
      signal,
      heartbeat: () => heartbeatRun(db, run.id),
      logger: log,
    });
    await completeRun(db, run.id, output);
    log.info('run succeeded');
    return 'succeeded';
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await requeueRun(db, run.id, err);
      const paused = await pauseTask(db, run.taskId, `budget:${err.scope}`, SYSTEM);
      if (paused) {
        await deps.notifier.send({
          text:
            `Задача на паузе: исчерпан бюджет (${scopeLabel(err.scope)}). ` +
            `Лимит $${err.limitUsd.toFixed(2)}, потрачено $${err.spentUsd.toFixed(2)}, ` +
            `нужно ещё до $${err.requestedUsd.toFixed(2)}. Продолжу только после вашего подтверждения.`,
          ...(deps.pauseButtons ? { buttons: deps.pauseButtons(run.taskId) } : {}),
        });
      }
      log.warn({ err: errorToJson(err) }, 'run paused: budget exceeded');
      return 'paused';
    }
    if (isRetryable(err)) {
      await requeueRun(db, run.id, err);
      log.warn({ err: errorToJson(err) }, 'run failed with a transient error; will retry');
      throw err;
    }
    await failRun(db, run.id, err);
    await failTask(deps, run, err, false);
    log.error({ err: errorToJson(err) }, 'run failed permanently');
    return 'failed';
  } finally {
    clearInterval(beat);
  }
}

/** Called for jobs that exhausted their retries (dead-letter queue). */
export async function processDeadRun(deps: RunDeps, runId: string): Promise<void> {
  const run = await getRun(deps.db, runId);
  if (!run || run.status === 'succeeded' || run.status === 'dead') return;
  const lastError = (run.error as Record<string, unknown> | null) ?? { message: 'unknown error' };
  const err = new PermanentError(
    'retries_exhausted',
    `Retries exhausted. Last error: ${String(lastError.message)}`,
    { lastError },
  );
  await failRun(deps.db, run.id, err, true);
  await failTask(deps, run, err, true);
  deps.logger.error({ runId, taskId: run.taskId, err }, 'run moved to dead letter');
}

async function failTask(deps: RunDeps, run: Run, err: unknown, dead: boolean) {
  const info = errorToJson(err);
  try {
    await transitionTask(deps.db, {
      taskId: run.taskId,
      to: 'failed',
      actor: SYSTEM,
      reason: dead ? 'run_dead' : 'run_failed',
      details: { runId: run.id, agent: run.agent, error: info },
    });
  } catch (e) {
    deps.logger.warn({ err: errorToJson(e), runId: run.id }, 'could not move task to failed');
  }
  await deps.notifier.send({
    text: `Ошибка: агент ${run.agent} не справился${dead ? ' после всех повторов' : ''}. Причина: ${String(info.message)}`,
  });
}

export interface QueueOptions {
  config: AppConfig;
  deps: RunDeps;
}

/** pg-boss wrapper: one queue for agent runs with retries/backoff and a dead-letter queue. */
export class RunQueue {
  private constructor(
    private readonly boss: PgBoss,
    private readonly opts: QueueOptions,
  ) {}

  static async start(opts: QueueOptions): Promise<RunQueue> {
    const { db: dbCfg, queue } = opts.config;
    const boss = new PgBoss({
      host: dbCfg.host,
      port: dbCfg.port,
      user: dbCfg.user,
      password: dbCfg.password,
      database: dbCfg.database,
      schema: 'pgboss',
      max: 5,
    });
    boss.on('error', (err: unknown) =>
      opts.deps.logger.error({ err: errorToJson(err) }, 'pg-boss error'),
    );
    await boss.start();
    await boss.createQueue(QUEUE_RUNS_DEAD, { retryLimit: 0 });
    await boss.createQueue(QUEUE_RUNS, {
      retryLimit: queue.retryLimit,
      retryDelay: queue.retryDelaySeconds,
      retryBackoff: true,
      expireInSeconds: queue.jobTimeoutSeconds,
      deadLetter: QUEUE_RUNS_DEAD,
    });
    await boss.createQueue(QUEUE_MAINTENANCE, { retryLimit: 0, policy: 'singleton' });
    return new RunQueue(boss, opts);
  }

  /** singletonKey = runId: enqueueing the same run twice while queued creates one job. */
  async enqueue(runId: string): Promise<string | null> {
    return this.boss.send(QUEUE_RUNS, { runId }, { singletonKey: runId });
  }

  async work(handler: RunHandler, opts: { pollingIntervalSeconds?: number } = {}): Promise<void> {
    const polling = { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 };
    await this.boss.work<{ runId: string }>(QUEUE_RUNS, polling, async ([job]) => {
      if (!job) return;
      await processRun(this.opts.deps, job.data.runId, handler, job.signal);
    });
    await this.boss.work<{ runId: string }>(QUEUE_RUNS_DEAD, polling, async ([job]) => {
      if (!job) return;
      await processDeadRun(this.opts.deps, job.data.runId);
    });
  }

  /** Periodic maintenance (stale runs, reminders) on a cron schedule. */
  async scheduleMaintenance(cron: string, fn: () => Promise<void>): Promise<void> {
    await this.boss.schedule(QUEUE_MAINTENANCE, cron, null, { tz: this.opts.config.timezone });
    await this.boss.work(QUEUE_MAINTENANCE, async () => fn());
  }

  get pgBoss(): PgBoss {
    return this.boss;
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}

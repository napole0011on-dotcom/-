import { sql, schema, type DbOrTx } from '@cms/db';
import { errorToJson } from '@cms/core';

const { runs } = schema;

export type Run = typeof runs.$inferSelect;

export interface CreateRunInput {
  brandId: string;
  taskId: string;
  agent: string;
  /** Same key => same run. E.g. `task:<id>:copywriter:v1`. */
  idempotencyKey: string;
  input?: Record<string, unknown>;
}

/** Creates a run once per idempotency key; a repeated call returns the existing run. */
export async function createRun(
  db: DbOrTx,
  input: CreateRunInput,
): Promise<{ run: Run; created: boolean }> {
  const [inserted] = await db
    .insert(runs)
    .values({
      brandId: input.brandId,
      taskId: input.taskId,
      agent: input.agent,
      idempotencyKey: input.idempotencyKey,
      input: input.input ?? {},
    })
    .onConflictDoNothing({ target: runs.idempotencyKey })
    .returning();
  if (inserted) return { run: inserted, created: true };
  const [existing] = await db
    .select()
    .from(runs)
    .where(sql`${runs.idempotencyKey} = ${input.idempotencyKey}`);
  return { run: existing!, created: false };
}

export async function getRun(db: DbOrTx, id: string): Promise<Run | undefined> {
  const [row] = await db
    .select()
    .from(runs)
    .where(sql`${runs.id} = ${id}`);
  return row;
}

/**
 * Atomically takes a run for execution. Succeeds when the run is queued, or when it is
 * "running" but its worker stopped sending heartbeats (crashed). Returns null when the
 * run is finished or actively running elsewhere — the duplicate delivery is skipped.
 */
export async function claimRun(
  db: DbOrTx,
  id: string,
  staleAfterSeconds: number,
): Promise<Run | null> {
  const [row] = await db
    .update(runs)
    .set({
      status: 'running',
      waitingFor: null,
      attempt: sql`${runs.attempt} + 1`,
      startedAt: sql`coalesce(${runs.startedAt}, now())`,
      heartbeatAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      sql`${runs.id} = ${id} and (${runs.status} = 'queued' or (${runs.status} = 'running' and ${runs.heartbeatAt} < now() - make_interval(secs => ${staleAfterSeconds})))`,
    )
    .returning();
  return row ?? null;
}

export async function heartbeatRun(db: DbOrTx, id: string): Promise<void> {
  await db
    .update(runs)
    .set({ heartbeatAt: sql`now()` })
    .where(sql`${runs.id} = ${id} and ${runs.status} = 'running'`);
}

export async function completeRun(
  db: DbOrTx,
  id: string,
  output: Record<string, unknown>,
): Promise<void> {
  await db
    .update(runs)
    .set({
      status: 'succeeded',
      output,
      error: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(sql`${runs.id} = ${id} and ${runs.status} = 'running'`);
}

/** Transient failure or pause: back to the queue state so a later delivery can claim it. */
export async function requeueRun(db: DbOrTx, id: string, err: unknown): Promise<void> {
  await db
    .update(runs)
    .set({ status: 'queued', error: errorToJson(err), updatedAt: sql`now()` })
    .where(sql`${runs.id} = ${id} and ${runs.status} in ('running', 'queued')`);
}

/**
 * The run may not start now (its agent is paused/disabled, or everything is stopped): back to
 * the queue without counting an attempt, marked with what it waits for. It does not fail and
 * is not retried by the queue; releaseWaitingRuns() delivers it again after "resume".
 */
export async function holdRun(db: DbOrTx, id: string, waitingFor: string): Promise<void> {
  await db
    .update(runs)
    .set({
      status: 'queued',
      waitingFor,
      attempt: sql`greatest(${runs.attempt} - 1, 0)`,
      startedAt: null,
      heartbeatAt: null,
      updatedAt: sql`now()`,
    })
    .where(sql`${runs.id} = ${id} and ${runs.status} = 'running'`);
}

/**
 * Re-delivers every held run (after "resume"; also periodically by maintenance as a safety
 * net). A run whose agent is still paused is simply held again.
 */
export async function releaseWaitingRuns(
  db: DbOrTx,
  enqueue: (runId: string) => Promise<unknown>,
): Promise<number> {
  const held = await db
    .select({ id: runs.id })
    .from(runs)
    .where(sql`${runs.status} = 'queued' and ${runs.waitingFor} is not null`)
    .orderBy(runs.createdAt);
  for (const r of held) await enqueue(r.id);
  return held.length;
}

export async function failRun(db: DbOrTx, id: string, err: unknown, dead = false): Promise<void> {
  await db
    .update(runs)
    .set({
      status: dead ? 'dead' : 'failed',
      error: errorToJson(err),
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(sql`${runs.id} = ${id} and ${runs.status} in ('queued', 'running')`);
}

/** Runs whose worker vanished (no heartbeat): returned to the queue by the maintenance job. */
export async function findStaleRuns(db: DbOrTx, staleAfterSeconds: number): Promise<Run[]> {
  return db
    .select()
    .from(runs)
    .where(
      sql`${runs.status} = 'running' and ${runs.heartbeatAt} < now() - make_interval(secs => ${staleAfterSeconds})`,
    );
}

/** Queued runs of a task (used after a paused task is resumed). */
export async function queuedRunsOfTask(db: DbOrTx, taskId: string): Promise<Run[]> {
  return db
    .select()
    .from(runs)
    .where(sql`${runs.taskId} = ${taskId} and ${runs.status} = 'queued'`);
}

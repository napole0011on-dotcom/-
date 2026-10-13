import type { Logger } from '@cms/core';
import { errorToJson } from '@cms/core';
import { schema, sql, type DbOrTx } from '@cms/db';

const { workerHeartbeats } = schema;

/** The queue worker beats this often; the panel calls it dead after WORKER_DEAD_AFTER_MS. */
export const WORKER_BEAT_MS = 10_000;
export const WORKER_DEAD_AFTER_MS = 35_000;

/**
 * The queue worker (the bot process) writes a heartbeat to the DB so the panel can tell the
 * owner when nobody runs tasks («Воркер не запущен»). Returns stop().
 */
export function startWorkerHeartbeat(
  db: DbOrTx,
  logger: Logger,
  worker = 'bot',
  everyMs = WORKER_BEAT_MS,
): () => Promise<void> {
  const startedAt = new Date();
  const beat = async () => {
    try {
      await db
        .insert(workerHeartbeats)
        .values({ worker, pid: process.pid, startedAt, beatAt: new Date() })
        .onConflictDoUpdate({
          target: workerHeartbeats.worker,
          set: { pid: process.pid, startedAt, beatAt: sql`now()` },
        });
    } catch (err) {
      logger.warn({ err: errorToJson(err) }, 'worker heartbeat failed');
    }
  };
  void beat();
  const t = setInterval(() => void beat(), everyMs);
  return async () => {
    clearInterval(t);
    // A clean stop: the panel shows «не запущен» right away instead of after the timeout.
    await db
      .delete(workerHeartbeats)
      .where(sql`${workerHeartbeats.worker} = ${worker} and ${workerHeartbeats.pid} = ${process.pid}`)
      .catch(() => undefined);
  };
}

export interface WorkerStatus {
  alive: boolean;
  /** Last beat (null: never started or stopped cleanly). */
  beatAt: Date | null;
  startedAt: Date | null;
}

export async function workerStatus(db: DbOrTx, worker = 'bot'): Promise<WorkerStatus> {
  const [r] = await db
    .select()
    .from(workerHeartbeats)
    .where(sql`${workerHeartbeats.worker} = ${worker}`);
  if (!r) return { alive: false, beatAt: null, startedAt: null };
  return {
    alive: Date.now() - r.beatAt.getTime() < WORKER_DEAD_AFTER_MS,
    beatAt: r.beatAt,
    startedAt: r.startedAt,
  };
}

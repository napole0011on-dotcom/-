import { sql, schema, type DbOrTx } from '@cms/db';
import { TransientError } from '@cms/core';

const { idempotencyKeys } = schema;

export interface IdempotentResult<T> {
  result: T;
  /** True when the stored result of an earlier execution was returned. */
  replayed: boolean;
}

/**
 * Runs `fn` at most once per key (for side effects outside our DB transaction: LLM
 * calls, notifications, exports). The result must be JSON-serialisable.
 *
 *  - first caller: runs fn, stores the result;
 *  - later callers: get the stored result without running fn;
 *  - concurrent caller while the first is still running: TransientError (retry later);
 *  - if fn throws, the key is released so a retry can run it again;
 *  - if the owner crashed, the key is taken over after the lease expires.
 */
export async function withIdempotency<T>(
  db: DbOrTx,
  key: string,
  fn: () => Promise<T>,
  opts: { leaseSeconds?: number } = {},
): Promise<IdempotentResult<T>> {
  const lease = opts.leaseSeconds ?? 900;

  const inserted = await db
    .insert(idempotencyKeys)
    .values({
      key,
      status: 'in_progress',
      lockedUntil: sql`now() + make_interval(secs => ${lease})`,
    })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });

  if (inserted.length === 0) {
    const [row] = await db
      .select()
      .from(idempotencyKeys)
      .where(sql`${idempotencyKeys.key} = ${key}`);
    if (row?.status === 'completed') return { result: row.result as T, replayed: true };

    // Try to take over an expired lease.
    const taken = await db
      .update(idempotencyKeys)
      .set({ lockedUntil: sql`now() + make_interval(secs => ${lease})` })
      .where(
        sql`${idempotencyKeys.key} = ${key} and ${idempotencyKeys.status} = 'in_progress' and ${idempotencyKeys.lockedUntil} < now()`,
      )
      .returning({ key: idempotencyKeys.key });
    if (taken.length === 0) {
      throw new TransientError('idempotency_in_progress', `Operation ${key} is already running`, {
        key,
      });
    }
  }

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await db.delete(idempotencyKeys).where(sql`${idempotencyKeys.key} = ${key}`);
    throw err;
  }
  await db
    .update(idempotencyKeys)
    .set({
      status: 'completed',
      result: result ?? null,
      completedAt: sql`now()`,
      lockedUntil: null,
    })
    .where(sql`${idempotencyKeys.key} = ${key}`);
  return { result, replayed: false };
}

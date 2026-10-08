import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TransientError } from '@cms/core';
import { schema, sql } from '@cms/db';
import { withIdempotency } from './idempotency.js';
import { setupTestDb, type TestDb } from './testkit.js';

describe('withIdempotency (Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());

  it('runs the side effect once and replays the stored result', async () => {
    let calls = 0;
    const fn = () => Promise.resolve({ n: ++calls });
    const a = await withIdempotency(t.db, 'k1', fn);
    const b = await withIdempotency(t.db, 'k1', fn);
    expect(a).toEqual({ result: { n: 1 }, replayed: false });
    expect(b).toEqual({ result: { n: 1 }, replayed: true });
    expect(calls).toBe(1);
  });

  it('a concurrent duplicate while the first is running gets a transient error', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const first = withIdempotency(t.db, 'k2', async () => {
      calls++;
      await gate;
      return 'done';
    });
    await new Promise((r) => setTimeout(r, 50));
    await expect(withIdempotency(t.db, 'k2', () => Promise.resolve('dup'))).rejects.toBeInstanceOf(
      TransientError,
    );
    release();
    expect((await first).result).toBe('done');
    expect(calls).toBe(1);
  });

  it('many parallel callers: the side effect still happens once', async () => {
    let calls = 0;
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        withIdempotency(t.db, 'k3', async () => {
          calls++;
          await new Promise((r) => setTimeout(r, 30));
          return calls;
        }),
      ),
    );
    expect(calls).toBe(1);
    // Late callers get the stored result; callers that overlapped get a retryable error.
    for (const s of settled) {
      if (s.status === 'fulfilled') expect(s.value.result).toBe(1);
      else expect(s.reason).toBeInstanceOf(TransientError);
    }
    expect(settled.filter((s) => s.status === 'fulfilled' && !s.value.replayed)).toHaveLength(1);
  });

  it('a failed attempt releases the key so a retry can run', async () => {
    await expect(
      withIdempotency(t.db, 'k4', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(await withIdempotency(t.db, 'k4', () => Promise.resolve(42))).toEqual({
      result: 42,
      replayed: false,
    });
  });

  it('takes over a key whose owner crashed (lease expired)', async () => {
    await t.db.insert(schema.idempotencyKeys).values({
      key: 'k5',
      status: 'in_progress',
      lockedUntil: sql`now() - interval '1 second'`,
    });
    expect(await withIdempotency(t.db, 'k5', () => Promise.resolve('recovered'))).toEqual({
      result: 'recovered',
      replayed: false,
    });
  });
});

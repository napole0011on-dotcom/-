import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, sql } from '@cms/db';
import { startWorkerHeartbeat, workerStatus } from './heartbeat.js';
import { setupTestDb, silentLogger, type TestDb } from './testkit.js';

describe('worker heartbeat (Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => t?.close());

  it('no worker -> not alive; beats -> alive; silent > 35 s -> dead; clean stop -> gone', async () => {
    expect(await workerStatus(t.db, 'w1')).toEqual({
      alive: false,
      beatAt: null,
      startedAt: null,
    });
    const stop = startWorkerHeartbeat(t.db, silentLogger, 'w1', 20);
    await new Promise((r) => setTimeout(r, 80));
    const live = await workerStatus(t.db, 'w1');
    expect(live.alive).toBe(true);
    expect(live.beatAt).toBeInstanceOf(Date);

    // The process hangs or was killed: the last beat gets old.
    await stop();
    await t.db.insert(schema.workerHeartbeats).values({
      worker: 'w1',
      pid: 1,
      startedAt: sql`now()`,
      beatAt: sql`now() - interval '40 seconds'`,
    });
    expect((await workerStatus(t.db, 'w1')).alive).toBe(false);

    // Started again: the row is taken over, alive at once.
    const again = startWorkerHeartbeat(t.db, silentLogger, 'w1', 20);
    await new Promise((r) => setTimeout(r, 50));
    expect((await workerStatus(t.db, 'w1')).alive).toBe(true);
    await again();
    expect((await workerStatus(t.db, 'w1')).beatAt).toBeNull();
  });
});

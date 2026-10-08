import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from './client.js';
import { migrateDown, migrateUp, migrationStatus } from './migrator.js';
import { createTempDatabase } from './testing.js';

describe('migrations against real Postgres', () => {
  let pool: pg.Pool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const tmp = await createTempDatabase();
    drop = tmp.drop;
    pool = createPool(tmp.config.db, { max: 2 });
  });

  afterAll(async () => {
    await pool?.end();
    await drop?.();
  });

  const tableExists = async (name: string) =>
    (await pool.query<{ t: string | null }>('SELECT to_regclass($1) AS t', [name])).rows[0]!.t !==
    null;

  it('applies, is idempotent, rolls back and re-applies', async () => {
    const client = await pool.connect();
    try {
      const first = await migrateUp(client);
      expect(first).toContain('0000_init');
      expect(await tableExists('brands')).toBe(true);

      expect(await migrateUp(client)).toEqual([]);

      const status = await migrationStatus(client);
      expect(status.every((s) => s.applied)).toBe(true);

      const all = status.length;
      expect(await migrateDown(client, all)).toHaveLength(all);
      expect(await tableExists('brands')).toBe(false);

      expect(await migrateUp(client)).toHaveLength(all);
      expect(await tableExists('brands')).toBe(true);
    } finally {
      client.release();
    }
  });

  it('detects an applied migration that was edited afterwards', async () => {
    const client = await pool.connect();
    try {
      await client.query("UPDATE _migrations SET checksum = 'tampered' WHERE name = '0000_init'");
      await expect(migrateUp(client)).rejects.toThrow(/modified after being applied/);
    } finally {
      client.release();
    }
  });
});

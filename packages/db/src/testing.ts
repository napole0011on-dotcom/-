import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadConfig, loadDotEnv, type AppConfig } from '@cms/core';

/**
 * Integration-test helper: creates a throwaway database next to POSTGRES_DB so tests
 * never touch real data, and drops it afterwards.
 */
export async function createTempDatabase(): Promise<{
  config: AppConfig;
  drop: () => Promise<void>;
}> {
  loadDotEnv();
  const base = loadConfig();
  const name = `test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ ...base.db, database: base.db.database });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const config: AppConfig = { ...base, db: { ...base.db, database: name } };
  return {
    config,
    drop: async () => {
      const c = new pg.Client({ ...base.db });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}

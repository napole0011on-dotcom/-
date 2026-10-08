import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { AppConfig } from '@cms/core';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle; accepted wherever a Db is, so helpers compose inside transactions. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | DbTx;

export function createPool(db: AppConfig['db'], opts: { max?: number } = {}): pg.Pool {
  return new pg.Pool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    max: opts.max ?? 10,
    connectionTimeoutMillis: 5_000,
  });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}

/** Cheap liveness probe used by /health. */
export async function pingDb(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}

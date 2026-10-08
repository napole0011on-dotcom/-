import { ConfigError, loadConfig, loadDotEnv } from '@cms/core';
import { createPool } from './client.js';
import { migrateDown, migrateUp, migrationStatus } from './migrator.js';

// Usage: cli.ts up | down [--steps N] | status
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  loadDotEnv();
  const config = loadConfig();
  const pool = createPool(config.db, { max: 1 });
  const client = await pool.connect();
  try {
    if (command === 'up') {
      const applied = await migrateUp(client);
      console.log(
        applied.length ? `applied: ${applied.join(', ')}` : 'up to date, nothing to apply',
      );
    } else if (command === 'down') {
      const i = rest.indexOf('--steps');
      const steps = i >= 0 ? Number(rest[i + 1]) : 1;
      const rolled = await migrateDown(client, steps);
      console.log(rolled.length ? `rolled back: ${rolled.join(', ')}` : 'nothing to roll back');
    } else if (command === 'status') {
      for (const m of await migrationStatus(client)) {
        console.log(
          `${m.applied ? '[x]' : '[ ]'} ${m.name}${m.appliedAt ? `  ${m.appliedAt.toISOString()}` : ''}`,
        );
      }
    } else {
      console.error('usage: cli up | down [--steps N] | status');
      process.exitCode = 2;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? `migration failed: ${err.message}` : err);
  }
  process.exitCode = 1;
});

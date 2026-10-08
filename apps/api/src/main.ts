import { ConfigError, createLogger, describeConfig, loadConfig, loadDotEnv } from '@cms/core';
import { createPool, pingDb } from '@cms/db';
import { createProviders, createStorage } from '@cms/providers';
import { buildServer } from './server.js';

async function main() {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Plain stderr: the logger is not configured yet, and this message is for a human.
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({ level: config.logLevel, name: 'api' });
  logger.info({ config: describeConfig(config) }, 'starting');

  const pool = createPool(config.db);
  const storage = createStorage(config.storage);
  createProviders(config); // fail fast on unsupported provider configuration

  const app = buildServer({
    logger,
    checks: { db: () => pingDb(pool), storage: () => storage.healthCheck() },
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.api.host, port: config.api.port });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

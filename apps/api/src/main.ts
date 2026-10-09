import path from 'node:path';
import {
  ConfigError,
  createLogger,
  describeConfig,
  findRepoRoot,
  loadConfig,
  loadDotEnv,
  loadPricing,
  requirePanel,
} from '@cms/core';
import { createDb, createPool, migrationStatus, pingDb } from '@cms/db';
import { LlmClient, RunQueue, createLlmTransport } from '@cms/engine';
import { createProviders, createStorage } from '@cms/providers';
import {
  MockLlmTransport,
  Workflow,
  loadBrandProfileFile,
  syncPromptFiles,
  upsertBrand,
  type OwnerChannel,
} from '@cms/agents';
import { createMirror } from './panel/mirror.js';
import { registerPanel } from './panel/routes.js';
import { registerStatic } from './panel/static.js';
import { buildServer } from './server.js';

/** The API never runs agents: actions enqueue runs, the bot process executes them. */
const noChannel: OwnerChannel = {
  name: 'none',
  send: () => Promise.resolve({ messageId: 'none' }),
  sendPlan: () => Promise.resolve(),
  sendPackage: () => Promise.resolve(),
  sendExport: () => Promise.resolve(),
};

async function main() {
  loadDotEnv();
  let config;
  let panel;
  try {
    config = loadConfig();
    panel = requirePanel(config);
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
  const db = createDb(pool);
  const client = await pool.connect();
  try {
    const pending = (await migrationStatus(client)).filter((m) => !m.applied);
    if (pending.length)
      throw new Error(
        `Database is not migrated (${pending.map((m) => m.name).join(', ')}). Run: pnpm db:migrate`,
      );
  } finally {
    client.release();
  }
  const storage = createStorage(config.storage);
  createProviders(config); // fail fast on unsupported provider configuration

  const pricing = loadPricing(config.llm.pricingFile);
  const { brand } = await upsertBrand(db, loadBrandProfileFile(config.brandProfileFile));
  const promptSync = await syncPromptFiles(db, brand.id);
  if (promptSync.length) logger.info({ prompts: promptSync }, 'prompt files synced');
  const budget = { config: config.budget, timeZone: config.timezone };
  const queue = await RunQueue.start({
    config,
    deps: { db, notifier: noChannel, logger, staleAfterSeconds: config.queue.runStaleAfterSeconds },
  });
  const transport =
    config.llm.provider === 'mock' ? new MockLlmTransport() : createLlmTransport(config.llm);
  const llm = new LlmClient({
    db,
    transport,
    pricing,
    config: config.llm,
    budget,
    notifier: noChannel,
    logger,
  });
  const workflow = new Workflow({
    db,
    llm,
    channel: noChannel,
    enqueue: (id) => queue.enqueue(id),
    config,
    pricing,
    logger,
  });

  const app = buildServer({
    logger,
    checks: { db: () => pingDb(pool), storage: () => storage.healthCheck() },
  });
  const port = config.api.port;
  await registerPanel(app, {
    db,
    config,
    pricing,
    budget,
    brandId: () => brand.id,
    workflow,
    panel: { ...config.panel, passwordHash: panel.passwordHash },
    mirror: createMirror(config.telegram.botToken, config.telegram.ownerId),
    logger,
    allowedOrigins: [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ],
  });
  const served = await registerStatic(app, path.join(findRepoRoot(), 'apps', 'web', 'dist'));

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await app.close();
    await queue.stop();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.api.host, port });
  logger.info(
    {
      url: `http://${config.api.host}:${port}`,
      panel: served
        ? 'built panel served'
        : 'run pnpm dev:web for the panel (http://127.0.0.1:5173)',
    },
    'panel API ready',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

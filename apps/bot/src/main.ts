import {
  ConfigError,
  createLogger,
  describeConfig,
  loadConfig,
  loadDotEnv,
  loadPricing,
  requireTelegram,
} from '@cms/core';
import { Api } from 'grammy';
import { createDb, createPool, migrationStatus } from '@cms/db';
import { LlmClient, RunQueue, createLlmTransport, runMaintenance } from '@cms/engine';
import { MockLlmTransport, Workflow, loadBrandProfileFile, upsertBrand } from '@cms/agents';
import { makeActions } from './actions.js';
import { createBot } from './bot.js';
import { cb } from './callbacks.js';
import { describeLlmSetup } from './status.js';
import { TelegramChannel } from './telegram-channel.js';

/**
 * One process for local use: Telegram bot (long polling) + queue worker + maintenance.
 */
async function main() {
  loadDotEnv();
  let config;
  let telegram;
  try {
    config = loadConfig();
    telegram = requireTelegram(config);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const logger = createLogger({ level: config.logLevel, name: 'bot' });
  logger.info({ config: describeConfig(config) }, 'starting');

  const pool = createPool(config.db);
  const db = createDb(pool);
  const client = await pool.connect();
  try {
    const pendingMigrations = (await migrationStatus(client)).filter((m) => !m.applied);
    if (pendingMigrations.length) {
      throw new Error(
        `Database is not migrated (${pendingMigrations.map((m) => m.name).join(', ')}). Run: pnpm db:migrate`,
      );
    }
  } finally {
    client.release();
  }

  const pricing = loadPricing(config.llm.pricingFile);
  const { brand } = await upsertBrand(db, loadBrandProfileFile(config.brandProfileFile));
  let brandId = brand.id;

  const transport =
    config.llm.provider === 'mock' ? new MockLlmTransport() : createLlmTransport(config.llm);
  const queueRef: { q?: RunQueue } = {};
  const enqueue = (id: string) => queueRef.q!.enqueue(id);

  // The channel talks to Telegram through a plain Api client; the polling Bot is created below.
  const api = new Api(telegram.botToken);
  const channel = new TelegramChannel(api, telegram.ownerId);
  const budget = { config: config.budget, timeZone: config.timezone };
  const llm = new LlmClient({
    db,
    transport,
    pricing,
    config: config.llm,
    budget,
    notifier: channel,
    logger,
  });
  const workflow = new Workflow({ db, llm, channel, enqueue, config, pricing, logger });

  const queue = await RunQueue.start({
    config,
    deps: {
      db,
      notifier: channel,
      logger,
      staleAfterSeconds: config.queue.runStaleAfterSeconds,
      pauseButtons: (taskId) => [
        [
          { text: '+$1 и продолжить', data: cb.budget(1, taskId) },
          { text: '+$5 и продолжить', data: cb.budget(5, taskId) },
        ],
        [{ text: '✖️ Отменить задачу', data: cb.task('no', taskId) }],
      ],
    },
  });
  queueRef.q = queue;
  await queue.work(workflow.handleRun);
  await queue.scheduleMaintenance('*/5 * * * *', () =>
    runMaintenance({
      db,
      notifier: channel,
      logger,
      staleAfterSeconds: config.queue.runStaleAfterSeconds,
      reservationTtlSeconds: config.queue.jobTimeoutSeconds * 2,
      approvalReminderHours: config.approvalReminderHours,
      enqueue,
    }),
  );

  const actions = makeActions({
    db,
    workflow,
    brandId: () => brandId,
    setBrandId: (id) => (brandId = id),
    brandFile: config.brandProfileFile,
    budget,
    logger,
    llm: { provider: config.llm.provider, costSafetyFactor: config.llm.costSafetyFactor },
  });
  const bot = createBot(telegram.botToken, telegram.ownerId, actions, logger);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await bot.stop();
    await queue.stop();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await channel.send({
    text: [
      '✅ Бот запущен.',
      describeLlmSetup(config, pricing),
      `Бренд: ${brand.name}, профиль v${brand.profileVersion}.`,
      `Лимиты бюджета: задача $${config.budget.taskUsd}, день $${config.budget.dailyUsd}, месяц $${config.budget.monthlyUsd}.`,
    ].join('\n'),
  });
  await bot.start({
    drop_pending_updates: false,
    onStart: (me) => logger.info({ bot: me.username }, 'bot polling started'),
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

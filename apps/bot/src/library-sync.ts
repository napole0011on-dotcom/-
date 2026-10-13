/**
 * pnpm library:sync — config/library/*.yaml -> the agent library of the brand from .env.
 * New files are added, changed files update their template (a new version); templates the
 * owner edited or deleted in the panel are left alone. Agents already on the board never
 * change: a template is only a source for new agents. The bot and the API do the same on start.
 */
import { createLogger, loadConfig, loadDotEnv } from '@cms/core';
import { createDb, createPool } from '@cms/db';
import { ensureWorkspace, loadBrandProfileFile, syncLibrary, upsertBrand } from '@cms/agents';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, name: 'library-sync' });
  const pool = createPool(config.db, { max: 2 });
  try {
    const db = createDb(pool);
    const { brand } = await upsertBrand(db, loadBrandProfileFile(config.brandProfileFile));
    await ensureWorkspace(db, brand.id);
    const r = await syncLibrary(db, brand.id);
    logger.info(r, 'library synced');
    const list = (xs: string[]) => (xs.length ? xs.join(', ') : '—');
    process.stdout.write(
      `Библиотека: добавлено ${r.added.length} (${list(r.added)}), обновлено ${r.updated.length} (${list(r.updated)}), ` +
        `оставлено как у вас ${r.skipped.length} (${list(r.skipped)}).\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `library:sync failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});

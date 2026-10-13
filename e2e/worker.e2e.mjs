// The worker is stopped (no `pnpm dev:bot`): every page says so in the header, and a task
// waiting in the queue longer than 30 s says why. Not in the default run — stop the bot first.
// Run: E2E_PASSWORD=... pnpm test:e2e worker
import { URL_BASE, api, assert, ensureAgents, openPanel } from './helpers.mjs';

const { browser, page, errors } = await openPanel();
try {
  const banner = page.getByRole('alert').filter({ hasText: 'Воркер не запущен' });
  await banner.waitFor({ timeout: 60_000 });
  assert(
    /задачи не будут выполняться\. Запустите pnpm dev:bot/.test(await banner.innerText()),
    'header banner: «Воркер не запущен … Запустите pnpm dev:bot»',
  );
  await ensureAgents(page, ['planner']);
  const t = await api(page, '/api/tasks', { brief: 'Пост для Telegram: проверка воркера' });
  await page.goto(`${URL_BASE}/tasks/${t.taskId}`);
  await page.getByText('воркер не запущен, поэтому задачу никто не берёт').waitFor({
    timeout: 60_000,
  });
  assert(true, 'a task queued > 30 s with no worker says why');
  await api(page, `/api/tasks/${t.taskId}/cancel`, {});
  assert(errors.length === 0, `no page errors ${errors.join('; ')}`);
  console.log('worker e2e: ok');
} finally {
  await browser.close();
}

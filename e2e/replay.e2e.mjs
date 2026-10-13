// A task on mock: plan -> approve -> the board shows the dispatcher decisions on the edges,
// «Ход задачи» and «Повтор» (1×/4×, slider). Run: E2E_PASSWORD=... pnpm test:e2e replay
import { assert, openPanel, URL_BASE } from './helpers.mjs';

const { browser, page, errors } = await openPanel();
const shots = process.env.E2E_SHOTS;
try {
  await page.goto(URL_BASE + '/tasks/new');
  await page.locator('#brief').fill('Пост для Instagram про осеннее меню кофейни');
  await page.getByRole('button', { name: 'Создать' }).click();
  await page.waitForURL(/\/tasks\/[0-9a-f-]{36}$/);
  const taskId = page.url().split('/').pop();
  await page.getByRole('button', { name: /Утвердить план/ }).click({ timeout: 30_000 });
  await page.getByText('Кому передан результат').waitFor({ timeout: 60_000 });
  await page
    .getByText(/ждёт вашего согласования/)
    .first()
    .waitFor({ timeout: 60_000 });

  await page.goto(URL_BASE + '/');
  await page.locator('.react-flow__node[data-id="ceo"]').waitFor();
  await page.locator('#task-picker').selectOption(taskId);
  await page.getByRole('heading', { name: 'Ход задачи' }).waitFor();
  const label = page.locator('.ws-edge-decision').first();
  await label.waitFor({ timeout: 10_000 });
  assert(
    (await label.textContent()).length > 0,
    `decision label on an edge: ${await label.textContent()}`,
  );
  const rows = await page.locator('.run-feed li').count();
  assert(rows >= 4, `«Ход задачи» has ${rows} events`);
  if (shots) await page.screenshot({ path: `${shots}/replay-task.png` });

  // Replay at 4×: frames advance, later events are dimmed, a card pulses on the way.
  await page.getByLabel('Скорость повтора').selectOption('4');
  await page.getByRole('button', { name: 'Повтор' }).click();
  await page.waitForTimeout(700);
  const future = await page.locator('.run-feed li.future').count();
  assert(future > 0, `replay dims ${future} future events`);
  const slider = page.getByLabel('Момент хода задачи');
  const at = Number(await slider.inputValue());
  await page.waitForTimeout(900);
  assert(Number(await slider.inputValue()) > at, 'the replay moves on by itself');
  if (shots) await page.screenshot({ path: `${shots}/replay-playing.png` });
  await page.getByRole('button', { name: 'Сейчас' }).click();
  assert((await page.locator('.run-feed li.future').count()) === 0, '«Сейчас» ends the replay');
  assert(errors.length === 0, `no page errors ${errors.join('; ')}`);
  console.log('replay e2e: ok');
} finally {
  await browser.close();
}

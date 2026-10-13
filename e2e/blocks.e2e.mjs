// Agents from blocks on mock: a new draft -> «Блоки» (inner view with breadcrumbs) -> palette
// adds a block -> a wrong port is refused with a reason -> fields -> save -> «Собрать в агента»
// -> «Тест и включение». Run: E2E_PASSWORD=... pnpm test:e2e blocks
import { assert, openPanel, URL_BASE } from './helpers.mjs';

const shots = process.env.E2E_SHOTS;
const { browser, page, errors } = await openPanel();
try {
  const name = `Слоганы ${Date.now() % 100000}`;
  const created = await page.evaluate(async (n) => {
    const s = await (await fetch('/api/session')).json();
    const r = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrfToken },
      body: JSON.stringify({ name: n, role: 'придумывает слоганы', modelRole: 'worker' }),
    });
    return r.json();
  }, name);
  assert(created.ok && created.id, `draft agent «${name}» created`);
  await page.goto(`${URL_BASE}/agents/${created.id}/blocks`);
  await page.getByRole('heading', { name: `${name}: блоки` }).waitFor();
  const crumbs = await page.getByRole('navigation', { name: 'Путь' }).innerText();
  assert(/Рабочий стол \/ .+ \/ Блоки/.test(crumbs), `breadcrumbs: ${crumbs}`);
  assert(
    (await page.locator('.blk').count()) === 5,
    'default blocks: Вход → Роль → Модель → Результат → Гейт',
  );

  // Palette: add «Проверка»; a wrong connection (Роль → Проверка) is refused with a reason.
  await page.getByRole('button', { name: 'Добавить блок «Проверка»' }).click();
  await page.waitForTimeout(300);
  const from = await page
    .locator('.react-flow__node[data-id="role"] .react-flow__handle-right')
    .boundingBox();
  const to = await page.locator('.react-flow__node[data-id="check1"]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  await page.getByText(/«Проверка» принимает только: Результат/).waitFor({ timeout: 5000 });
  assert(true, 'wrong port refused with a reason');

  // Configure: role text, one result field, criteria; save; build.
  await page.locator('.react-flow__node[data-id="role"]').click();
  await page
    .getByLabel('Роль', { exact: true })
    .fill('Ты придумываешь короткие слоганы для постов кофейни, 3–6 слов.');
  await page.locator('.react-flow__node[data-id="output"]').click();
  await page.getByRole('button', { name: 'Поле' }).click();
  await page.getByLabel('Поле 1', { exact: true }).fill('Слоганы');
  await page.getByLabel('Тип поля 1', { exact: true }).selectOption('list');
  // Output -> Check by mouse (allowed).
  const o = await page
    .locator('.react-flow__node[data-id="output"] .react-flow__handle-right')
    .boundingBox();
  const c = await page
    .locator('.react-flow__node[data-id="check1"] .react-flow__handle-left')
    .boundingBox();
  await page.mouse.move(o.x + o.width / 2, o.y + o.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 15 });
  await page.mouse.up();
  await page.locator('.react-flow__node[data-id="check1"]').click();
  await page.getByLabel('Критерии').fill('не длиннее 6 слов');
  await page.getByRole('button', { name: /Сохранить/ }).click();
  await page.getByText(/Блоки сохранены \(версия 1\)/).waitFor();
  if (shots) await page.screenshot({ path: `${shots}/blocks.png` });
  await page.getByRole('button', { name: 'Собрать в агента' }).click();
  await page.getByText(/Собрано из блоков версии 1/).waitFor({ timeout: 10_000 });
  assert(true, 'built into the draft');
  await page.getByRole('link', { name: /Тест и включение/ }).click();
  await page.getByText('Слоганы', { exact: false }).first().waitFor();
  assert(errors.length === 0, `no page errors ${errors.join('; ')}`);
  console.log('blocks e2e: ok');
} finally {
  await browser.close();
}

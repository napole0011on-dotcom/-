// Agent library on mock: «+ Агент» opens it; search and categories; «Добавить» and a drag onto
// the board make drafts; tool templates are marked «нужен ключ»; export has no secrets; import
// adds the owner's template. Run: E2E_PASSWORD=... pnpm test:e2e library
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, openPanel } from './helpers.mjs';

const shots = process.env.E2E_SHOTS;
const { browser, page, errors } = await openPanel();
const api = (url, body) =>
  page.evaluate(
    async ([u, b]) => {
      const s = await (await fetch('/api/session')).json();
      const r = await fetch(u, {
        method: b ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrfToken },
        ...(b ? { body: JSON.stringify(b) } : {}),
      });
      return r.json();
    },
    [url, body],
  );
try {
  // Drafts left by an earlier run would block the copies (names are unique on the board).
  const ws = await api('/api/workspace');
  for (const n of ws.nodes)
    if (['Ответ на отзыв', 'Разбор поста'].includes(n.name) && n.status !== 'active')
      await api(`/api/agents/${n.id}/delete`, {});
  await page.reload();
  await page.locator('.react-flow__node[data-id="ceo"]').waitFor();

  await page.getByRole('button', { name: 'Агент' }).click();
  const lib = page.getByRole('dialog', { name: 'Библиотека агентов' });
  await lib.waitFor();
  await lib.getByLabel('Поиск агента').fill('отзыв');
  assert((await lib.locator('.library-card').count()) === 1, 'search finds «Ответ на отзыв»');
  await lib.getByLabel('Поиск агента').fill('');
  await lib.getByRole('button', { name: 'Инструменты' }).click();
  const tool = lib.getByRole('article', { name: 'Шаблон «Картинки Magnific»' });
  assert(await tool.getByText('нужен ключ').isVisible(), 'tool template is marked «нужен ключ»');
  assert(await tool.getByRole('button', { name: 'Добавить' }).isDisabled(), '…and cannot be added');
  if (shots) await page.screenshot({ path: `${shots}/library.png` });
  await lib.getByRole('button', { name: 'Все' }).click();

  // «Добавить»
  await lib
    .getByRole('article', { name: 'Шаблон «Ответ на отзыв»' })
    .getByRole('button', { name: 'Добавить' })
    .click();
  await page.getByText(/«Ответ на отзыв» добавлен как черновик/).waitFor();
  assert(true, '«Добавить» makes a draft');

  // Drag onto the board
  const card = lib.getByRole('article', { name: 'Шаблон «Разбор поста»' });
  await card.dragTo(page.locator('.ws-board .react-flow__pane'), {
    targetPosition: { x: 200, y: 120 },
  });
  await page.getByText(/«Разбор поста» добавлен как черновик/).waitFor();
  await page.locator('.react-flow__node', { hasText: 'Разбор поста' }).waitFor({ timeout: 10_000 });
  assert(true, 'a drop on the board makes a draft card');

  // Export: template only, no secrets; import as the owner's template.
  const exp = await api('/api/library/export/sys:taglines');
  const text = JSON.stringify(exp);
  assert(
    exp.format === 'cms-agent-template' && !/apiKey|token|secret|password|brand/i.test(text),
    'export has no secrets',
  );
  exp.template.slug = `my_${Date.now() % 100000}`;
  exp.template.name = `Мои слоганы ${Date.now() % 1000}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'tpl-'));
  const file = path.join(dir, 'tpl.json');
  writeFileSync(file, JSON.stringify(exp));
  await lib.locator('input[type=file]').setInputFiles(file);
  await page.getByText(/сохранён в библиотеку \(версия 1\)/).waitFor();
  await lib.getByLabel('Поиск агента').fill(exp.template.name);
  await lib.getByText('ваш · v1').waitFor();
  assert(true, "import adds the owner's template (v1)");
  assert(errors.length === 0, `no page errors ${errors.join('; ')}`);
  console.log('library e2e: ok');
} finally {
  await browser.close();
}

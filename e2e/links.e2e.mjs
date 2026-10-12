// Links between agents: by mouse (drag), by clicks, from the side panel; survive a reload;
// deletion; cards never overlap. Run: E2E_PASSWORD=... pnpm test:e2e
import { assert, dragLink, dropLink, edge, openPanel } from './helpers.mjs';

const { browser, page, errors } = await openPanel({ width: 1366, height: 768 });
try {
  // Cards never overlap (default board has 15 cards: agents, tools, Бриф, Вы).
  const rects = await page.evaluate(() =>
    [...document.querySelectorAll('.react-flow__node')].map((n) => {
      const r = n.getBoundingClientRect();
      return { id: n.getAttribute('data-id'), x: r.x, y: r.y, w: r.width, h: r.height };
    }),
  );
  const hit = [];
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1)
        hit.push(`${a.id}/${b.id}`);
    }
  assert(rects.length >= 12, `board shows ${rects.length} cards`);
  assert(hit.length === 0, `no overlapping cards ${hit.join(' ')}`);
  const hb = await page
    .locator('.react-flow__node[data-id="copywriter"] .react-flow__handle.source')
    .boundingBox();
  assert(hb.width >= 8, `output point is ${Math.round(hb.width)}px (hit area 2.5x bigger)`);

  // 1. Mouse: drag from the output point to the card; reload; still there.
  await dropLink(page, 'copywriter', 'image');
  await page.reload();
  await page.locator('.react-flow__node[data-id="ceo"]').waitFor();
  await page.waitForTimeout(600);
  await dragLink(page, 'copywriter', 'image');
  await page.getByText('Связь Копирайтер → Image добавлена').waitFor({ timeout: 5000 });
  await page.reload();
  await page.locator('.react-flow__node[data-id="ceo"]').waitFor();
  await edge(page, 'Копирайтер', 'Image').waitFor({ state: 'attached', timeout: 5000 });
  assert(true, 'link made by mouse survives a reload');

  // Delete it: select the line, «Удалить связь», confirm; gone after a reload.
  await edge(page, 'Копирайтер', 'Image').dispatchEvent('click');
  await page.locator('.side-panel').getByRole('button', { name: 'Удалить связь' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Да, удалить' }).click();
  await page.getByText(/Связь Копирайтер → Image удалена/).waitFor({ timeout: 5000 });
  await page.reload();
  await page.locator('.react-flow__node[data-id="ceo"]').waitFor();
  await page.waitForTimeout(800);
  assert(
    (await edge(page, 'Копирайтер', 'Image').count()) === 0,
    'deleted link is gone after a reload',
  );

  // 2. Clicks: the output point, then the receiver; a refused target explains why.
  await dropLink(page, 'critic', 'image');
  await page.locator('.react-flow__node[data-id="critic"] .react-flow__handle.source').click();
  await page.getByText(/нажмите на агента, которому передавать результат/).waitFor();
  await page.locator('.react-flow__node[data-id="ceo"]').click();
  await page.getByText('CEO получает только бриф').waitFor({ timeout: 5000 });
  assert(true, 'refused click-link says why');
  await page.locator('.react-flow__node[data-id="critic"] .react-flow__handle.source').click();
  await page.locator('.react-flow__node[data-id="image"]').click();
  await page.getByText('Связь Critic → Image добавлена').waitFor({ timeout: 5000 });
  assert(true, 'link made by two clicks');
  await dropLink(page, 'critic', 'image');

  // 3. Side panel: «Передавать результат →».
  await dropLink(page, 'kp', 'kp_render');
  await page.locator('.react-flow__node[data-id="kp"]').click();
  await page.getByLabel('Передавать результат →').selectOption('kp_render');
  await page.locator('.side-panel').getByRole('button', { name: 'Связать' }).click();
  await page.getByText('Связь КП → КП → DOCX/PDF добавлена').waitFor({ timeout: 5000 });
  assert(true, 'link made from the side panel');
  await dropLink(page, 'kp', 'kp_render');

  // System links cannot be deleted.
  await edge(page, 'CEO', 'Копирайтер').dispatchEvent('click');
  await page.locator('.side-panel').getByText('удалить нельзя').waitFor();
  assert(true, 'system link is protected');
  assert(errors.length === 0, `no page errors ${errors.join(' ')}`);
} finally {
  await browser.close();
}

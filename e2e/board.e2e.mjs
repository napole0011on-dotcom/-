// Board layout at 1440 / 1024 / 400 px, light and dark: after «Авторасстановка» no two cards
// overlap, nothing lies on the board over the cards, «Стоп» has a text label, the task picker
// does not stretch the row. Run: E2E_PASSWORD=... pnpm test:e2e board  (E2E_SHOTS=dir saves PNGs)
import { assert, openPanel } from './helpers.mjs';

const shots = process.env.E2E_SHOTS;
const rects = (page) =>
  page.evaluate(() => {
    const board = document.querySelector('.ws-board').getBoundingClientRect();
    const cards = [...document.querySelectorAll('.react-flow__node')].map((n) => {
      const r = n.getBoundingClientRect();
      return { id: n.getAttribute('data-id'), x: r.x, y: r.y, w: r.width, h: r.height };
    });
    // Anything drawn over the canvas (toolbar, zoom buttons, minimap) besides the edge labels.
    const over = [...document.querySelectorAll('.ws-board .react-flow__panel')].length;
    return { board, cards, over };
  });

for (const width of [1440, 1024, 400]) {
  const { browser, page, errors } = await openPanel({ width, height: 900 });
  try {
    await page.getByRole('button', { name: 'Авторасстановка' }).click();
    await page.waitForTimeout(900);
    const { cards, over } = await rects(page);
    const hit = [];
    for (let i = 0; i < cards.length; i++)
      for (let j = i + 1; j < cards.length; j++) {
        const a = cards[i];
        const b = cards[j];
        if (
          a.x < b.x + b.w - 1 &&
          b.x < a.x + a.w - 1 &&
          a.y < b.y + b.h - 1 &&
          b.y < a.y + a.h - 1
        )
          hit.push(`${a.id}/${b.id}`);
      }
    assert(
      cards.length >= 12 && hit.length === 0,
      `${width}px: ${cards.length} cards, no overlaps ${hit.join(' ')}`,
    );
    assert(over === 0, `${width}px: nothing over the canvas by default`);
    const heights = new Set(
      cards.filter((c) => !['brief', 'me'].includes(c.id)).map((c) => Math.round(c.h)),
    );
    assert(
      heights.size === 1,
      `${width}px: agent cards have one height (${[...heights].join(',')})`,
    );
    // Narrow screens: «Остановить всё» lives in the menu, with its full label.
    const narrow = width < 1080;
    if (narrow) await page.getByRole('button', { name: 'Меню', exact: true }).click();
    const stop = page
      .locator(narrow ? '.mobile-nav-panel' : '.header-right')
      .getByRole('button', { name: /Стоп|Остановить всё|Продолжить/ })
      .first();
    const label = (await stop.innerText()).trim();
    assert(/[А-Яа-я]/.test(label), `${width}px: «${label}» has a text label`);
    if (narrow)
      await page.locator('.mobile-nav-panel').getByRole('button', { name: 'Закрыть меню' }).click();
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(scroll <= 1, `${width}px: no horizontal page scroll (${scroll}px)`);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      if (shots) await page.screenshot({ path: `${shots}/board-${width}-${theme}.png` });
    }
    assert(errors.length === 0, `${width}px: no page errors ${errors.join('; ')}`);
  } finally {
    await browser.close();
  }
}
console.log('board e2e: ok');

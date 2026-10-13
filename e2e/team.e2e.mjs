// Stage 7 on mock, from an empty board: «Соберите команду» -> «Базовая команда» -> a task goes
// to the gate -> deleting an agent of an unfinished task is refused with a link to it -> every
// agent is deleted (Delete key and the button) -> a planner from the library -> an agent from
// scratch. Runs first (pnpm test:e2e); the other files add the agents they need.
// Run: E2E_PASSWORD=... pnpm test:e2e team
import { api, assert, openPanel, waitTask } from './helpers.mjs';

const shots = process.env.E2E_SHOTS;
const { browser, page, errors } = await openPanel();
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const dialog = () => page.getByRole('dialog', { name: /^Удалить агента/ });
try {
  // A clean start on a used database: unfinished tasks cancelled, every agent deleted.
  for (const t of await api(page, '/api/tasks'))
    if (!['exported', 'cancelled', 'failed'].includes(t.status))
      await api(page, `/api/tasks/${t.id}/cancel`, {});
  for (const n of (await api(page, '/api/workspace')).nodes)
    if (n.kind !== 'human') await api(page, `/api/agents/${n.id}/delete`, {});
  await page.reload();
  await node('brief').waitFor();

  // 1. Empty board: only «Бриф» and «Вы», the «Соберите команду» block, the worker is alive.
  const empty = page.getByRole('region', { name: 'Соберите команду' });
  await empty.waitFor();
  assert((await page.locator('.react-flow__node').count()) === 2, 'empty board: «Бриф» and «Вы»');
  assert(
    (await page.getByText('Воркер не запущен').count()) === 0,
    'no worker banner while the worker runs',
  );
  if (shots) await page.screenshot({ path: `${shots}/empty-board.png` });
  await node('brief').click();
  await page.locator('.side-panel').getByText('не агенты').waitFor();
  assert(true, '«Бриф» says it is not an agent');

  // 2. «Базовая команда»: planner, copywriter, reviewer — linked, tested, switched on.
  await empty.getByRole('button', { name: 'Базовая команда' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 5);
  const ws = await api(page, '/api/workspace');
  // Ids are the template slugs on a fresh database; a slug of a deleted agent is never reused.
  const idOf = (role, capability = null) =>
    ws.nodes.find((n) => n.teamRole === role && n.capability === capability).id;
  const P = idOf('planner');
  const C = idOf('worker', 'copywriting');
  const R = idOf('reviewer');
  assert(
    ws.nodes.filter((n) => n.kind !== 'human').every((n) => n.status === 'active'),
    'basic team is switched on',
  );
  assert(
    ws.links
      .map((l) => `${l.from}>${l.to}`)
      .sort()
      .join(' ') === [`brief>${P}`, `${C}>${R}`, `${P}>${C}`, `${R}>me`].sort().join(' '),
    'basic team is linked: Бриф → Планировщик → Копирайтер → Проверяющий → Вы',
  );
  assert(await empty.isHidden(), '«Соберите команду» is gone');
  if (shots) await page.screenshot({ path: `${shots}/basic-team.png` });

  // 3. A task: queue -> worker -> plan gate (human) -> steps -> final gate.
  const created = await api(page, '/api/tasks', { brief: 'Пост для Telegram про осеннее меню' });
  assert(created.ok && created.planned, 'task created, the planner starts');
  await waitTask(page, created.taskId, 'awaiting_plan_approval');
  await api(page, `/api/tasks/${created.taskId}/plan`, { action: 'approve' });
  const done = await waitTask(page, created.taskId, 'awaiting_final_approval');
  assert(done.copies.length > 0, 'texts are at the final gate');

  // 4. An agent in the plan of an unfinished task: refused, with a link to the task.
  await node(C).click();
  await page.locator('.side-panel').getByRole('button', { name: 'Удалить агента' }).click();
  await dialog().getByText('Агент включён, он перестанет получать задачи').waitFor();
  await dialog().getByRole('button', { name: 'Да, удалить' }).click();
  await dialog()
    .getByText(/есть в плане незавершённой задачи/)
    .waitFor();
  const link = dialog().getByRole('link', { name: 'Открыть задачу' });
  assert(
    (await link.getAttribute('href')) === `/tasks/${created.taskId}`,
    'refusal names the task and links to it',
  );
  await dialog().getByRole('button', { name: 'Нет' }).click();
  await api(page, `/api/tasks/${created.taskId}/cancel`, {});

  // 5. Delete every agent: the Delete key (with a question) and the side panel button.
  await node(P).click();
  await page.keyboard.press('Delete');
  await dialog().getByText('Это последний планировщик').waitFor();
  await dialog().getByRole('button', { name: 'Да, удалить' }).click();
  await node(P).waitFor({ state: 'detached' });
  assert(true, 'Delete key on a card: asked, the last planner warned, deleted');
  await node(C).click();
  await page.locator('.side-panel').getByRole('button', { name: 'Удалить агента' }).click();
  await dialog().getByRole('button', { name: 'Да, удалить' }).click();
  await node(C).waitFor({ state: 'detached' });
  await node(R).click();
  await page.keyboard.press('Delete');
  await dialog().getByRole('button', { name: 'Да, удалить' }).click();
  await node(R).waitFor({ state: 'detached' });
  assert(
    (await page.locator('.react-flow__node').count()) === 2,
    'every agent deleted, the board is empty again',
  );
  await node('me').click();
  await page.keyboard.press('Delete');
  await page.getByText('«Бриф» и «Вы» — не агенты').first().waitFor();
  assert((await node('me').count()) === 1, '«Вы» cannot be deleted');

  // Without a planner a new task waits in «приём» and says why.
  const waiting = await api(page, '/api/tasks', { brief: 'Пост для Instagram про какао' });
  assert(
    waiting.ok && !waiting.planned && /^Нет планировщика/.test(waiting.message),
    'no planner: the task waits and says why',
  );
  await api(page, `/api/tasks/${waiting.taskId}/cancel`, {});

  // 6. A planner from the library: a draft copy with a new id (the old one is taken).
  await empty.getByRole('button', { name: 'Выбрать из библиотеки' }).click();
  const win = page.getByRole('dialog', { name: 'Новый агент' });
  await win.getByLabel('Поиск агента').fill('Планировщик');
  await win
    .getByRole('article', { name: 'Шаблон «Планировщик»' })
    .getByRole('button', { name: 'Добавить' })
    .click();
  await page.getByText(/«Планировщик» добавлен как черновик/).waitFor();
  const again = (await api(page, '/api/workspace')).nodes.find((n) => n.name === 'Планировщик');
  assert(
    again && again.id !== P && again.status === 'draft',
    `re-created with a new id ${again?.id}`,
  );

  // 7. An agent from scratch: «Пустой агент» -> the constructor page.
  await win.getByRole('tab', { name: 'Пустой агент' }).click();
  await win.getByLabel('Название').fill('Редактор');
  await win.getByLabel('Что делает — одной строкой').fill('сокращает текст до 500 знаков');
  await win.getByLabel('Роль в команде').selectOption('worker');
  await win.getByRole('button', { name: 'Создать черновик' }).click();
  await page.getByRole('heading', { name: 'Редактор' }).waitFor();
  assert(/\/agents\/[a-z0-9_]+\/build$/.test(page.url()), 'empty agent opens in the constructor');
  if (shots) await page.screenshot({ path: `${shots}/new-agent.png` });

  // Leave the board empty: the next files build what they need («Базовая команда» and more).
  for (const n of (await api(page, '/api/workspace')).nodes)
    if (n.kind !== 'human') await api(page, `/api/agents/${n.id}/delete`, {});
  assert(errors.length === 0, `no page errors ${errors.join('; ')}`);
  console.log('team e2e: ok');
} finally {
  await browser.close();
}

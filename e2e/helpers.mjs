// Browser checks of the running panel (pnpm test:e2e). Not part of pnpm check: they need
// the API (pnpm start:api) and the worker running with LLM_PROVIDER=mock.
//   E2E_URL       panel address, default http://127.0.0.1:3000
//   E2E_PASSWORD  panel password (the one PANEL_PASSWORD_HASH was made from)
//   E2E_CHROMIUM  path to Chrome/Chromium; without it Playwright's own browser is used
//                 (Windows: npx playwright install chromium)
import { chromium } from 'playwright-core';

export const URL_BASE = process.env.E2E_URL ?? 'http://127.0.0.1:3000';

export async function openPanel({ width = 1440, height = 900 } = {}) {
  if (!process.env.E2E_PASSWORD) throw new Error('Set E2E_PASSWORD to the panel password');
  const browser = await chromium.launch(
    process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {},
  );
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(URL_BASE + '/');
  await page.getByLabel('Пароль').fill(process.env.E2E_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.locator('.react-flow__node[data-id="brief"]').waitFor();
  await page.waitForTimeout(800);
  return { browser, page, errors };
}

/** Real mouse events: press on the output point of `from`, move in steps, release on `to`. */
export async function dragLink(page, from, to) {
  const handle = page.locator(`.react-flow__node[data-id="${from}"] .react-flow__handle.source`);
  await handle.scrollIntoViewIfNeeded();
  const a = await handle.boundingBox();
  const b = await page.locator(`.react-flow__node[data-id="${to}"]`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
  await page.mouse.up();
}

/** The edge «A → B» by its accessible name (names as shown on the cards). */
export const edge = (page, fromName, toName) =>
  page.locator(`.react-flow__edge[aria-label="Связь ${fromName} → ${toName}"]`);

/** Removes a link through the API (test setup), if it exists. */
export async function dropLink(page, from, to) {
  await page.evaluate(
    async ([f, t]) => {
      const s = await (await fetch('/api/session')).json();
      const ws = await (await fetch('/api/workspace')).json();
      const l = ws.links.find((x) => x.from === f && x.to === t);
      if (l)
        await fetch(`/api/workspace/links/${l.id}/delete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrfToken },
          body: '{}',
        });
    },
    [from, to],
  );
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`✔ ${msg}`);
}

/** A panel API call from the page (session cookie + CSRF), for test setup and checks. */
export const api = (page, url, body) =>
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

/** Waits until the task reaches the status (the worker runs it on the mock model). */
export async function waitTask(page, id, status, timeout = 60_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const t = await api(page, `/api/tasks/${id}`);
    if (t.task?.status === status) return t;
    if (Date.now() > until) throw new Error(`FAIL: task is ${t.task?.status}, not ${status}`);
    await page.waitForTimeout(700);
  }
}

/**
 * The agents a test needs, from the library (stage 7: there are no built-in agents). An agent
 * with the template's name is reused; `activate` runs the mock test and switches it on.
 * Returns { slug: agent id } (ids are the slugs on a fresh database).
 */
export async function ensureAgents(page, slugs, { activate = true } = {}) {
  const lib = await api(page, '/api/library');
  const ids = {};
  for (const slug of slugs) {
    const tpl = lib.templates.find((t) => t.slug === slug);
    if (!tpl) throw new Error(`FAIL: no template ${slug}`);
    const ws = await api(page, '/api/workspace');
    let n = ws.nodes.find((x) => x.name === tpl.name);
    if (!n) {
      const r = await api(page, '/api/library/add', { templateId: slug });
      if (!r.ok) throw new Error(`FAIL: add ${slug}: ${r.message}`);
      n = { id: r.id, status: 'draft' };
    }
    if (activate && n.status !== 'active') {
      await api(page, `/api/agents/${n.id}/test`, {});
      const on = await api(page, `/api/agents/${n.id}/activate`, {});
      if (!on.ok) throw new Error(`FAIL: activate ${slug}: ${on.message}`);
    }
    ids[slug] = n.id;
  }
  return ids;
}

/** A working team on the board: «Базовая команда» when there is no active planner yet. */
export async function ensureBasicTeam(page) {
  const ws = await api(page, '/api/workspace');
  if (!ws.nodes.some((n) => n.teamRole === 'planner' && n.status === 'active')) {
    const r = await api(page, '/api/library/team', {});
    if (!r.ok) throw new Error(`FAIL: basic team: ${r.message}`);
  }
  const after = await api(page, '/api/workspace');
  const idOf = (role, capability = null) =>
    after.nodes.find(
      (n) => n.teamRole === role && n.capability === capability && n.status === 'active',
    )?.id;
  return {
    planner: idOf('planner'),
    copywriter: idOf('worker', 'copywriting'),
    reviewer: idOf('reviewer'),
  };
}

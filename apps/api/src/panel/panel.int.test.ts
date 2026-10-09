import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, loadPricing, type AppConfig } from '@cms/core';
import { schema, sql } from '@cms/db';
import { LlmClient, processRun } from '@cms/engine';
import { budgetCtx, llmConfig, setupTestDb, silentLogger, type TestDb } from '@cms/engine/testkit';
import { BrandProfile, MockLlmTransport, Workflow, upsertBrand } from '@cms/agents';
import { RecordingChannel } from '@cms/agents/testing';
import { buildServer } from '../server.js';
import { registerPanel } from './routes.js';

const PASSWORD = 'panel-test-password';
const ORIGIN = 'http://127.0.0.1:3000';
const SECRETS = ['sk-ant-SECRET-1', 'th-SECRET-2', '123456:TG-SECRET-3', 's3-SECRET-4'] as const;

describe('web panel API (Postgres)', () => {
  let t: TestDb;
  let app: ReturnType<typeof buildServer>;
  let wf: Workflow;
  let brandId: string;
  const queue: string[] = [];
  const mirrored: { text: string; reopen?: string }[] = [];

  beforeAll(async () => {
    t = await setupTestDb();
    const { brand } = await upsertBrand(
      t.db,
      BrandProfile.parse({ slug: 'panel-test', name: 'Кофейня' }),
    );
    brandId = brand.id;
    const llmCfg = llmConfig({ provider: 'mock', apiKey: SECRETS[0] });
    const config: AppConfig = {
      ...t.config,
      llm: llmCfg,
      budget: budgetCtx().config,
      timezone: 'Europe/Moscow',
      exportDir: t.config.exportDir,
      telegram: { botToken: SECRETS[2], ownerId: 42 },
      storage: {
        driver: 's3',
        endpoint: 'http://x',
        region: 'r',
        bucket: 'b',
        accessKeyId: 'k',
        secretAccessKey: SECRETS[3],
        forcePathStyle: true,
      },
    };
    const pricing = loadPricing(llmCfg.pricingFile);
    const channel = new RecordingChannel();
    const llm = new LlmClient({
      db: t.db,
      transport: new MockLlmTransport(),
      pricing,
      config: llmCfg,
      budget: budgetCtx(),
      notifier: channel,
      logger: silentLogger,
    });
    wf = new Workflow({
      db: t.db,
      llm,
      channel,
      enqueue: (id) => Promise.resolve(queue.push(id)),
      config,
      pricing,
      logger: silentLogger,
    });
    app = buildServer({ logger: silentLogger, checks: {} });
    await registerPanel(app, {
      db: t.db,
      config,
      pricing,
      budget: budgetCtx(),
      brandId: () => brandId,
      workflow: wf,
      panel: {
        passwordHash: await hashPassword(PASSWORD),
        sessionIdleMinutes: 30,
        sessionMaxHours: 12,
        loginMaxAttempts: 5,
        loginLockMinutes: 5,
      },
      mirror: {
        notify: (text, reopen) => (
          mirrored.push({ text, ...(reopen ? { reopen } : {}) }),
          Promise.resolve()
        ),
      },
      logger: silentLogger,
      allowedOrigins: [ORIGIN],
    });
  });
  afterAll(async () => {
    await app?.close();
    await t?.close();
  });
  beforeEach(async () => {
    await t.db.delete(schema.panelLoginState);
  });

  const drain = async () => {
    while (queue.length) {
      await processRun(
        { db: t.db, notifier: new RecordingChannel(), logger: silentLogger, staleAfterSeconds: 60 },
        queue.shift()!,
        wf.handleRun,
        new AbortController().signal,
      );
    }
  };

  async function loginOk() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { origin: ORIGIN },
      payload: { password: PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'cms_session')!;
    return {
      cookie: `cms_session=${cookie.value}`,
      csrf: res.json<{ csrfToken: string }>().csrfToken,
      raw: cookie,
    };
  }
  const get = (s: { cookie: string }, url: string) =>
    app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });
  const post = (s: { cookie: string; csrf: string }, url: string, payload: unknown = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN },
      payload: payload as object,
    });

  describe('login and session security', () => {
    it('sets an HttpOnly, SameSite=Strict session cookie; the token is stored only as a hash', async () => {
      const s = await loginOk();
      expect(s.raw).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
      const rows = await t.db.select().from(schema.panelSessions);
      expect(rows.some((r) => r.tokenHash === s.raw.value)).toBe(false);
    });

    it('wrong passwords count down, the 5th locks the login, even the right password is refused while locked', async () => {
      for (let i = 4; i >= 1; i--) {
        const r = await app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { origin: ORIGIN },
          payload: { password: 'nope' },
        });
        expect([r.statusCode, r.json<{ attemptsLeft: number }>().attemptsLeft]).toEqual([401, i]);
      }
      const locked = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin: ORIGIN },
        payload: { password: 'nope' },
      });
      expect(locked.statusCode).toBe(429);
      const stillLocked = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin: ORIGIN },
        payload: { password: PASSWORD },
      });
      expect(stillLocked.statusCode).toBe(429);
      // Lock expired -> login works and the counter is reset.
      await t.db
        .update(schema.panelLoginState)
        .set({ lockedUntil: sql`now() - interval '1 second'` });
      await loginOk();
      const audit = await t.db
        .select()
        .from(schema.auditLog)
        .where(sql`${schema.auditLog.action} like 'panel_login%'`);
      expect(audit.map((a) => a.action)).toEqual(
        expect.arrayContaining(['panel_login_failed', 'panel_login_locked', 'panel_login']),
      );
    });

    it('everything under /api needs a session; logout ends it', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/agents' })).statusCode).toBe(401);
      const s = await loginOk();
      expect((await get(s, '/api/agents')).statusCode).toBe(200);
      expect((await post(s, '/api/logout')).statusCode).toBe(200);
      expect((await get(s, '/api/agents')).statusCode).toBe(401);
    });

    it('idle timeout (30 min) and absolute timeout (12 h)', async () => {
      const a = await loginOk();
      await t.db
        .update(schema.panelSessions)
        .set({ lastSeenAt: sql`now() - interval '31 minutes'` });
      expect((await get(a, '/api/agents')).statusCode).toBe(401);
      const b = await loginOk();
      await t.db.update(schema.panelSessions).set({ expiresAt: sql`now() - interval '1 second'` });
      expect((await get(b, '/api/agents')).statusCode).toBe(401);
    });

    it('state changes need the CSRF header and an allowed Origin', async () => {
      const s = await loginOk();
      const brief = { brief: 'Пост про осеннее меню' };
      const noCsrf = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie: s.cookie, origin: ORIGIN },
        payload: brief,
      });
      expect(noCsrf.statusCode).toBe(403);
      const badOrigin = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'http://evil.example' },
        payload: brief,
      });
      expect(badOrigin.statusCode).toBe(403);
      const noOrigin = await app.inject({
        method: 'POST',
        url: '/api/tasks',
        headers: { cookie: s.cookie, 'x-csrf-token': s.csrf },
        payload: brief,
      });
      expect(noOrigin.statusCode).toBe(403);
    });
  });

  describe('owner scenario from the panel', () => {
    it('brief -> plan -> approve -> package -> approve; Telegram and panel decisions are the same decision', async () => {
      const s = await loginOk();
      const created = await post(s, '/api/tasks', {
        brief: 'Подготовь пост и анонс в Telegram про осеннее меню',
      });
      expect(created.statusCode).toBe(200);
      const { taskId } = created.json<{ taskId: string }>();
      await drain();

      // Plan waits in the approval queue
      const q1 = (await get(s, '/api/approvals')).json<{
        plans: { taskId: string; version: number }[];
      }>();
      expect(q1.plans.map((p) => p.taskId)).toContain(taskId);
      expect((await post(s, `/api/tasks/${taskId}/plan`, { action: 'approve' })).statusCode).toBe(
        200,
      );
      // The same approval coming from Telegram is a no-op (same decision key)
      const fromTelegram = await wf.decidePlan(taskId, 'approve', { kind: 'human', id: 'tg:42' });
      expect(fromTelegram.ok).toBe(false);
      await drain();

      const q2 = (await get(s, '/api/approvals')).json<{
        packages: { taskId: string; items: { artifactId: string }[] }[];
      }>();
      const pkg = q2.packages.find((p) => p.taskId === taskId)!;
      expect(pkg.items).toHaveLength(2);

      // Item 1 approved in Telegram, then pressed in the panel: one decision, panel says "already decided".
      const [a, b] = pkg.items;
      expect(
        (
          await wf.decideArtifact(
            a!.artifactId,
            'approve',
            { kind: 'human', id: 'tg:42' },
            { variant: 1 },
          )
        ).ok,
      ).toBe(true);
      const dup = await post(s, `/api/artifacts/${a!.artifactId}/decision`, {
        action: 'approve',
        variant: 2,
      });
      expect(dup.statusCode).toBe(409);
      // Item 2 approved in the panel -> everything approved -> export
      expect(
        (
          await post(s, `/api/artifacts/${b!.artifactId}/decision`, {
            action: 'approve',
            variant: 3,
          })
        ).statusCode,
      ).toBe(200);
      await drain();

      const detail = (await get(s, `/api/tasks/${taskId}`)).json<{
        task: { status: string };
        decisions: { decision: string; by: string; choice: number | null }[];
        actions: { reopenPackage: boolean };
      }>();
      expect(detail.task.status).toBe('exported');
      expect(
        detail.decisions.filter((x) => x.decision === 'approved').map((x) => [x.by, x.choice]),
      ).toEqual([
        ['panel:owner', null],
        ['tg:42', 1],
        ['panel:owner', 3],
      ]);
      // Panel decisions were mirrored to Telegram
      expect(mirrored.map((m) => m.text).join('\n')).toMatch(/В панели: План утверждён/);
      // After export there is no way back
      expect(detail.actions.reopenPackage).toBe(false);
    });

    it('reject package (human, via transition) -> reopen; after export reopening is impossible', async () => {
      const s = await loginOk();
      const { taskId } = (
        await post(s, '/api/tasks', { brief: 'Анонс бариста-шоу в субботу' })
      ).json<{ taskId: string }>();
      await drain();
      await post(s, `/api/tasks/${taskId}/plan`, { action: 'approve' });
      await drain();

      const rej = await post(s, `/api/tasks/${taskId}/reject`, { comment: 'не то' });
      expect(rej.statusCode).toBe(200);
      expect(mirrored.at(-1)).toMatchObject({ reopen: taskId });
      let detail = (await get(s, `/api/tasks/${taskId}`)).json<{
        task: { status: string };
        actions: { reopenPackage: boolean };
      }>();
      expect(detail.task.status).toBe('rejected');
      expect(detail.actions.reopenPackage).toBe(true);
      // Rejecting again is refused; the bot path gives the same answer
      expect((await post(s, `/api/tasks/${taskId}/reject`)).statusCode).toBe(409);
      expect((await wf.rejectPackage(taskId, { kind: 'human', id: 'tg:42' })).ok).toBe(false);
      // Only humans
      await expect(wf.rejectPackage(taskId, { kind: 'agent', id: 'ceo' })).resolves.toMatchObject({
        ok: false,
      });

      expect((await post(s, `/api/tasks/${taskId}/reopen`)).statusCode).toBe(200);
      detail = (await get(s, `/api/tasks/${taskId}`)).json<{
        task: { status: string };
        actions: { reopenPackage: boolean };
      }>();
      expect(detail.task.status).toBe('awaiting_final_approval');

      expect((await post(s, `/api/tasks/${taskId}/approve-all`)).statusCode).toBe(200);
      await drain();
      expect(
        (await get(s, `/api/tasks/${taskId}`)).json<{ task: { status: string } }>().task.status,
      ).toBe('exported');
      const reopenAfterExport = await post(s, `/api/tasks/${taskId}/reopen`);
      expect(reopenAfterExport.statusCode).toBe(409);
      expect(reopenAfterExport.json<{ message: string }>().message).toMatch(/экспортирован/);
      const audit = await t.db
        .select()
        .from(schema.auditLog)
        .where(sql`${schema.auditLog.taskId} = ${taskId}`);
      expect(audit.map((x) => x.action)).toContain('decision:final:rejected');
    });

    it('agent cards: the three agents from the registry with real stats from the database', async () => {
      const s = await loginOk();
      const cards = (await get(s, '/api/agents')).json<
        {
          id: string;
          status: string;
          lastRunAt: string | null;
          success: { ok: number; failed: number };
          model: { name: string; source: string };
          promptVersion: string;
        }[]
      >();
      expect(cards.map((c) => c.id)).toEqual(['ceo', 'copywriter', 'critic']);
      for (const c of cards) {
        expect(c.lastRunAt).not.toBeNull();
        expect(c.success.ok).toBeGreaterThan(0);
        expect(c.model.source).toBe('.env');
        expect(c.promptVersion).toMatch(new RegExp(`^${c.id}@\\d+#[0-9a-f]{8}$`));
      }
      const status = (await get(s, '/api/status')).json<{
        provider: string;
        models: Record<string, string>;
      }>();
      expect(status.provider).toBe('mock');
      expect(Object.keys(status.models)).toEqual(['ceo', 'critic', 'worker', 'classifier']);
    });

    it('no secret ever appears in any panel response', async () => {
      const s = await loginOk();
      const tasks = (await get(s, '/api/tasks')).json<{ id: string }[]>();
      const urls = [
        '/api/session',
        '/api/status',
        '/api/agents',
        '/api/tasks',
        '/api/approvals',
        '/api/spend',
        `/api/tasks/${tasks[0]!.id}`,
      ];
      const runId = (await get(s, `/api/tasks/${tasks[0]!.id}`)).json<{ runs: { id: string }[] }>()
        .runs[0]!.id;
      urls.push(`/api/runs/${runId}`);
      for (const url of urls) {
        const body = (await get(s, url)).body;
        for (const secret of [...SECRETS, PASSWORD, 'scrypt:'])
          expect(body, `${url} leaks ${secret}`).not.toContain(secret);
      }
    });
  });
});

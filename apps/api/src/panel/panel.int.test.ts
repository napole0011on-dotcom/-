import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, loadPricing, type AppConfig } from '@cms/core';
import { schema, sql } from '@cms/db';
import { LlmClient, processRun } from '@cms/engine';
import { budgetCtx, llmConfig, setupTestDb, silentLogger, type TestDb } from '@cms/engine/testkit';
import { BrandProfile, MockLlmTransport, Workflow, upsertBrand } from '@cms/agents';
import { RecordingChannel } from '@cms/agents/testing';
import { buildServer } from '../server.js';
import { request } from 'node:http';
import { emitEvent } from '@cms/agents';
import { EventHub } from './event-hub.js';
import { registerPanel } from './routes.js';

const PASSWORD = 'panel-test-password';
const ORIGIN = 'http://127.0.0.1:3000';
const SECRETS = ['sk-ant-SECRET-1', 'th-SECRET-2', '123456:TG-SECRET-3', 's3-SECRET-4'] as const;

describe('web panel API (Postgres)', () => {
  let t: TestDb;
  let app: ReturnType<typeof buildServer>;
  let wf: Workflow;
  let brandId: string;
  let hub: EventHub;
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
    hub = new EventHub(t.pool, t.db, () => brandId, silentLogger);
    await hub.start();
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
      events: hub,
    });
  });
  afterAll(async () => {
    await hub?.stop();
    await app?.close();
    await t?.close();
  });
  beforeEach(async () => {
    await t.db.delete(schema.panelLoginState);
  });

  const drain = async () => {
    while (queue.length) {
      await processRun(
        {
          db: t.db,
          notifier: new RecordingChannel(),
          logger: silentLogger,
          staleAfterSeconds: 60,
          gate: wf.gate,
        },
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

    it('background polling does not extend the idle timeout, owner activity does', async () => {
      await t.db.delete(schema.panelSessions);
      const s = await loginOk();
      const seen = async () =>
        (await t.db.select({ at: schema.panelSessions.lastSeenAt }).from(schema.panelSessions))[0]!
          .at;
      await t.db
        .update(schema.panelSessions)
        .set({ lastSeenAt: sql`now() - interval '10 minutes'` });
      const before = await seen();
      expect((await get(s, '/api/agents')).statusCode).toBe(200);
      expect(await seen()).toEqual(before);
      const active = await app.inject({
        method: 'GET',
        url: '/api/agents',
        headers: { cookie: s.cookie, 'x-panel-activity': '1' },
      });
      expect(active.statusCode).toBe(200);
      expect((await seen()).getTime()).toBeGreaterThan(before.getTime());
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
      // Code agents with stats, then the planned board agents (no runs yet).
      expect(cards.map((c) => c.id)).toEqual(['ceo', 'copywriter', 'critic', 'seo', 'image']);
      for (const c of cards.slice(0, 3)) {
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

    it('agent management: pause holds runs, model only from price list, prompt versions, test, stop all', async () => {
      const s = await loginOk();
      type Card = {
        id: string;
        status: string;
        waitingRuns: number;
        model: { name: string; source: string };
        promptVersion: string;
        controls: { paused: boolean; allPaused: boolean };
      };
      const card = async (id: string) =>
        (await get(s, '/api/agents')).json<Card[]>().find((c) => c.id === id)!;

      // Pause the copywriter: the copy run waits, the task shows "ждёт агента".
      expect((await post(s, '/api/agents/copywriter/pause')).statusCode).toBe(200);
      expect(await card('copywriter')).toMatchObject({
        status: 'paused',
        controls: { paused: true },
      });
      const { taskId } = (
        await post(s, '/api/tasks', { brief: 'Пост про какао с маршмеллоу' })
      ).json<{
        taskId: string;
      }>();
      await drain();
      await post(s, `/api/tasks/${taskId}/plan`, { action: 'approve' });
      await drain();
      const board = (await get(s, '/api/tasks')).json<
        { id: string; waitingFor: string | null }[]
      >();
      expect(board.find((b) => b.id === taskId)!.waitingFor).toBe('Копирайтер');
      expect((await card('copywriter')).waitingRuns).toBe(1);
      expect((await post(s, '/api/agents/copywriter/resume')).statusCode).toBe(200);
      await drain();
      expect(
        (await get(s, `/api/tasks/${taskId}`)).json<{ task: { status: string } }>().task.status,
      ).toBe('awaiting_final_approval');

      // Model: settings list only price-list models; anything else is refused.
      const settings = (await get(s, '/api/agents/critic/settings')).json<{
        model: { allowed: string[]; source: string; env: string };
        prompts: { active: { id: string; label: string }; versions: unknown[] };
      }>();
      expect(settings.model.allowed).toContain('claude-haiku-5-5');
      expect(settings.model.source).toBe('.env');
      expect((await post(s, '/api/agents/critic/model', { model: 'not-a-model' })).statusCode).toBe(
        409,
      );
      expect(
        (await post(s, '/api/agents/critic/model', { model: 'claude-haiku-5-5' })).statusCode,
      ).toBe(200);
      expect((await card('critic')).model).toMatchObject({
        name: 'claude-haiku-5-5',
        source: 'panel',
      });
      expect((await post(s, '/api/agents/critic/model/reset')).statusCode).toBe(200);
      expect((await card('critic')).model.source).toBe('.env');

      // Prompt edit creates a new active version; rollback to the previous one.
      const saved = await post(s, '/api/agents/critic/prompts', {
        text: 'Новый промпт Critic: строже к фактам.',
      });
      expect(saved.statusCode).toBe(200);
      expect((await card('critic')).promptVersion).toMatch(/^critic@2#/);
      expect((await post(s, '/api/agents/critic/prompts', { text: '' })).statusCode).toBe(409);
      expect(
        (await post(s, `/api/agents/critic/prompts/${settings.prompts.active.id}/activate`))
          .statusCode,
      ).toBe(200);
      expect((await card('critic')).promptVersion).toBe(settings.prompts.active.label);

      // Test run with a draft prompt: mock, no task on the board.
      const test = await post(s, '/api/agents/ceo/test', { promptText: 'Черновик CEO' });
      expect(test.json<{ ok: boolean; promptVersion: string }>()).toMatchObject({
        ok: true,
        promptVersion: expect.stringMatching(/^ceo@draft#/) as unknown,
      });
      const boardIds = (await get(s, '/api/tasks')).json<{ kind?: string; title: string }[]>();
      expect(boardIds.some((b) => b.title.startsWith('Тест агента'))).toBe(false);

      // Stop all / resume all: visible in status, audited, mirrored to Telegram.
      expect((await post(s, '/api/controls/stop-all')).statusCode).toBe(200);
      expect(
        (await get(s, '/api/status')).json<{ controls: { allPaused: boolean } }>().controls
          .allPaused,
      ).toBe(true);
      expect((await card('ceo')).status).toBe('paused');
      expect((await post(s, '/api/controls/stop-all')).statusCode).toBe(409);
      expect((await post(s, '/api/controls/resume-all')).statusCode).toBe(200);
      expect(mirrored.map((m) => m.text).join('\n')).toMatch(/В панели: Все агенты остановлены/);

      // Without CSRF nothing changes.
      const noCsrf = await app.inject({
        method: 'POST',
        url: '/api/controls/stop-all',
        headers: { cookie: s.cookie, origin: ORIGIN },
      });
      expect(noCsrf.statusCode).toBe(403);
      expect((await post(s, '/api/agents/nobody/pause')).statusCode).toBe(404);

      const audit = await t.db
        .select({ action: schema.auditLog.action, actor: schema.auditLog.actorId })
        .from(schema.auditLog)
        .where(
          sql`${schema.auditLog.action} in ('agent_paused','agent_resumed','agent_model_changed','prompt_saved','prompt_activated','stop_all','resume_all','agent_test')`,
        );
      expect(new Set(audit.map((a) => a.action)).size).toBe(8);
      expect(audit.every((a) => a.actor === 'panel:owner')).toBe(true);
    });

    it('constructor: create draft, fields, prompt, test, activate; code agents are protected', async () => {
      const s = await loginOk();
      mirrored.length = 0;
      const created = await post(s, '/api/agents', {
        name: 'Хэштеги',
        role: 'подбирает хэштеги к постам',
        modelRole: 'worker',
        prompt: 'Подбирай хэштеги строго по теме поста.',
      });
      expect(created.statusCode).toBe(200);
      const id = created.json<{ id: string }>().id;
      expect(id).toBe('heshtegi');
      expect((await post(s, '/api/agents', { name: 'Хэштеги', role: 'ещё раз' })).statusCode).toBe(
        409,
      );
      expect((await post(s, '/api/agents', { name: 'X', role: 'r' })).statusCode).toBe(400);

      type Settings = {
        agent: { status: string; kind: string };
        constructor: { activationProblems: string[]; lastTest: { ok: boolean } | null } | null;
        prompts: { active: { label: string } | null };
      };
      let st = (await get(s, `/api/agents/${id}/settings`)).json<Settings>();
      expect(st.agent).toMatchObject({ status: 'draft', kind: 'constructor' });
      expect(st.constructor!.activationProblems.join(' ')).toMatch(/поле/);
      expect(st.prompts.active!.label).toMatch(/^heshtegi@1#/);

      expect((await post(s, `/api/agents/${id}/activate`)).statusCode).toBe(409);
      const def = await post(s, `/api/agents/${id}/definition`, {
        fields: [{ key: 'tags', label: 'Хэштеги', type: 'list', minItems: 3 }],
        criteria: ['только по теме поста'],
      });
      expect(def.statusCode).toBe(200);
      const test = await post(s, `/api/agents/${id}/test`, {});
      expect(test.json<{ ok: boolean; recorded: boolean }>()).toMatchObject({
        ok: true,
        recorded: true,
      });
      st = (await get(s, `/api/agents/${id}/settings`)).json<Settings>();
      expect(st.constructor!.activationProblems).toEqual([]);
      expect((await post(s, `/api/agents/${id}/activate`)).statusCode).toBe(200);
      const cards = (await get(s, '/api/agents')).json<{ id: string; registryStatus: string }[]>();
      expect(cards.find((c) => c.id === id)!.registryStatus).toBe('active');
      expect(mirrored.map((m) => m.text).join('\n')).toMatch(/Хэштеги» включён/);

      // Registry agents use the same controls (pause, model) as code agents.
      expect((await post(s, `/api/agents/${id}/pause`)).statusCode).toBe(200);
      expect((await post(s, `/api/agents/${id}/resume`)).statusCode).toBe(200);
      expect((await post(s, '/api/agents/ceo/definition', { name: 'Шеф' })).statusCode).toBe(409);
      expect((await post(s, '/api/agents/ceo/delete')).statusCode).toBe(409);
      expect((await post(s, `/api/agents/${id}/delete`)).statusCode).toBe(409); // active
      expect((await post(s, `/api/agents/${id}/deactivate`)).statusCode).toBe(200);
      expect((await post(s, `/api/agents/${id}/delete`)).statusCode).toBe(200);
      expect((await get(s, `/api/agents/${id}/settings`)).statusCode).toBe(404);
      const audit = await t.db
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(sql`${schema.auditLog.details} ->> 'agent' = ${id}`);
      expect(new Set(audit.map((a) => a.action))).toEqual(
        new Set([
          'agent_created',
          'prompt_saved',
          'agent_updated',
          'agent_test',
          'agent_activated',
          'agent_paused',
          'agent_resumed',
          'agent_deactivated',
          'agent_deleted',
        ]),
      );
    });

    it('workspace: board, links (validated, audited, mirrored), layout, events, task path, SSE', async () => {
      const s = await loginOk();
      type Ws = {
        nodes: {
          id: string;
          kind: string;
          status: string;
          card: { id: string } | null;
          position: { x: number };
        }[];
        links: {
          id: string;
          from: string;
          to: string;
          kind: string;
          active: boolean;
          deletable: boolean;
        }[];
      };
      const ws = (await get(s, '/api/workspace')).json<Ws>();
      expect(ws.nodes.map((n) => n.id)).toEqual([
        'brief',
        'ceo',
        'copywriter',
        'critic',
        'seo',
        'image',
        'me',
      ]);
      expect(ws.nodes.find((n) => n.id === 'ceo')!.card).not.toBeNull();
      expect(ws.nodes.find((n) => n.id === 'seo')!.status).toBe('planned');
      const sys = ws.links.find((l) => l.from === 'ceo')!;
      expect(sys).toMatchObject({ kind: 'system', deletable: false, active: true });

      mirrored.length = 0;
      const added = await post(s, '/api/workspace/links', { from: 'critic', to: 'seo' });
      expect(added.statusCode).toBe(200);
      expect(added.json<{ message: string }>().message).toMatch(/заработает/);
      expect(
        (await post(s, '/api/workspace/links', { from: 'critic', to: 'seo' })).statusCode,
      ).toBe(409);
      expect((await post(s, '/api/workspace/links', { from: 'me', to: 'seo' })).statusCode).toBe(
        409,
      );
      expect((await post(s, `/api/workspace/links/${sys.id}/delete`)).statusCode).toBe(409);
      const ws2 = (await get(s, '/api/workspace')).json<Ws>();
      const userLink = ws2.links.find((l) => l.from === 'critic' && l.to === 'seo')!;
      expect(userLink).toMatchObject({ kind: 'user', active: false, deletable: true });
      expect((await post(s, `/api/workspace/links/${userLink.id}/delete`)).statusCode).toBe(200);

      expect(
        (await post(s, '/api/workspace/layout', { positions: { seo: { x: 777, y: 12 } } }))
          .statusCode,
      ).toBe(200);
      expect(
        (await get(s, '/api/workspace')).json<Ws>().nodes.find((n) => n.id === 'seo')!.position.x,
      ).toBe(777);
      expect((await post(s, '/api/workspace/auto-layout')).statusCode).toBe(200);
      const texts = mirrored.map((m) => m.text).join('\n');
      expect(texts).toMatch(/Связь Critic → SEO-менеджер добавлена/);
      expect(texts).toMatch(/удалена/);
      expect(texts).toMatch(/расставлены/);
      expect(texts).not.toMatch(/Положение сохранено/);
      const noCsrf = await app.inject({
        method: 'POST',
        url: '/api/workspace/links',
        headers: { cookie: s.cookie, origin: ORIGIN },
        payload: { from: 'critic', to: 'seo' },
      });
      expect(noCsrf.statusCode).toBe(403);

      // Events feed and the task path view after a task.
      const { taskId } = (await post(s, '/api/tasks', { brief: 'Пост про кофе на вынос' })).json<{
        taskId: string;
      }>();
      await drain();
      const events = (await get(s, '/api/events')).json<{ kind: string; text: string }[]>();
      expect(events.some((e) => e.kind === 'plan_ready')).toBe(true);
      const path = (await get(s, `/api/tasks/${taskId}/path`)).json<{
        nodes: { agent: string; state: string }[];
      }>();
      expect(path.nodes.find((n) => n.agent === 'ceo')!.state).toBe('done');
      expect(path.nodes.find((n) => n.agent === 'copywriter')!.state).toBe('pending');

      // SSE: a new event reaches an open stream.
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const received = await new Promise<string>((resolve, reject) => {
        const req = request(
          `${address}/api/events/stream`,
          { headers: { cookie: s.cookie } },
          (res) => {
            expect(res.headers['content-type']).toMatch(/text\/event-stream/);
            let buf = '';
            res.on('data', (chunk: Buffer) => {
              buf += chunk.toString();
              if (buf.includes('event: agent')) {
                req.destroy();
                resolve(buf);
              }
            });
            void emitEvent(t.db, { brandId, agent: 'ceo', kind: 'info', text: 'SSE проверка' });
          },
        );
        req.on('error', reject);
        req.end();
        setTimeout(() => reject(new Error('no SSE event within 5s')), 5000);
      });
      expect(received).toMatch(/SSE проверка/);
      const anon = await app.inject({ method: 'GET', url: '/api/events/stream' });
      expect(anon.statusCode).toBe(401);
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
        '/api/agents/ceo/settings',
        '/api/workspace',
        '/api/events',
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

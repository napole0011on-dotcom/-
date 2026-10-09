import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, sql } from '@cms/db';
import { LlmClient, processRun } from '@cms/engine';
import {
  budgetCtx,
  llmConfig,
  pricing,
  setupTestDb,
  silentLogger,
  type TestDb,
} from '@cms/engine/testkit';
import { runAgentTest, TEST_TASK_KIND } from './agent-test.js';
import { BrandProfile, upsertBrand } from './brand.js';
import { MockLlmTransport } from './mock-llm.js';
import { promptHistory, syncPromptFiles } from './prompt-store.js';
import { PROMPTS_DIR } from './prompts.js';
import { RecordingChannel } from './testing.js';
import { Workflow } from './workflow.js';

const OWNER = { kind: 'human', id: 'panel:owner' } as const;

describe('stage 2.5 step 2: agent controls (Postgres)', () => {
  let t: TestDb;
  let exportDir: string;
  beforeAll(async () => {
    t = await setupTestDb();
    exportDir = mkdtempSync(path.join(tmpdir(), 'exports-'));
  });
  afterAll(async () => {
    await t?.close();
    rmSync(exportDir, { recursive: true, force: true });
  });

  async function setup() {
    const { brand } = await upsertBrand(
      t.db,
      BrandProfile.parse({ slug: `b-${Math.random().toString(36).slice(2, 8)}`, name: 'Зерно' }),
    );
    const channel = new RecordingChannel();
    const queue: string[] = [];
    const config = {
      ...t.config,
      exportDir,
      budget: budgetCtx().config,
      timezone: 'Europe/Moscow',
      llm: llmConfig(),
    };
    const llm = new LlmClient({
      db: t.db,
      transport: new MockLlmTransport(),
      pricing: pricing(),
      config: llmConfig(),
      budget: budgetCtx(),
      notifier: channel,
      logger: silentLogger,
    });
    const wf = new Workflow({
      db: t.db,
      llm,
      channel,
      enqueue: (id) => Promise.resolve(queue.push(id)),
      config,
      pricing: pricing(),
      logger: silentLogger,
    });
    const deps = {
      db: t.db,
      notifier: channel,
      logger: silentLogger,
      staleAfterSeconds: 60,
      gate: wf.gate,
    };
    const outcomes: string[] = [];
    const drain = async () => {
      while (queue.length)
        outcomes.push(
          await processRun(deps, queue.shift()!, wf.handleRun, new AbortController().signal),
        );
    };
    const task = async (id: string) =>
      (
        await t.db
          .select()
          .from(schema.tasks)
          .where(sql`${schema.tasks.id} = ${id}`)
      )[0]!;
    const runsOf = (taskId: string) =>
      t.db
        .select()
        .from(schema.runs)
        .where(sql`${schema.runs.taskId} = ${taskId}`)
        .orderBy(schema.runs.createdAt);
    const calls = (taskId: string) =>
      t.db
        .select()
        .from(schema.llmCalls)
        .where(sql`${schema.llmCalls.taskId} = ${taskId}`)
        .orderBy(schema.llmCalls.createdAt);
    const audit = (action: string) =>
      t.db
        .select()
        .from(schema.auditLog)
        .where(
          sql`${schema.auditLog.brandId} = ${brand.id} and ${schema.auditLog.action} = ${action}`,
        )
        .orderBy(schema.auditLog.id);
    return { brand, wf, drain, outcomes, task, runsOf, calls, audit, queue, config };
  }

  it('paused agent: new runs wait in the queue (not failed), resume drains them', async () => {
    const s = await setup();
    const { taskId } = await s.wf.submitBrief(s.brand.id, 'Пост про осеннее меню кофейни', OWNER);
    await s.drain();
    expect((await s.task(taskId)).status).toBe('awaiting_plan_approval');

    expect((await s.wf.controls.setPaused(s.brand.id, 'copywriter', true, OWNER)).ok).toBe(true);
    expect((await s.wf.controls.setPaused(s.brand.id, 'copywriter', true, OWNER)).ok).toBe(false);
    await s.wf.decidePlan(taskId, 'approve', OWNER);
    await s.drain();

    // The copy run is held, not failed; no copywriter call was made; attempt not counted.
    const copyRun = (await s.runsOf(taskId)).find((r) => r.agent === 'copywriter')!;
    expect(copyRun).toMatchObject({ status: 'queued', waitingFor: 'agent:copywriter', attempt: 0 });
    expect(s.outcomes.at(-1)).toBe('waiting');
    expect((await s.task(taskId)).status).toBe('in_progress');
    expect((await s.calls(taskId)).filter((c) => c.agent === 'copywriter')).toHaveLength(0);

    // Pausing the critic as well; resuming the copywriter alone is not enough (copy run needs both).
    await s.wf.controls.setPaused(s.brand.id, 'critic', true, OWNER);
    await s.wf.controls.setPaused(s.brand.id, 'copywriter', false, OWNER);
    expect(s.queue).toEqual([copyRun.id]); // released automatically on resume
    await s.drain();
    expect((await s.runsOf(taskId)).find((r) => r.id === copyRun.id)!.waitingFor).toBe(
      'agent:critic',
    );

    await s.wf.controls.setPaused(s.brand.id, 'critic', false, OWNER);
    await s.drain();
    const done = (await s.runsOf(taskId)).find((r) => r.id === copyRun.id)!;
    expect(done).toMatchObject({ status: 'succeeded', waitingFor: null, attempt: 1 });
    expect((await s.task(taskId)).status).toBe('awaiting_final_approval');

    const actions = (await s.audit('agent_paused')).map((a) => a.details);
    expect(actions).toEqual([{ agent: 'copywriter' }, { agent: 'critic' }]);
    expect((await s.audit('agent_resumed')).map((a) => a.actorId)).toEqual([
      'panel:owner',
      'panel:owner',
    ]);
  });

  it('"stop everything" holds every new run; disabled agent holds its runs too', async () => {
    const s = await setup();
    expect((await s.wf.controls.setAllPaused(s.brand.id, true, OWNER)).ok).toBe(true);
    const { taskId } = await s.wf.submitBrief(s.brand.id, 'Анонс бариста-шоу в субботу', OWNER);
    await s.drain();
    expect((await s.runsOf(taskId))[0]).toMatchObject({ status: 'queued', waitingFor: 'all' });
    expect((await s.task(taskId)).status).toBe('draft');

    await s.wf.controls.setDisabled(s.brand.id, 'ceo', true, OWNER);
    await s.wf.controls.setAllPaused(s.brand.id, false, OWNER);
    await s.drain();
    expect((await s.runsOf(taskId))[0]!.waitingFor).toBe('agent:ceo');

    await s.wf.controls.setDisabled(s.brand.id, 'ceo', false, OWNER);
    await s.drain();
    expect((await s.task(taskId)).status).toBe('awaiting_plan_approval');
    expect((await s.audit('stop_all')).length).toBe(1);
    expect((await s.audit('resume_all')).length).toBe(1);
    expect((await s.audit('agent_disabled')).length).toBe(1);
  });

  it('model override: only models from the price list, source shown, reset to .env, audited', async () => {
    const s = await setup();
    const ceo = { id: 'ceo', modelRole: 'ceo' } as const;
    const bad = await s.wf.controls.setModel(s.brand.id, 'ceo', 'gpt-imaginary', OWNER);
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/прайс/);

    expect(s.wf.controls.allowedModels()).toContain('claude-haiku-5-5');
    expect((await s.wf.controls.setModel(s.brand.id, 'ceo', 'claude-haiku-5-5', OWNER)).ok).toBe(
      true,
    );
    expect(await s.wf.controls.modelOf(s.brand.id, ceo as never)).toEqual({
      name: 'claude-haiku-5-5',
      env: 'claude-opus-5-5',
      source: 'panel',
      ignoredOverride: null,
    });

    const { taskId } = await s.wf.submitBrief(s.brand.id, 'Пост про новый десерт', OWNER);
    await s.drain();
    expect((await s.calls(taskId))[0]!.requestedModel).toBe('claude-haiku-5-5');
    const inv = await t.db
      .select()
      .from(schema.agentInvocations)
      .where(sql`${schema.agentInvocations.taskId} = ${taskId}`);
    expect(inv[0]!.model).toBe('claude-haiku-5-5');

    expect((await s.wf.controls.resetModel(s.brand.id, 'ceo', OWNER)).ok).toBe(true);
    expect((await s.wf.controls.modelOf(s.brand.id, ceo as never)).source).toBe('.env');

    // A panel model that is no longer in the price list (provider switched) is not used.
    await t.db
      .update(schema.agentSettings)
      .set({ modelOverride: 'claude-haiku-5.5:free' })
      .where(
        sql`${schema.agentSettings.brandId} = ${s.brand.id} and ${schema.agentSettings.agent} = 'critic'`,
      );
    expect((await s.wf.controls.effectiveModels(s.brand.id)).critic).toBe('claude-opus-5-5');
    expect(
      await s.wf.controls.modelOf(s.brand.id, { id: 'critic', modelRole: 'critic' } as never),
    ).toMatchObject({
      name: 'claude-opus-5-5',
      source: '.env',
      ignoredOverride: 'claude-haiku-5.5:free',
    });
    expect((await s.wf.controls.resetModel(s.brand.id, 'critic', OWNER)).ok).toBe(true);
    expect(
      (await s.wf.controls.modelOf(s.brand.id, { id: 'critic', modelRole: 'critic' } as never))
        .ignoredOverride,
    ).toBeNull();
    expect(
      (await s.audit('agent_model_changed'))
        .map((a) => a.details)
        .filter((x) => (x as { agent: string }).agent === 'ceo'),
    ).toEqual([
      {
        agent: 'ceo',
        from: 'claude-opus-5-5',
        fromSource: '.env',
        to: 'claude-haiku-5-5',
        toSource: 'panel',
      },
      {
        agent: 'ceo',
        from: 'claude-haiku-5-5',
        fromSource: 'panel',
        to: 'claude-opus-5-5',
        toSource: '.env',
      },
    ]);
  });

  it('prompts: DB is the source of truth, edits make versions, rollback, file versions wait', async () => {
    const s = await setup();
    const h1 = await promptHistory(t.db, s.brand.id, 'ceo');
    expect(h1.versions).toHaveLength(1);
    expect(h1.active).toMatchObject({ version: 1, source: 'file' });

    for (const [text, msg] of [
      ['   ', /пустой/],
      ['---\nversion: 3\n---\nТекст', /front matter/],
      ['я'.repeat(17_000), /32 КБ/],
    ] as const) {
      const r = await s.wf.controls.savePrompt(s.brand.id, 'ceo', text, OWNER);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(msg);
    }

    const edited = `${h1.active.text}\n\nДобавь в план хотя бы одну карусель.`;
    const saved = await s.wf.controls.savePrompt(s.brand.id, 'ceo', edited, OWNER);
    expect(saved).toMatchObject({ ok: true, label: expect.stringMatching(/^ceo@2#/) as unknown });
    const h2 = await promptHistory(t.db, s.brand.id, 'ceo');
    expect(h2.active).toMatchObject({ version: 2, source: 'panel', createdBy: 'panel:owner' });

    // Every record of the run carries the version it was produced with.
    const { taskId } = await s.wf.submitBrief(s.brand.id, 'Пост про тыквенный латте', OWNER);
    await s.drain();
    expect((await s.calls(taskId))[0]!.promptVersion).toBe(saved.label);
    const plan = await t.db
      .select()
      .from(schema.artifacts)
      .where(sql`${schema.artifacts.taskId} = ${taskId}`);
    expect(plan[0]!.promptVersion).toBe(saved.label);

    // One-click rollback to v1, audited from -> to.
    const v1 = h2.versions.find((v) => v.version === 1)!;
    expect((await s.wf.controls.activatePrompt(s.brand.id, 'ceo', v1.id, OWNER)).ok).toBe(true);
    expect((await promptHistory(t.db, s.brand.id, 'ceo')).active.version).toBe(1);
    expect((await s.audit('prompt_activated'))[0]!.details).toEqual({
      agent: 'ceo',
      from: saved.label,
      to: v1.label,
    });

    // A changed prompt file is added as a version but NOT activated.
    const dir = mkdtempSync(path.join(tmpdir(), 'prompts-'));
    for (const f of ['ceo.md', 'copywriter.md', 'critic.md', 'ai-cliches.ru.txt'])
      writeFileSync(path.join(dir, f), readFileSync(path.join(PROMPTS_DIR, f)));
    writeFileSync(
      path.join(dir, 'ceo.md'),
      readFileSync(path.join(PROMPTS_DIR, 'ceo.md'), 'utf8').replace(/version: \d+/, 'version: 9') +
        '\nНовое правило из файла.\n',
    );
    const synced = await syncPromptFiles(t.db, s.brand.id, dir);
    expect(synced).toEqual([
      { agent: 'ceo', label: expect.stringMatching(/^ceo@3#/) as unknown, activated: false },
    ]);
    const h3 = await promptHistory(t.db, s.brand.id, 'ceo');
    expect(h3.active.version).toBe(1);
    expect(h3.pendingFile).toMatchObject({ version: 3, source: 'file', fileVersion: 9 });
    // Running the sync again changes nothing.
    expect(await syncPromptFiles(t.db, s.brand.id, dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('test run: mock model, $0, draft prompt, hidden service task, works while paused', async () => {
    const s = await setup();
    await s.wf.controls.setPaused(s.brand.id, 'critic', true, OWNER);
    const deps = { db: t.db, config: s.config, controls: s.wf.controls, logger: silentLogger };
    for (const agent of ['ceo', 'copywriter', 'critic']) {
      const r = await runAgentTest(deps, s.brand.id, agent, {}, OWNER);
      expect(r.ok, r.message).toBe(true);
      expect(r.output).toBeTruthy();
      expect(r.promptVersion).toMatch(new RegExp(`^${agent}@1#`));
    }
    const draft = await runAgentTest(
      deps,
      s.brand.id,
      'ceo',
      { promptText: 'Черновик промпта CEO' },
      OWNER,
    );
    expect(draft.promptVersion).toMatch(/^ceo@draft#/);
    const invalid = await runAgentTest(deps, s.brand.id, 'ceo', { promptText: '' }, OWNER);
    expect(invalid).toMatchObject({ ok: false, message: 'Промпт пустой' });

    const testTasks = await t.db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        sql`${schema.tasks.brandId} = ${s.brand.id} and ${schema.tasks.kind} = ${TEST_TASK_KIND}`,
      );
    expect(testTasks.length).toBe(4);
    const [cost] = await t.db
      .select({ usd: sql<string>`coalesce(sum(${schema.costRecords.costUsd}), 0)` })
      .from(schema.costRecords)
      .where(sql`${schema.costRecords.brandId} = ${s.brand.id}`);
    expect(Number(cost!.usd)).toBe(0);
    expect((await s.audit('agent_test')).length).toBe(4); // the invalid draft is rejected before running
  });
});

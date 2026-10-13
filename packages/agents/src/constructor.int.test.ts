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
import {
  activateConstructorAgent,
  agentNames,
  createConstructorAgent,
  deactivateConstructorAgent,
  deleteConstructorAgent,
  resolveAgent,
  updateConstructorAgent,
} from './agent-registry.js';
import { runAgentTest } from './agent-test.js';
import { BrandProfile, upsertBrand } from './brand.js';
import { MockLlmTransport } from './mock-llm.js';
import { RecordingChannel, seedTestTeam } from './testing.js';
import { Workflow } from './workflow.js';
import { addLink, loadWorkspace } from './workspace.js';

const OWNER = { kind: 'human', id: 'panel:owner' } as const;

const FIELDS = [
  { key: 'hashtags', label: 'Хэштеги', type: 'list', minItems: 3 },
  { key: 'comment', label: 'Комментарий', type: 'text', required: false },
];

describe('agent constructor (Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });

  async function setup() {
    const { brand } = await upsertBrand(
      t.db,
      BrandProfile.parse({ slug: `c-${Math.random().toString(36).slice(2, 8)}`, name: 'Зерно' }),
    );
    await seedTestTeam(t.db, brand.id);
    const channel = new RecordingChannel();
    const queue: string[] = [];
    const config = {
      ...t.config,
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
    const drain = async () => {
      while (queue.length)
        await processRun(deps, queue.shift()!, wf.handleRun, new AbortController().signal);
    };
    const audit = (action: string) =>
      t.db
        .select()
        .from(schema.auditLog)
        .where(
          sql`${schema.auditLog.brandId} = ${brand.id} and ${schema.auditLog.action} = ${action}`,
        );
    const test = (opts: { promptText?: string | null; spec?: unknown } = {}) =>
      runAgentTest(
        { db: t.db, config, controls: wf.controls, logger: silentLogger },
        brand.id,
        'hashtags',
        opts,
        OWNER,
      );
    await loadWorkspace(t.db, brand.id);
    return { brand, channel, wf, drain, audit, test };
  }

  it('draft -> fields + prompt -> test -> activate -> runs as a reviewed board step', async () => {
    const s = await setup();
    const created = await createConstructorAgent(
      t.db,
      s.brand.id,
      {
        id: 'hashtags',
        name: 'Хэштеги',
        role: 'подбирает хэштеги к постам',
        description: '',
        modelRole: 'worker',
        prompt: 'Ты подбираешь хэштеги. Только по теме поста, без общих #love #instagood.',
      },
      OWNER,
    );
    expect(created.ok, created.message).toBe(true);
    const ws = await loadWorkspace(t.db, s.brand.id);
    expect(ws.nodes.find((n) => n.id === 'hashtags')).toMatchObject({
      kind: 'custom',
      teamRole: 'worker',
      status: 'draft',
    });
    expect(ws.layout.hashtags).toBeDefined();

    // Not activatable without fields and a test.
    const release = () => Promise.resolve();
    const early = await activateConstructorAgent(t.db, s.brand.id, 'hashtags', OWNER, release);
    expect(early.ok).toBe(false);
    expect(early.message).toMatch(/поле/);
    expect((await s.test()).message).toMatch(/поле/);

    const bad = await updateConstructorAgent(
      t.db,
      s.brand.id,
      'hashtags',
      { fields: [{ key: 'Bad Key', label: 'x', type: 'text' }] },
      OWNER,
    );
    expect(bad.ok).toBe(false);
    expect(
      (await updateConstructorAgent(t.db, s.brand.id, 'hashtags', { fields: FIELDS }, OWNER)).ok,
    ).toBe(true);

    // A draft test (unsaved prompt) does not count for activation.
    const draftTest = await s.test({ promptText: 'Черновик промпта для хэштегов' });
    expect(draftTest.ok, draftTest.message).toBe(true);
    expect(draftTest.recorded).toBe(false);
    expect(
      (await activateConstructorAgent(t.db, s.brand.id, 'hashtags', OWNER, release)).message,
    ).toMatch(/тест/);

    const ok = await s.test();
    expect(ok.ok, ok.message).toBe(true);
    expect(ok.recorded).toBe(true);
    expect((ok.output as { hashtags: string[] }).hashtags.length).toBeGreaterThanOrEqual(3);
    expect(ok.render?.lines[0]).toMatch(/^Хэштеги: /);
    expect(typeof ok.review?.passed).toBe('boolean');

    const act = await activateConstructorAgent(t.db, s.brand.id, 'hashtags', OWNER, release);
    expect(act.ok, act.message).toBe(true);

    // copywriter -> hashtags -> critic: runs after the texts, reviewed by the Critic.
    expect((await addLink(t.db, s.brand.id, 'copywriter', 'hashtags', OWNER)).ok).toBe(true);
    expect((await addLink(t.db, s.brand.id, 'hashtags', 'critic', OWNER)).ok).toBe(true);
    const { taskId } = await s.wf.submitBrief(s.brand.id, 'Пост про осеннее меню кофейни', OWNER);
    await s.drain();
    expect(s.channel.plans[0]!.pipeline.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: 'hashtags', after: ['copywriter'], reviewed: true }),
      ]),
    );
    await s.wf.decidePlan(taskId, 'approve', OWNER);
    await s.drain();
    const pkg = s.channel.packages[0]!;
    const node = pkg.nodeItems.find((n) => n.agent === 'hashtags')!;
    expect(node.agentName).toBe('Хэштеги');
    expect(node.critic).not.toBeNull();
    const calls = await t.db
      .select({ agent: schema.llmCalls.agent, pv: schema.llmCalls.promptVersion })
      .from(schema.llmCalls)
      .where(sql`${schema.llmCalls.taskId} = ${taskId}`);
    expect(calls.find((c) => c.agent === 'hashtags')?.pv).toMatch(/^hashtags@1#/);
    expect(calls.some((c) => c.agent === 'critic' && c.pv?.startsWith('critic-generic@'))).toBe(
      true,
    );

    // Changing the fields of an active agent makes it a draft again; new plans skip it.
    const edited = await updateConstructorAgent(
      t.db,
      s.brand.id,
      'hashtags',
      { fields: [...FIELDS, { key: 'note', label: 'Заметка', type: 'text', required: false }] },
      OWNER,
    );
    expect(edited.message).toMatch(/черновик/);
    expect((await resolveAgent(t.db, s.brand.id, 'hashtags'))!.status).toBe('draft');
    const t2 = await s.wf.submitBrief(s.brand.id, 'Анонс бариста-шоу', OWNER);
    await s.drain();
    expect(s.channel.plans.at(-1)!.pipeline.steps.map((x) => x.agent)).toEqual(['copywriter']);
    await s.wf.cancelTask(t2.taskId, OWNER);

    // In use by a task in progress -> cannot be deleted; after cancel it can.
    expect((await deleteConstructorAgent(t.db, s.brand.id, 'hashtags', OWNER)).message).toMatch(
      /незавершённой задачи/,
    );
    await s.wf.cancelTask(taskId, OWNER);
    const del = await deleteConstructorAgent(t.db, s.brand.id, 'hashtags', OWNER);
    expect(del.ok, del.message).toBe(true);
    const after = await loadWorkspace(t.db, s.brand.id);
    expect(after.nodes.some((n) => n.id === 'hashtags')).toBe(false);
    expect(after.links.some((l) => l.from === 'hashtags' || l.to === 'hashtags')).toBe(false);

    for (const a of ['agent_created', 'agent_updated', 'agent_activated', 'agent_deleted'])
      expect((await s.audit(a)).length, a).toBeGreaterThan(0);
  });

  it('every agent is editable: a new role makes it a draft again; names are unique; deactivate', async () => {
    const s = await setup();
    expect((await updateConstructorAgent(t.db, s.brand.id, 'ceo', { name: 'Шеф' }, OWNER)).ok).toBe(
      true,
    );
    const role = await updateConstructorAgent(
      t.db,
      s.brand.id,
      'critic',
      { teamRole: 'worker' },
      OWNER,
    );
    expect(role.message).toMatch(/снова черновик/);
    expect(await resolveAgent(t.db, s.brand.id, 'critic')).toMatchObject({
      teamRole: 'worker',
      status: 'draft',
    });
    expect((await s.audit('agent_updated')).at(-1)!.details).toMatchObject({
      teamRole: { from: 'reviewer', to: 'worker' },
    });
    const dup = await createConstructorAgent(
      t.db,
      s.brand.id,
      { name: 'Копирайтер', role: 'ещё один', description: '', modelRole: 'worker' },
      OWNER,
    );
    expect(dup.ok).toBe(false);
    const auto = await createConstructorAgent(
      t.db,
      s.brand.id,
      { name: 'Рерайт сторис', role: 'переписывает сторис', description: '', modelRole: 'worker' },
      OWNER,
    );
    expect(auto.id).toBe('rerayt_storis');
    expect((await deactivateConstructorAgent(t.db, s.brand.id, 'rerayt_storis', OWNER)).ok).toBe(
      false,
    );
    // Model override works for every agent (price list only).
    const model = Object.keys(pricing().models)[0]!;
    expect((await s.wf.controls.setModel(s.brand.id, 'rerayt_storis', model, OWNER)).ok).toBe(true);
    expect((await s.wf.controls.agentModels(s.brand.id)).rerayt_storis).toBe(model);
    expect((await s.wf.controls.setPaused(s.brand.id, 'rerayt_storis', true, OWNER)).ok).toBe(true);
  });

  it('delete: any agent (active too), refused only while an unfinished task has it in its plan', async () => {
    const s = await setup();
    const { taskId } = await s.wf.submitBrief(s.brand.id, 'Пост про осеннее меню кофейни', OWNER);
    await s.drain();
    // In the plan of an unfinished task: the writer (a step), its reviewer and the planner.
    for (const id of ['copywriter', 'critic', 'ceo']) {
      const r = await deleteConstructorAgent(t.db, s.brand.id, id, OWNER);
      expect(r.ok, id).toBe(false);
      expect(r.taskId).toBe(taskId);
      expect(r.message).toMatch(/незавершённой задачи «Пост про осеннее меню кофейни»/);
    }
    // Tools, capability agents and drafts go at once (active ones too: the panel confirms).
    for (const id of ['kp_render', 'image', 'seo', 'stt_voice', 'mailer_send']) {
      const r = await deleteConstructorAgent(t.db, s.brand.id, id, OWNER);
      expect(r.ok, `${id}: ${r.message}`).toBe(true);
      expect(r.message).toMatch(/^Удалён агент «/);
    }
    await s.wf.cancelTask(taskId, OWNER);
    const last = await deleteConstructorAgent(t.db, s.brand.id, 'ceo', OWNER);
    expect(last.message).toMatch(/Планировщиков больше нет/);
    expect((await deleteConstructorAgent(t.db, s.brand.id, 'copywriter', OWNER)).ok).toBe(true);
    // Gone from the board with its links; kept for history (name, prompt versions, audit).
    const ws = await loadWorkspace(t.db, s.brand.id);
    expect(ws.nodes.map((n) => n.id)).not.toContain('ceo');
    expect(ws.links.some((l) => l.from === 'ceo' || l.to === 'ceo')).toBe(false);
    expect((await agentNames(t.db, s.brand.id)).ceo).toBe('Планировщик');
    const prompts = await t.db
      .select()
      .from(schema.promptVersions)
      .where(
        sql`${schema.promptVersions.brandId} = ${s.brand.id} and ${schema.promptVersions.agent} = 'ceo'`,
      );
    expect(prompts.length).toBeGreaterThan(0);
    expect(
      (await s.audit('agent_deleted')).find(
        (a) => (a.details as { agent: string }).agent === 'ceo',
      )!.details,
    ).toMatchObject({
      before: { name: 'Планировщик', teamRole: 'planner', status: 'active' },
      after: null,
    });
    // The same name again: a new agent with a new id.
    const again = await createConstructorAgent(
      t.db,
      s.brand.id,
      {
        name: 'Планировщик',
        role: 'планирует',
        description: '',
        modelRole: 'ceo',
        teamRole: 'planner',
      },
      OWNER,
    );
    expect(again.ok, again.message).toBe(true);
    expect(again.id).not.toBe('ceo');
    // No planner: a new task is accepted and waits, nothing fails.
    const waiting = await s.wf.submitBrief(s.brand.id, 'Ещё один пост про десерты', OWNER);
    expect(waiting).toMatchObject({ planned: false });
    expect(waiting.message).toMatch(/не включён/);
    const [row] = await t.db
      .select()
      .from(schema.tasks)
      .where(sql`${schema.tasks.id} = ${waiting.taskId}`);
    expect(row!.status).toBe('draft');
  });
});

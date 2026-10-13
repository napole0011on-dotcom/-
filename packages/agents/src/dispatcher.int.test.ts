import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentError } from '@cms/core';
import { schema, sql } from '@cms/db';
import { LlmClient, processRun, type LlmRequest, type LlmTransport } from '@cms/engine';
import {
  budgetCtx,
  llmConfig,
  pricing,
  setupTestDb,
  silentLogger,
  type TestDb,
} from '@cms/engine/testkit';
import { BrandProfile, upsertBrand } from './brand.js';
import { MockLlmTransport } from './mock-llm.js';
import type { NodeExecutor, NodeInput } from './nodes.js';
import { RecordingChannel } from './testing.js';
import { Workflow } from './workflow.js';
import { addLink, loadWorkspace } from './workspace.js';

const OWNER = { kind: 'human', id: 'panel:owner' } as const;

const titleOf = (p: LlmRequest) =>
  (p.output_config?.format?.schema as { title?: string } | undefined)?.title ?? '';
const promptOf = (p: LlmRequest) =>
  p.messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : m.content.map((b) => ('text' in b ? b.text : '')).join('\n'),
    )
    .join('\n');

/** The mock model, except for the answers a test scripts (router, critic). */
class ScriptedTransport implements LlmTransport {
  readonly mock = new MockLlmTransport();
  readonly titles: string[] = [];
  readonly prompts: Record<string, string[]> = {};
  route: ((prompt: string) => unknown) | null = null;
  criticAlwaysFails = false;

  async create(params: LlmRequest) {
    const title = titleOf(params);
    this.titles.push(title);
    (this.prompts[title] ??= []).push(promptOf(params));
    const res = await this.mock.create(params);
    const block = res.content[0] as { text: string };
    if (title === 'RouteDecision' && this.route)
      block.text = JSON.stringify(this.route(promptOf(params)));
    if (title === 'CriticOutput' && this.criticAlwaysFails) {
      const body = JSON.parse(block.text) as { reviews: { verdict: string; issues: unknown[] }[] };
      for (const r of body.reviews) {
        r.verdict = 'fail';
        r.issues = [{ variant: null, problem: 'Слишком общо', fix: 'Добавить конкретику' }];
      }
      block.text = JSON.stringify(body);
    }
    return res;
  }

  count(title: string) {
    return this.titles.filter((t) => t === title).length;
  }
}

describe('dispatcher: who gets a step result next (Postgres)', () => {
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

  async function setup(opts: { maxHops?: number; links?: [string, string][] } = {}) {
    const { brand } = await upsertBrand(
      t.db,
      BrandProfile.parse({ slug: `d-${Math.random().toString(36).slice(2, 8)}`, name: 'Зерно' }),
    );
    const channel = new RecordingChannel();
    const transport = new ScriptedTransport();
    const queue: string[] = [];
    const ran: Record<string, NodeInput[]> = {};
    const failOnce = new Set<string>();
    const fake = (id: string): NodeExecutor => ({
      run(_ctx, input) {
        (ran[id] ??= []).push(input);
        if (failOnce.delete(id))
          return Promise.reject(new PermanentError('fake_broken', 'Шаг сломался'));
        return Promise.resolve({
          output: { text: `${id}: готово` },
          promptVersion: `${id}@test`,
          model: 'test',
          costUsd: 0,
        });
      },
      render: (o) => ({ title: id, lines: [(o as { text: string }).text] }),
    });
    const config = {
      ...t.config,
      exportDir,
      budget: budgetCtx().config,
      timezone: 'Europe/Moscow',
      llm: llmConfig(),
      routing: { maxHops: opts.maxHops ?? 12 },
    };
    const llm = new LlmClient({
      db: t.db,
      transport,
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
      executors: { seo: fake('seo'), image: fake('image'), kp: fake('kp') },
    });
    const deps = {
      db: t.db,
      notifier: channel,
      logger: silentLogger,
      staleAfterSeconds: 60,
      gate: wf.gate,
      stopOnFailure: wf.stopOnFailure,
    };
    const drain = async () => {
      while (queue.length)
        await processRun(deps, queue.shift()!, wf.handleRun, new AbortController().signal);
    };
    await loadWorkspace(t.db, brand.id);
    await t.db
      .update(schema.agentDefinitions)
      .set({ status: 'active' })
      .where(
        sql`${schema.agentDefinitions.brandId} = ${brand.id} and ${schema.agentDefinitions.id} = 'seo'`,
      );
    for (const [from, to] of opts.links ?? []) {
      const r = await addLink(t.db, brand.id, from, to, OWNER);
      expect(r.ok, r.message).toBe(true);
    }
    const task = async (id: string) =>
      (
        await t.db
          .select()
          .from(schema.tasks)
          .where(sql`${schema.tasks.id} = ${id}`)
      )[0]!;
    const decisions = (taskId: string) =>
      t.db
        .select()
        .from(schema.routeDecisions)
        .where(sql`${schema.routeDecisions.taskId} = ${taskId}`);
    const start = async (brief = 'Пост про осеннее меню кофейни') => {
      const { taskId } = await wf.submitBrief(brand.id, brief, OWNER);
      await drain();
      await wf.decidePlan(taskId, 'approve', OWNER);
      await drain();
      return taskId;
    };
    return { brand, channel, transport, wf, drain, ran, failOnce, task, decisions, start };
  }

  it('one outgoing link: the result is handed on without the LLM', async () => {
    const s = await setup({ links: [['critic', 'image']] });
    const taskId = await s.start();
    expect((await s.task(taskId)).status).toBe('awaiting_final_approval');
    expect(s.transport.count('RouteDecision')).toBe(0);
    expect(s.ran.image).toHaveLength(1);
    const ds = await s.decisions(taskId);
    expect(ds.map((d) => [d.fromAgent, d.mode, d.targets])).toEqual(
      expect.arrayContaining([
        ['copywriter', 'single', ['image']],
        ['image', 'end', []],
      ]),
    );
    // Board events: who handed what to whom.
    const handoffs = await t.db
      .select()
      .from(schema.agentEvents)
      .where(
        sql`${schema.agentEvents.taskId} = ${taskId} and ${schema.agentEvents.kind} = 'handoff'`,
      );
    expect(handoffs.map((e) => e.text)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Копирайтер → Image: единственная связь/)]),
    );
    expect(handoffs[0]!.payload).toMatchObject({ mode: 'single' });
  });

  it('two links: the router chooses by the agents descriptions; the other step is skipped', async () => {
    const s = await setup({
      links: [
        ['critic', 'image'],
        ['critic', 'kp'],
      ],
    });
    s.transport.route = () => ({
      decision: 'forward',
      targets: [{ agent: 'image', reason: 'для поста нужна картинка' }],
      confidence: 0.8,
    });
    const taskId = await s.start();
    expect((await s.task(taskId)).status).toBe('awaiting_final_approval');
    expect(s.transport.count('RouteDecision')).toBe(1);
    const prompt = s.transport.prompts.RouteDecision![0]!;
    expect(prompt).toMatch(/Можно передать \(id\): image, kp/);
    expect(prompt).toMatch(/<external_data/);
    expect(s.ran.image).toHaveLength(1);
    expect(s.ran.kp).toBeUndefined();
    const d = (await s.decisions(taskId)).find((x) => x.fromAgent === 'copywriter')!;
    expect(d).toMatchObject({ mode: 'router', targets: ['image'], needHelp: false });
    expect(Number(d.confidence)).toBeCloseTo(0.8);
    const audit = await t.db
      .select()
      .from(schema.auditLog)
      .where(
        sql`${schema.auditLog.taskId} = ${taskId} and ${schema.auditLog.action} = 'route_decided'`,
      );
    expect(audit.length).toBeGreaterThanOrEqual(2);
    // The router call is logged on the agent whose result it routed (cost visible on its node).
    const inv = await t.db
      .select()
      .from(schema.agentInvocations)
      .where(
        sql`${schema.agentInvocations.taskId} = ${taskId} and ${schema.agentInvocations.promptVersion} like 'router@code#%'`,
      );
    expect(inv.map((i) => i.agent)).toEqual(['copywriter']);
  });

  it('a choice outside the links is rejected (2 corrections), then the links decide', async () => {
    const s = await setup({
      links: [
        ['critic', 'image'],
        ['critic', 'kp'],
      ],
    });
    s.transport.route = () => ({
      decision: 'forward',
      targets: [{ agent: 'ghost', reason: 'выдумал' }],
      confidence: 0.9,
    });
    const taskId = await s.start();
    expect(s.transport.count('RouteDecision')).toBe(3);
    const d = (await s.decisions(taskId)).find((x) => x.fromAgent === 'copywriter')!;
    expect(d).toMatchObject({ mode: 'fallback' });
    expect([...(d.targets as string[])].sort()).toEqual(['image', 'kp']);
    expect((await s.task(taskId)).status).toBe('awaiting_final_approval');
  });

  it('the hop limit stops the chain and sends what is ready to the owner', async () => {
    const s = await setup({
      maxHops: 1,
      links: [
        ['critic', 'image'],
        ['image', 'kp'],
      ],
    });
    const taskId = await s.start();
    expect(s.ran.image).toHaveLength(1);
    expect(s.ran.kp).toBeUndefined();
    const d = (await s.decisions(taskId)).find((x) => x.fromAgent === 'image')!;
    expect(d).toMatchObject({ mode: 'limit', targets: [] });
    expect((await s.task(taskId)).status).toBe('awaiting_final_approval');
    // An owner decision gives a fresh allowance: «Передать другому» works.
    const r = await s.wf.forwardManually(taskId, 'image', ['kp'], OWNER);
    expect(r.ok, r.message).toBe(true);
    await s.drain();
    expect(s.ran.kp).toHaveLength(1);
  });

  it('Critic «доработать» sends the text back to the author at most twice', async () => {
    const s = await setup();
    s.transport.criticAlwaysFails = true;
    const taskId = await s.start();
    // 1 draft + 2 revisions; then the text goes to the owner marked as not passed.
    expect(s.transport.count('CopywriterOutput')).toBe(3);
    expect(s.transport.count('CriticOutput')).toBe(3);
    expect((await s.task(taskId)).status).toBe('awaiting_final_approval');
    expect(s.channel.packages[0]!.items.every((i) => i.criticRejected)).toBe(true);
  });

  it('the way to «Вы» goes through SEO when the agent is linked to it', async () => {
    const s = await setup({
      links: [
        ['critic', 'seo'],
        ['critic', 'image'],
      ],
    });
    // The router would skip SEO and finish: SEO is added anyway.
    s.transport.route = () => ({ decision: 'done', targets: [], confidence: 0.7 });
    const taskId = await s.start();
    const d = (await s.decisions(taskId)).find((x) => x.fromAgent === 'copywriter')!;
    expect(d.targets).toEqual(['seo']);
    expect((d.reasons as Record<string, string>).seo).toMatch(/SEO обязателен/);
    expect(s.ran.seo).toHaveLength(1);
    expect(s.ran.image).toBeUndefined();
  });

  it('need_help: nothing is handed on, the owner is told and forwards by hand', async () => {
    const s = await setup({
      links: [
        ['critic', 'image'],
        ['critic', 'kp'],
      ],
    });
    s.transport.route = () => ({ decision: 'need_help', targets: [], confidence: 0.2 });
    const taskId = await s.start();
    expect((await s.task(taskId)).status).toBe('awaiting_final_approval');
    expect(s.channel.messages.some((m) => /диспетчер не уверен/.test(m.text))).toBe(true);
    const views = await s.wf.routes(taskId);
    expect(views.find((v) => v.agent === 'copywriter')).toMatchObject({
      needHelp: true,
      targets: [],
      candidates: [
        { agent: 'image', name: 'Image' },
        { agent: 'kp', name: 'КП' },
      ],
    });
    // Only along the plan's links.
    expect((await s.wf.forwardManually(taskId, 'copywriter', ['seo'], OWNER)).ok).toBe(false);
    expect((await s.wf.forwardManually(taskId, 'copywriter', ['kp'], OWNER)).ok).toBe(true);
    expect((await s.task(taskId)).status).toBe('revision');
    await s.drain();
    expect(s.ran.kp).toHaveLength(1);
    expect((await s.task(taskId)).status).toBe('awaiting_final_approval');
  });

  it('a failed step stops the task on that step; «Продолжить с этого шага» re-runs only it', async () => {
    const s = await setup({ links: [['critic', 'image']] });
    s.failOnce.add('image');
    const taskId = await s.start();
    const paused = await s.task(taskId);
    expect(paused.status).not.toBe('failed');
    expect(paused.pauseReason).toMatch(/^step_failed:/);
    const msg = s.channel.messages.at(-1)!;
    expect(msg.text).toMatch(/Шаг «Image» остановился: Шаг сломался/);
    expect(msg.buttons?.[0]?.[0]?.data).toBe(`t:rs:${taskId}`);

    const copyCalls = s.transport.count('CopywriterOutput');
    const r = await s.wf.continueTask(taskId, OWNER);
    expect(r.ok, r.message).toBe(true);
    expect((await s.wf.continueTask(taskId, OWNER)).ok).toBe(false);
    await s.drain();
    expect(s.ran.image).toHaveLength(2);
    expect(s.transport.count('CopywriterOutput')).toBe(copyCalls);
    const done = await s.task(taskId);
    expect(done.pausedAt).toBeNull();
    expect(done.status).toBe('awaiting_final_approval');
  });
});

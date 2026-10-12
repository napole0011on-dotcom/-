import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
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
import { BrandProfile, upsertBrand } from './brand.js';
import { recentEvents } from './events.js';
import { MockLlmTransport } from './mock-llm.js';
import type { NodeExecutor, NodeInput } from './nodes.js';
import { RecordingChannel } from './testing.js';
import { Workflow } from './workflow.js';
import { addLink, deleteLink, loadWorkspace, saveLayout } from './workspace.js';

const OWNER = { kind: 'human', id: 'panel:owner' } as const;

describe('board links drive execution (Postgres)', () => {
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
    const seen: NodeInput[] = [];
    const seo: NodeExecutor = {
      async run(ctx, input) {
        seen.push(input);
        const r = await ctx.llm.callStructured({
          ctx: {
            brandId: ctx.brand.id,
            taskId: ctx.taskId,
            runId: ctx.runId,
            agent: 'seo',
            promptVersion: 'seo@test',
          },
          model: ctx.models.worker,
          system: [{ text: 'SEO test agent' }],
          prompt: JSON.stringify(input.upstream),
          schema: z
            .object({ keywords: z.array(z.string()).min(2), title: z.string() })
            .meta({ title: 'SeoTest' }),
          idempotencyKey: `${ctx.callKey}:seo:${input.step}`,
        });
        return {
          output: r.output,
          promptVersion: 'seo@test',
          model: r.servedModel,
          costUsd: r.costUsd,
        };
      },
      render: (o) => ({
        title: 'Ключи и заголовок',
        lines: (o as { keywords: string[] }).keywords,
      }),
    };
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
      executors: { seo },
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
    const status = async (id: string) =>
      (
        await t.db
          .select()
          .from(schema.tasks)
          .where(sql`${schema.tasks.id} = ${id}`)
      )[0]!.status;
    const audit = (action: string) =>
      t.db
        .select()
        .from(schema.auditLog)
        .where(
          sql`${schema.auditLog.brandId} = ${brand.id} and ${schema.auditLog.action} = ${action}`,
        );
    // SEO becomes a working agent (stage 3 creates it through the constructor).
    await loadWorkspace(t.db, brand.id);
    await t.db
      .update(schema.agentDefinitions)
      .set({ status: 'active' })
      .where(
        sql`${schema.agentDefinitions.brandId} = ${brand.id} and ${schema.agentDefinitions.id} = 'seo'`,
      );
    return { brand, channel, wf, drain, status, seen, audit };
  }

  it('critic -> seo adds a step after the copywriter; package waits for SEO; revision re-runs SEO; export has it', async () => {
    const s = await setup();
    const link = await addLink(t.db, s.brand.id, 'critic', 'seo', OWNER);
    expect(link.ok, link.message).toBe(true);

    const { taskId } = await s.wf.submitBrief(s.brand.id, 'Пост про осеннее меню кофейни', OWNER);
    await s.drain();
    const plan = s.channel.plans[0]!;
    expect(plan.pipeline.steps.map((x) => [x.agent, x.after])).toEqual([
      ['copywriter', []],
      ['seo', ['copywriter']],
    ]);

    // Editing the board after the plan was made does not change this task.
    expect((await deleteLink(t.db, s.brand.id, link.linkId!, OWNER)).ok).toBe(true);
    await s.wf.decidePlan(taskId, 'approve', OWNER);
    await s.drain();
    expect(await s.status(taskId)).toBe('awaiting_final_approval');

    // One package: the texts are shown together with the SEO result that was made from them.
    expect(s.channel.packages).toHaveLength(1);
    const pkg = s.channel.packages[0]!;
    expect(pkg.items.map((i) => i.deliverable.id)).toEqual(['post-1', 'tg-1']);
    expect(pkg.nodeItems).toHaveLength(1);
    expect(pkg.nodeItems[0]).toMatchObject({
      agent: 'seo',
      agentName: 'SEO-менеджер',
      title: 'Ключи и заголовок',
    });
    expect(pkg.totalCount).toBe(3);
    // SEO got the copywriter's texts as input.
    expect(s.seen[0]!.upstream[0]).toMatchObject({ agent: 'copywriter' });
    expect(s.seen[0]!.upstream[0]!.items.length).toBe(2);

    // Revising a text makes the SEO result stale: SEO runs again on the new text.
    const post = pkg.items[0]!;
    expect(
      (await s.wf.decideArtifact(post.artifactId, 'revise', OWNER, { comment: 'Короче' })).ok,
    ).toBe(true);
    await s.drain();
    expect(await s.status(taskId)).toBe('awaiting_final_approval');
    expect(s.seen).toHaveLength(2);
    const update = s.channel.packages[1]!;
    expect(update.isUpdate).toBe(true);
    expect(update.items.map((i) => i.version)).toEqual([2]);
    expect(update.nodeItems.map((i) => i.version)).toEqual([2]);

    // A new task uses the current board (link deleted): no SEO step.
    const t2 = await s.wf.submitBrief(s.brand.id, 'Анонс бариста-шоу в субботу', OWNER);
    await s.drain();
    expect(s.channel.plans.at(-1)!.pipeline.steps.map((x) => x.agent)).toEqual(['copywriter']);
    await s.wf.cancelTask(t2.taskId, OWNER);

    // Approve all (texts + SEO) -> export contains the SEO section.
    expect((await s.wf.approveAll(taskId, OWNER)).ok).toBe(true);
    await s.drain();
    expect(await s.status(taskId)).toBe('exported');
    const md = readFileSync(path.join(s.channel.exports[0]!.dir, 'package.md'), 'utf8');
    expect(md).toMatch(/## SEO-менеджер: Ключи и заголовок/);

    // Live feed has the story of the task.
    const kinds = new Set((await recentEvents(t.db, s.brand.id, 200)).map((e) => e.kind));
    for (const k of [
      'plan_ready',
      'started',
      'finished',
      'verdict',
      'waiting_owner',
      'decision',
      'exported',
    ])
      expect(kinds.has(k as never), k).toBe(true);
    expect((await s.audit('link_added')).length).toBe(1);
    expect((await s.audit('link_deleted')).length).toBe(1);
  });

  it('system links cannot be deleted; invalid links are refused; layout is saved and audited', async () => {
    const s = await setup();
    const ws = await loadWorkspace(t.db, s.brand.id);
    expect(ws.nodes.map((n) => n.id)).toEqual([
      'brief',
      'ceo',
      'copywriter',
      'critic',
      'seo',
      'image',
      'stt_voice',
      'video_transcribe',
      'kp_render',
      'mailer_send',
      'me',
    ]);
    const sys = ws.links.find((l) => l.from === 'ceo' && l.to === 'copywriter')!;
    expect((await deleteLink(t.db, s.brand.id, sys.id, OWNER)).message).toMatch(/нельзя/);
    expect((await addLink(t.db, s.brand.id, 'me', 'seo', OWNER)).ok).toBe(false);
    expect((await addLink(t.db, s.brand.id, 'seo', 'copywriter', OWNER)).ok).toBe(true);
    expect((await addLink(t.db, s.brand.id, 'copywriter', 'seo', OWNER)).message).toMatch(/цикл/);
    // A link to a planned agent is stored but marked as not working yet.
    await t.db
      .update(schema.agentDefinitions)
      .set({ status: 'planned' })
      .where(
        sql`${schema.agentDefinitions.brandId} = ${s.brand.id} and ${schema.agentDefinitions.id} = 'image'`,
      );
    const planned = await addLink(t.db, s.brand.id, 'critic', 'image', OWNER);
    expect(planned.message).toMatch(/заработает/);

    expect((await saveLayout(t.db, s.brand.id, { seo: { x: 900, y: 40 } }, OWNER)).ok).toBe(true);
    expect((await loadWorkspace(t.db, s.brand.id)).layout.seo).toEqual({ x: 900, y: 40 });
    const moved = await s.audit('layout_moved');
    expect(moved[0]!.details).toMatchObject({ changes: [{ node: 'seo', to: { x: 900, y: 40 } }] });

    // ceo -> seo -> copywriter: the copywriter now waits for SEO and gets its result.
    expect((await addLink(t.db, s.brand.id, 'ceo', 'seo', OWNER)).ok).toBe(true);
    const { taskId } = await s.wf.submitBrief(s.brand.id, 'Пост про какао', OWNER);
    await s.drain();
    expect(s.channel.plans[0]!.pipeline.steps.map((x) => [x.agent, x.after])).toEqual([
      ['seo', []],
      ['copywriter', ['seo']],
    ]);
    expect(s.channel.plans[0]!.pipeline.inactive.map((x) => x.agent)).toEqual(['image']);
    await s.wf.decidePlan(taskId, 'approve', OWNER);
    await s.drain();
    expect(await s.status(taskId)).toBe('awaiting_final_approval');
    const copyCall = await t.db
      .select({ req: schema.llmCalls.request })
      .from(schema.llmCalls)
      .where(
        sql`${schema.llmCalls.taskId} = ${taskId} and ${schema.llmCalls.agent} = 'copywriter'`,
      );
    expect(JSON.stringify(copyCall[0]!.req)).toMatch(/external_data/);
  });
});

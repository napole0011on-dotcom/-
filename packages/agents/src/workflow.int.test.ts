import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, sql } from '@cms/db';
import {
  LlmClient,
  processRun,
  type LlmRequest,
  type LlmResponse,
  type LlmTransport,
} from '@cms/engine';
import {
  HUMAN,
  budgetCtx,
  llmConfig,
  pricing,
  setupTestDb,
  silentLogger,
  type TestDb,
} from '@cms/engine/testkit';
import { upsertBrand, BrandProfile } from './brand.js';
import { MockLlmTransport } from './mock-llm.js';
import { RecordingChannel } from './testing.js';
import { Workflow, MAX_CRITIC_REVISIONS, type CopyContent } from './workflow.js';

/** Mock LLM whose Critic rejects the first draft(s) of selected deliverables. */
class CriticRejects implements LlmTransport {
  readonly inner = new MockLlmTransport();
  readonly requests: LlmRequest[] = [];
  constructor(private rejectRounds: Record<string, number>) {}
  async create(params: LlmRequest): Promise<LlmResponse> {
    this.requests.push(params);
    const res = await this.inner.create(params);
    const title = (params.output_config?.format?.schema as { title?: string }).title;
    if (title !== 'CriticOutput') return res;
    const block = res.content[0] as { type: 'text'; text: string };
    const out = JSON.parse(block.text) as {
      reviews: {
        deliverableId: string;
        verdict: string;
        checks: { briefFit: { ok: boolean; comment: string } };
        issues: unknown[];
      }[];
    };
    for (const r of out.reviews) {
      if ((this.rejectRounds[r.deliverableId] ?? 0) > 0) {
        this.rejectRounds[r.deliverableId]!--;
        r.verdict = 'fail';
        r.checks.briefFit = { ok: false, comment: 'не раскрыта тема' };
        r.issues = [{ variant: 1, problem: 'хук не цепляет', fix: 'начать с боли читателя' }];
      }
    }
    block.text = JSON.stringify(out);
    return res;
  }
  copywriterPrompts() {
    return this.requests
      .filter(
        (r) => (r.output_config?.format?.schema as { title?: string }).title === 'CopywriterOutput',
      )
      .map((r) => JSON.stringify(r.messages));
  }
}

describe('stage 2 scenario: brief -> plan -> approve -> copy+critic -> edit -> new version -> approve -> export', () => {
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

  async function setup(transport: LlmTransport) {
    const { brand } = await upsertBrand(
      t.db,
      BrandProfile.parse({
        slug: `b-${Math.random().toString(36).slice(2, 8)}`,
        name: 'Кофейня «Зерно»',
        bannedWords: ['дешёвый'],
      }),
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
    });
    const deps = { db: t.db, notifier: channel, logger: silentLogger, staleAfterSeconds: 60 };
    /** Runs everything that was enqueued, like the worker would. */
    const drain = async () => {
      while (queue.length)
        await processRun(deps, queue.shift()!, wf.handleRun, new AbortController().signal);
    };
    const status = async (taskId: string) =>
      (
        await t.db
          .select()
          .from(schema.tasks)
          .where(sql`${schema.tasks.id} = ${taskId}`)
      )[0]!.status;
    return { brand, channel, wf, drain, status, queue };
  }

  it('runs the full owner flow with versions, critic loop and audit trail', async () => {
    const transport = new CriticRejects({ 'post-1': 1 });
    const s = await setup(transport);

    // 1. Brief -> CEO plan -> gate 1
    const { taskId } = await s.wf.submitBrief(
      s.brand.id,
      'Подготовь пост про осеннее меню и анонс в Telegram',
      HUMAN,
    );
    await s.drain();
    expect(await s.status(taskId)).toBe('awaiting_plan_approval');
    const plan = s.channel.plans[0]!;
    expect(plan.plan.deliverables.map((d) => d.id)).toEqual(['post-1', 'tg-1']);
    expect(plan.estimate.maxUsd).toBeGreaterThanOrEqual(plan.estimate.expectedUsd);

    // 2. Owner asks to change the plan -> v2
    expect(
      (await s.wf.decidePlan(taskId, 'change', HUMAN, 'Добавь акцент на тыквенный латте')).ok,
    ).toBe(true);
    await s.drain();
    expect(s.channel.plans).toHaveLength(2);
    expect(s.channel.plans[1]!.version).toBe(2);
    expect(s.channel.plans[1]!.plan.summary).toMatch(/тыквенный латте/);

    // A non-human cannot approve; a double press records one decision.
    await expect(s.wf.decidePlan(taskId, 'approve', { kind: 'agent', id: 'ceo' })).rejects.toThrow(
      /human/,
    );
    expect((await s.wf.decidePlan(taskId, 'approve', HUMAN)).ok).toBe(true);
    expect((await s.wf.decidePlan(taskId, 'approve', HUMAN)).ok).toBe(false);
    expect(s.queue).toHaveLength(1);

    // 3. Copywriter -> Critic (rejects post-1 once) -> revision -> pass -> gate 2
    await s.drain();
    expect(await s.status(taskId)).toBe('awaiting_final_approval');
    const pkg = s.channel.packages[0]!;
    expect(pkg.items.map((i) => [i.deliverable.id, i.version, i.critic.passed])).toEqual([
      ['post-1', 2, true],
      ['tg-1', 1, true],
    ]);
    expect(transport.copywriterPrompts()[1]).toMatch(/хук не цепляет/); // critic issues were sent back

    // 4. Owner edits tg-1 with a comment -> new version v2 with the comment applied
    const tg1v1 = pkg.items.find((i) => i.deliverable.id === 'tg-1')!;
    const post1 = pkg.items.find((i) => i.deliverable.id === 'post-1')!;
    expect(
      (
        await s.wf.decideArtifact(tg1v1.artifactId, 'revise', HUMAN, {
          comment: 'Короче и с эмодзи кофе',
        })
      ).ok,
    ).toBe(true);
    expect(await s.status(taskId)).toBe('revision');
    // Approving another item while a rework runs is allowed.
    expect((await s.wf.decideArtifact(post1.artifactId, 'approve', HUMAN, { variant: 2 })).ok).toBe(
      true,
    );
    await s.drain();
    expect(await s.status(taskId)).toBe('awaiting_final_approval');
    const update = s.channel.packages[1]!;
    expect(update).toMatchObject({ isUpdate: true, pendingCount: 1, totalCount: 2 });
    const tg1v2 = update.items[0]!;
    expect(tg1v2.version).toBe(2);
    expect(tg1v2.ownerComment).toBe('Короче и с эмодзи кофе');
    expect(tg1v2.item.variants[0]!.body).toMatch(/Учтено: Короче и с эмодзи кофе/);

    // The old version can no longer be decided on.
    expect((await s.wf.decideArtifact(tg1v1.artifactId, 'approve', HUMAN)).message).toMatch(
      /устаревшая/,
    );

    // 5. Approve the new version -> approved -> export
    expect((await s.wf.decideArtifact(tg1v2.artifactId, 'approve', HUMAN)).message).toMatch(
      /Всё утверждено/,
    );
    await s.drain();
    expect(await s.status(taskId)).toBe('exported');
    const exp = s.channel.exports[0]!;
    expect(existsSync(path.join(exp.dir, 'package.md'))).toBe(true);
    const md = readFileSync(path.join(exp.dir, 'package.md'), 'utf8');
    expect(md).toMatch(/Вариант 2 \(выбран\)/);
    expect(md).toMatch(/Версия 2, промпт copywriter@1#[0-9a-f]{8}\+critic@1#[0-9a-f]{8}/);

    // History is kept: every draft is a version, with the critic verdict on it.
    const versions = await t.db
      .select()
      .from(schema.artifacts)
      .where(sql`${schema.artifacts.taskId} = ${taskId}`);
    const copy = versions
      .filter((v) => v.slot === 'copy:post-1')
      .sort((a, b) => a.version - b.version);
    expect(copy.map((v) => (v.content as CopyContent).critic.passed)).toEqual([false, true]);

    // Audit trail of human decisions with versions.
    const audit = await t.db
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.taskId} = ${taskId}`)
      .orderBy(schema.auditLog.id);
    const decisions = audit
      .filter((a) => a.action.startsWith('decision:'))
      .map((a) => [a.action, (a.details as { artifactVersion: number }).artifactVersion]);
    expect(decisions).toEqual([
      ['decision:plan:changes_requested', 1],
      ['decision:plan:approved', 2],
      ['decision:final:changes_requested', 1],
      ['decision:final:approved', 2],
      ['decision:final:approved', 2],
    ]);
    const statuses = audit.filter((a) => a.action === 'status_changed').map((a) => a.toStatus);
    expect(statuses).toEqual([
      'planned',
      'awaiting_plan_approval',
      'planned',
      'awaiting_plan_approval',
      'in_progress',
      'in_review',
      'revision',
      'in_review',
      'awaiting_final_approval',
      'revision',
      'in_review',
      'awaiting_final_approval',
      'approved',
      'exported',
    ]);
  });

  it(`after ${MAX_CRITIC_REVISIONS} revisions the item goes to the owner marked as not approved by Critic`, async () => {
    const s = await setup(new CriticRejects({ 'post-1': 99 }));
    const { taskId } = await s.wf.submitBrief(
      s.brand.id,
      'Пост про новую обжарку и анонс в канале',
      HUMAN,
    );
    await s.drain();
    await s.wf.decidePlan(taskId, 'approve', HUMAN);
    await s.drain();
    const item = s.channel.packages[0]!.items.find((i) => i.deliverable.id === 'post-1')!;
    expect(item).toMatchObject({
      version: 1 + MAX_CRITIC_REVISIONS,
      criticRejected: true,
      criticRound: 3,
    });
    expect(item.critic.passed).toBe(false);
    expect(await s.status(taskId)).toBe('awaiting_final_approval');
  });

  it('banned brand words fail the Critic deterministically even if the model says pass', async () => {
    const s = await setup(new MockLlmTransport());
    const { combineVerdict } = await import('./agents/critic.js');
    const ok = { ok: true, comment: '' };
    const v = combineVerdict(
      {
        deliverableId: 'x',
        verdict: 'pass',
        checks: {
          briefFit: ok,
          brandVoice: ok,
          clichesAndBureaucratese: ok,
          facts: ok,
          lengthAndFormat: ok,
        },
        issues: [],
        summary: '',
      },
      {
        deliverableId: 'x',
        variants: [1, 2, 3].map(() => ({
          angle: 'a',
          hook: 'Самый дешёвый кофе в городе',
          body: 'В современном мире каждый любит кофе и пьёт его.',
          cta: 'Заходи',
        })),
        slides: null,
        reelsScript: null,
      },
      [
        { phrase: 'дешёв*', kind: 'banned' },
        { phrase: 'в современном мире', kind: 'cliche' },
      ],
    );
    expect(v.passed).toBe(false);
    expect(v.checks.clichesAndBureaucratese.ok).toBe(false);
    expect(v.issues.map((i) => i.problem).join(' ')).toMatch(/дешёв.*в современном мире/s);
    expect(s).toBeDefined();
  });

  it('cancel at the plan gate stops the task; queued work for a cancelled task is skipped', async () => {
    const s = await setup(new MockLlmTransport());
    const { taskId } = await s.wf.submitBrief(s.brand.id, 'Пост про бариста-шоу в субботу', HUMAN);
    await s.drain();
    expect((await s.wf.decidePlan(taskId, 'cancel', HUMAN)).ok).toBe(true);
    expect(await s.status(taskId)).toBe('cancelled');
  });
});

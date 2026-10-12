import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
import { LocalFsStorage, MockImageProvider } from '@cms/providers';
import { resolveAgent } from './agent-registry.js';
import { BrandProfile, upsertBrand } from './brand.js';
import { codeExecutors } from './executors.js';
import { MockLlmTransport } from './mock-llm.js';
import { installPresets } from './presets.js';
import { RecordingChannel } from './testing.js';
import { Workflow } from './workflow.js';
import { addLink, loadWorkspace } from './workspace.js';

const OWNER = { kind: 'human', id: 'panel:owner' } as const;

describe('stage 3: SEO preset (constructor) and Image (code, mock Magnific)', () => {
  let t: TestDb;
  let dir: string;
  beforeAll(async () => {
    t = await setupTestDb();
    dir = mkdtempSync(path.join(tmpdir(), 'stage3-'));
  });
  afterAll(async () => {
    await t?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('SEO is installed through the constructor path; Image generates files; export has both', async () => {
    const { brand } = await upsertBrand(
      t.db,
      BrandProfile.parse({ slug: 'stage3', name: 'Зерно' }),
    );
    const channel = new RecordingChannel();
    const queue: string[] = [];
    const config = {
      ...t.config,
      exportDir: path.join(dir, 'exports'),
      budget: budgetCtx().config,
      timezone: 'Europe/Moscow',
      llm: llmConfig(),
      imageMaxCostUsd: 0.1,
    };
    const storage = new LocalFsStorage(path.join(dir, 'storage'));
    const image = new MockImageProvider();
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
      storage,
      executors: codeExecutors({ db: t.db, config, image, storage }),
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

    const ws = await loadWorkspace(t.db, brand.id);
    expect(ws.nodes.find((n) => n.id === 'image')).toMatchObject({
      kind: 'code',
      status: 'active',
    });
    const testDeps = { db: t.db, config, controls: wf.controls, logger: silentLogger };
    expect(await installPresets(testDeps, brand.id)).toEqual(['seo']);
    expect(await installPresets(testDeps, brand.id)).toEqual([]); // once
    const seo = await resolveAgent(t.db, brand.id, 'seo');
    expect(seo).toMatchObject({ status: 'active', kind: 'constructor' });
    expect((seo!.spec as { lastTest: { ok: boolean } }).lastTest.ok).toBe(true);

    for (const [a, b] of [
      ['copywriter', 'image'],
      ['image', 'critic'],
      ['critic', 'seo'],
    ] as const)
      expect((await addLink(t.db, brand.id, a, b, OWNER)).ok).toBe(true);

    const { taskId } = await wf.submitBrief(
      brand.id,
      'Пост для Instagram и пост для Telegram про осеннее меню кофейни',
      OWNER,
    );
    await drain();
    const steps = channel.plans[0]!.pipeline.steps;
    expect(steps.find((s) => s.agent === 'image')).toMatchObject({
      after: ['copywriter'],
      reviewed: true,
    });
    expect(steps.find((s) => s.agent === 'seo')!.after).toEqual(
      expect.arrayContaining(['copywriter', 'image']),
    );
    await wf.decidePlan(taskId, 'approve', OWNER);
    await drain();

    const runs = await t.db
      .select({ s: schema.runs.status, e: schema.runs.error, i: schema.runs.input })
      .from(schema.runs)
      .where(sql`${schema.runs.taskId} = ${taskId}`);
    expect(runs.filter((r) => r.s !== 'succeeded')).toEqual([]);
    const pkg = channel.packages[0]!;
    const img = pkg.nodeItems.find((n) => n.agent === 'image')!;
    expect(img.files.length).toBeGreaterThan(0);
    expect(img.files[0]!.mimeType).toBe('image/png');
    expect(img.critic).not.toBeNull();
    const seoItem = pkg.nodeItems.find((n) => n.agent === 'seo')!;
    expect(seoItem.lines.join('\n')).toMatch(/Хэштеги: /);
    expect(image.calls.length).toBe(img.files.length);

    // Every image went through the budget (reserve -> final, $0 for the mock).
    const costs = await t.db
      .select()
      .from(schema.costRecords)
      .where(
        sql`${schema.costRecords.taskId} = ${taskId} and ${schema.costRecords.kind} = 'image'`,
      );
    expect(costs.length).toBe(img.files.length);
    expect(costs.every((c) => c.status === 'final' && Number(c.costUsd) === 0)).toBe(true);

    expect((await wf.approveAll(taskId, OWNER)).ok).toBe(true);
    await drain();
    const exportDir = channel.exports[0]!.dir;
    const md = readFileSync(path.join(exportDir, 'package.md'), 'utf8');
    expect(md).toMatch(/## SEO-менеджер:/);
    expect(md).toMatch(/файл: image\//);
    const files = readdirSync(path.join(exportDir, 'image'));
    expect(files.length).toBe(img.files.length);
    expect(existsSync(path.join(exportDir, 'image', files[0]!))).toBe(true);
  });
});

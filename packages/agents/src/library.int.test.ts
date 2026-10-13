import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { activationProblems, deleteConstructorAgent, resolveAgent } from './agent-registry.js';
import { BrandProfile, upsertBrand } from './brand.js';
import { overlaps } from './graph.js';
import {
  LIBRARY_DIR,
  addFromTemplate,
  createBasicTeam,
  deleteTemplate,
  exportTemplate,
  getTemplate,
  importTemplate,
  listTemplates,
  saveAgentAsTemplate,
  syncLibrary,
  updateTemplate,
} from './library.js';
import { MockLlmTransport } from './mock-llm.js';
import { activePrompt } from './prompt-store.js';
import { RecordingChannel } from './testing.js';
import { Workflow } from './workflow.js';
import { loadWorkspace } from './workspace.js';

const OWNER = { kind: 'human', id: 'panel:owner' } as const;

describe('agent library and the first start (Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await setupTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  const brand = async () => {
    const { brand: b } = await upsertBrand(
      t.db,
      BrandProfile.parse({ slug: `l-${Math.random().toString(36).slice(2, 8)}`, name: 'Зерно' }),
    );
    await loadWorkspace(t.db, b.id);
    await syncLibrary(t.db, b.id);
    return b.id;
  };
  const audit = (b: string, action: string) =>
    t.db
      .select()
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.brandId} = ${b} and ${schema.auditLog.action} = ${action}`);

  it('library:sync: files -> templates once; the owner edits and deletes win over the files', async () => {
    const b = await brand();
    const all = await listTemplates(t.db, b);
    expect(all.length).toBeGreaterThanOrEqual(19);
    expect(all.every((x) => x.system && x.version === 1)).toBe(true);
    expect(await syncLibrary(t.db, b)).toEqual({ added: [], updated: [], skipped: [] });

    // A copy of the folder with one file changed and one owner edit and one owner delete.
    const dir = mkdtempSync(path.join(tmpdir(), 'library-'));
    cpSync(LIBRARY_DIR, dir, { recursive: true });
    const f = path.join(dir, 'taglines.yaml');
    writeFileSync(f, readFileSync(f, 'utf8').replace('name: Слоганы', 'name: Слоганы и девизы'));
    const h = path.join(dir, 'headlines.yaml');
    writeFileSync(h, readFileSync(h, 'utf8').replace('name: Заголовки', 'name: Заголовки 2'));
    expect((await updateTemplate(t.db, b, 'headlines', { name: 'Мои заголовки' }, OWNER)).ok).toBe(
      true,
    );
    expect((await deleteTemplate(t.db, b, 'hashtags', OWNER)).ok).toBe(true);
    const r = await syncLibrary(t.db, b, dir);
    expect(r.updated).toEqual(['taglines']);
    expect(r.skipped.sort()).toEqual(['hashtags', 'headlines']);
    expect(await getTemplate(t.db, b, 'taglines')).toMatchObject({
      name: 'Слоганы и девизы',
      version: 2,
    });
    expect(await getTemplate(t.db, b, 'headlines')).toMatchObject({
      name: 'Мои заголовки',
      system: false,
    });
    expect(await getTemplate(t.db, b, 'hashtags')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
    for (const a of ['library_synced', 'template_saved', 'template_deleted'])
      expect((await audit(b, a)).length, a).toBeGreaterThan(0);
  });

  it('«Добавить»: a draft copy (new id), fields, criteria, prompt, never on top of a card', async () => {
    const b = await brand();
    const r = await addFromTemplate(t.db, b, 'taglines', OWNER, { x: 900, y: 700 });
    expect(r.ok, r.message).toBe(true);
    const ref = (await resolveAgent(t.db, b, r.id!))!;
    expect(ref).toMatchObject({
      kind: 'custom',
      teamRole: 'worker',
      status: 'draft',
      name: 'Слоганы',
    });
    expect(ref.spec).toMatchObject({ fields: [{ key: 'lines' }] });
    expect((await activePrompt(t.db, b, r.id!)).text).toMatch(/креативный копирайтер/);
    expect((await activationProblems(t.db, b, ref)).length).toBeGreaterThan(0); // a test first
    let ws = await loadWorkspace(t.db, b);
    expect(ws.layout[r.id!]).toEqual({ x: 900, y: 700 });
    const onBrief = await addFromTemplate(t.db, b, 'headlines', OWNER, ws.layout.brief);
    ws = await loadWorkspace(t.db, b);
    for (const [id, p] of Object.entries(ws.layout))
      if (id !== onBrief.id) expect(overlaps(p, ws.layout[onBrief.id!]!), id).toBe(false);
    // The same name twice is refused; after deleting the agent the template gives a new id.
    expect((await addFromTemplate(t.db, b, 'taglines', OWNER)).message).toMatch(/уже есть/);
    expect((await deleteConstructorAgent(t.db, b, r.id!, OWNER)).ok).toBe(true);
    const again = await addFromTemplate(t.db, b, 'taglines', OWNER);
    expect(again.ok).toBe(true);
    expect(again.id).not.toBe(r.id);
    // A tool template becomes a tool agent: a capability, no prompt.
    const tool = await addFromTemplate(t.db, b, 'kp_render', OWNER);
    expect(await resolveAgent(t.db, b, tool.id!)).toMatchObject({
      capability: 'kp_render',
      promptAgent: null,
      modelRole: null,
    });
  });

  it('empty board -> «Базовая команда» -> a task goes from the queue through the steps to the gate', async () => {
    const b = await brand();
    const channel = new RecordingChannel();
    const queue: string[] = [];
    const config = {
      ...t.config,
      budget: budgetCtx().config,
      timezone: 'Europe/Moscow',
      llm: llmConfig(),
    };
    const wf = new Workflow({
      db: t.db,
      llm: new LlmClient({
        db: t.db,
        transport: new MockLlmTransport(),
        pricing: pricing(),
        config: llmConfig(),
        budget: budgetCtx(),
        notifier: channel,
        logger: silentLogger,
      }),
      channel,
      enqueue: (id) => Promise.resolve(queue.push(id)),
      config,
      pricing: pricing(),
      logger: silentLogger,
    });
    const drain = async () => {
      while (queue.length)
        await processRun(
          {
            db: t.db,
            notifier: channel,
            logger: silentLogger,
            staleAfterSeconds: 60,
            gate: wf.gate,
          },
          queue.shift()!,
          wf.handleRun,
          new AbortController().signal,
        );
    };
    // No agents yet: the task is accepted, waits in «приём» and says why; nothing fails.
    const early = await wf.submitBrief(b, 'Пост про осеннее меню кофейни', OWNER);
    expect(early).toMatchObject({ planned: false });
    expect(early.message).toMatch(/^Нет планировщика: создайте агента с ролью «Планировщик»/);
    expect(queue).toEqual([]);
    expect(channel.messages.at(-1)!.text).toMatch(/Задача принята, но не запущена/);

    const team = await createBasicTeam(
      {
        db: t.db,
        config,
        controls: wf.controls,
        logger: silentLogger,
        release: () => Promise.resolve(),
      },
      b,
      OWNER,
    );
    expect(team.ok, team.message).toBe(true);
    expect(team.agents).toEqual(['planner', 'copywriter', 'reviewer']);
    const ws = await loadWorkspace(t.db, b);
    expect(ws.nodes.filter((n) => n.kind !== 'human').every((n) => n.status === 'active')).toBe(
      true,
    );
    expect(ws.links.map((l) => `${l.from}>${l.to}`).sort()).toEqual([
      'brief>planner',
      'copywriter>reviewer',
      'planner>copywriter',
      'reviewer>me',
    ]);
    for (const a of ['agent_from_template', 'link_added', 'agent_test', 'agent_activated'])
      expect((await audit(b, a)).length, a).toBeGreaterThan(0);

    // The task that waited starts now; the plan names the reviewer of the writer.
    expect((await wf.retryPlanning(early.taskId, OWNER)).ok).toBe(true);
    await drain();
    expect(channel.plans[0]!.pipeline).toMatchObject({
      planner: 'planner',
      steps: [{ agent: 'copywriter', reviewer: 'reviewer' }],
    });
    await wf.decidePlan(early.taskId, 'approve', OWNER);
    await drain();
    const [task] = await t.db
      .select()
      .from(schema.tasks)
      .where(sql`${schema.tasks.id} = ${early.taskId}`);
    expect(task!.status).toBe('awaiting_final_approval');
    expect(channel.packages[0]!.items.every((i) => i.critic !== null)).toBe(true);
  });

  it('own templates: versions; export without secrets -> import; strict schema', async () => {
    const b = await brand();
    const added = await addFromTemplate(t.db, b, 'hashtags', OWNER);
    expect(await saveAgentAsTemplate(t.db, b, added.id!, 'Контент', OWNER)).toMatchObject({
      ok: true,
      version: 2, // the slug of the starting template: the owner's version on top of it
    });
    const other = await brand();
    const file = exportTemplate((await getTemplate(t.db, b, 'hashtags'))!);
    expect(JSON.stringify(file)).not.toMatch(/apiKey|token|secret|password|brand/i);
    const renamed = { ...file, template: { ...file.template, slug: 'my_tags', name: 'Мои теги' } };
    expect((await importTemplate(t.db, other, renamed, OWNER)).version).toBe(1);
    expect((await importTemplate(t.db, other, renamed, OWNER)).version).toBe(2);
    expect(await getTemplate(t.db, other, 'my_tags')).toMatchObject({
      version: 2,
      source: 'import',
    });
    const bad = await importTemplate(
      t.db,
      other,
      { ...renamed, template: { ...renamed.template, apiKey: 'sk-test' } },
      OWNER,
    );
    expect(bad.ok).toBe(false);
    expect((await addFromTemplate(t.db, other, 'my_tags', OWNER)).ok).toBe(true);
  });
});

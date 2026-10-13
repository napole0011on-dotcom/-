import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, sql } from '@cms/db';
import { LlmClient } from '@cms/engine';
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
  createConstructorAgent,
  resolveAgent,
} from './agent-registry.js';
import { runAgentTest } from './agent-test.js';
import { defaultComposition } from './blocks.js';
import { BrandProfile, upsertBrand } from './brand.js';
import {
  buildComposition,
  getComposition,
  rollbackComposition,
  saveComposition,
} from './compositions.js';
import { MockLlmTransport } from './mock-llm.js';
import { activePrompt } from './prompt-store.js';
import { RecordingChannel, seedTestTeam } from './testing.js';
import { Workflow } from './workflow.js';
import { loadWorkspace } from './workspace.js';

const OWNER = { kind: 'human', id: 'panel:owner' } as const;

describe('agents from blocks (Postgres)', () => {
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
      BrandProfile.parse({ slug: `k-${Math.random().toString(36).slice(2, 8)}`, name: 'Зерно' }),
    );
    await seedTestTeam(t.db, brand.id);
    const channel = new RecordingChannel();
    const config = { ...t.config, budget: budgetCtx().config, llm: llmConfig() };
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
      enqueue: () => Promise.resolve(),
      config,
      pricing: pricing(),
      logger: silentLogger,
    });
    await loadWorkspace(t.db, brand.id);
    const created = await createConstructorAgent(
      t.db,
      brand.id,
      {
        id: 'taglines',
        name: 'Слоганы',
        role: 'придумывает слоганы',
        description: '',
        modelRole: 'worker',
      },
      OWNER,
    );
    expect(created.ok, created.message).toBe(true);
    const audit = (action: string) =>
      t.db
        .select()
        .from(schema.auditLog)
        .where(
          sql`${schema.auditLog.brandId} = ${brand.id} and ${schema.auditLog.action} = ${action}`,
        );
    return { brand, wf, audit };
  }

  const composition = (fields: unknown[]) => {
    const c = defaultComposition('Ты придумываешь короткие слоганы для постов кофейни, 3–6 слов.');
    c.blocks.find((b) => b.id === 'output')!.config = { fields };
    c.blocks.push({
      id: 'chk',
      type: 'check',
      x: 900,
      y: 200,
      config: { criteria: ['не длиннее 6 слов'] },
    });
    c.links.push({ from: 'output', to: 'chk' });
    return c;
  };
  const FIELD = {
    key: 'lines',
    label: 'Слоганы',
    type: 'list',
    required: true,
    hint: '',
    minItems: 3,
  };

  it('save -> versions -> build into a draft -> mock test -> activate; rollback keeps history', async () => {
    const s = await setup();
    const empty = await getComposition(t.db, s.brand.id, 'taglines');
    expect(empty).toMatchObject({ version: null, builtVersion: null });
    expect(empty!.composition.blocks.map((b) => b.type)).toEqual([
      'input',
      'role',
      'model',
      'output',
      'gate',
    ]);

    // Nothing to build before a save; a broken composition explains itself.
    expect((await buildComposition(t.db, s.brand.id, 'taglines', s.wf.controls, OWNER)).ok).toBe(
      false,
    );
    expect(
      (await saveComposition(t.db, s.brand.id, 'taglines', composition([]), OWNER)).version,
    ).toBe(1);
    const bad = await buildComposition(t.db, s.brand.id, 'taglines', s.wf.controls, OWNER);
    expect(bad.ok).toBe(false);
    expect(bad.problems).toEqual([expect.stringMatching(/добавьте хотя бы одно поле/)]);

    expect(
      (await saveComposition(t.db, s.brand.id, 'taglines', composition([FIELD]), OWNER)).version,
    ).toBe(2);
    const built = await buildComposition(t.db, s.brand.id, 'taglines', s.wf.controls, OWNER);
    expect(built.ok, built.message).toBe(true);
    expect(built.message).toMatch(/черновик обновлён/);
    const ref = (await resolveAgent(t.db, s.brand.id, 'taglines'))!;
    expect(ref.status).toBe('draft');
    expect(ref.spec).toMatchObject({ fields: [{ key: 'lines' }], criteria: ['не длиннее 6 слов'] });
    expect((await activePrompt(t.db, s.brand.id, 'taglines'))?.text).toMatch(
      /^Ты придумываешь короткие слоганы/,
    );
    const links = (await loadWorkspace(t.db, s.brand.id)).links.filter(
      (l) => l.from === 'taglines',
    );
    expect(links.map((l) => l.to).sort()).toEqual(['critic', 'me']);

    // Activation only after a mock test of exactly this build.
    const release = () => Promise.resolve();
    expect((await activateConstructorAgent(t.db, s.brand.id, 'taglines', OWNER, release)).ok).toBe(
      false,
    );
    const test = await runAgentTest(
      {
        db: t.db,
        config: { ...t.config, llm: llmConfig() },
        controls: s.wf.controls,
        logger: silentLogger,
      },
      s.brand.id,
      'taglines',
      {},
      OWNER,
    );
    expect(test.ok, test.message).toBe(true);
    const act = await activateConstructorAgent(t.db, s.brand.id, 'taglines', OWNER, release);
    expect(act.ok, act.message).toBe(true);

    // Rollback to v1 = new v3 with v1's blocks; the history stays.
    const rb = await rollbackComposition(t.db, s.brand.id, 'taglines', 1, OWNER);
    expect(rb).toMatchObject({ ok: true, version: 3 });
    const view = (await getComposition(t.db, s.brand.id, 'taglines'))!;
    expect(view.versions.map((v) => [v.version, v.note, v.built])).toEqual([
      [3, 'откат к версии 1', false],
      [2, 'сохранено', true],
      [1, 'сохранено', false],
    ]);
    expect(view.builtVersion).toBe(2);
    for (const a of ['composition_saved', 'composition_built', 'composition_rollback'])
      expect((await s.audit(a)).length, a).toBeGreaterThan(0);
  });

  it('any agent can be built from blocks; invalid compositions are refused', async () => {
    const s = await setup();
    expect(
      (await saveComposition(t.db, s.brand.id, 'copywriter', defaultComposition(), OWNER)).ok,
    ).toBe(true);
    const c = defaultComposition();
    c.links.push({ from: 'role', to: 'ghost' });
    expect((await saveComposition(t.db, s.brand.id, 'taglines', c, OWNER)).ok).toBe(false);
  });
});

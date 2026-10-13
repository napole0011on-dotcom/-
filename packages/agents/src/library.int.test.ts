import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, sql } from '@cms/db';
import { setupTestDb, type TestDb } from '@cms/engine/testkit';
import { activationProblems, resolveAgent } from './agent-registry.js';
import { BrandProfile, upsertBrand } from './brand.js';
import { overlaps } from './graph.js';
import {
  addFromTemplate,
  exportTemplate,
  getTemplate,
  importTemplate,
  listTemplates,
  saveAgentAsTemplate,
} from './library.js';
import { activePrompt } from './prompt-store.js';
import { loadWorkspace } from './workspace.js';

const OWNER = { kind: 'human', id: 'panel:owner' } as const;

describe('agent library (Postgres)', () => {
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
    return b.id;
  };

  it('«Добавить»: a draft copy with fields, criteria and prompt, at the drop position', async () => {
    const b = await brand();
    const r = await addFromTemplate(t.db, b, 'sys:taglines', OWNER, { x: 900, y: 700 });
    expect(r.ok, r.message).toBe(true);
    const ref = (await resolveAgent(t.db, b, r.id!))!;
    expect(ref).toMatchObject({ kind: 'constructor', status: 'draft', name: 'Слоганы' });
    expect(ref.spec).toMatchObject({ fields: [{ key: 'lines' }] });
    expect((ref.spec as { criteria: string[] }).criteria.length).toBeGreaterThan(0);
    expect((await activePrompt(t.db, b, r.id!))?.text).toMatch(/креативный копирайтер/);
    // Still a draft: switched on only after a test.
    expect((await activationProblems(t.db, b, ref)).length).toBeGreaterThan(0);
    const ws = await loadWorkspace(t.db, b);
    expect(ws.layout[r.id!]).toEqual({ x: 900, y: 700 });
    // Dropped onto another card: moved to the closest free spot instead.
    const onCeo = await addFromTemplate(t.db, b, 'sys:headlines', OWNER, ws.layout.ceo);
    const after = await loadWorkspace(t.db, b);
    const mine = after.layout[onCeo.id!]!;
    for (const [id, p] of Object.entries(after.layout))
      if (id !== onCeo.id) expect(overlaps(p, mine), id).toBe(false);
    // A second copy gets its own id and name check.
    expect((await addFromTemplate(t.db, b, 'sys:taglines', OWNER)).message).toMatch(/уже есть/);
  });

  it('tool templates that need a key are not added', async () => {
    const b = await brand();
    const r = await addFromTemplate(t.db, b, 'sys:magnific_images', OWNER);
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/нужен ключ/);
  });

  it('own templates: save -> versions; export -> import; system templates are read-only', async () => {
    const b = await brand();
    const added = await addFromTemplate(t.db, b, 'sys:hashtags', OWNER);
    expect(added.ok, added.message).toBe(true);
    // The owner's copy goes back to the library as their own template, with versions.
    expect(await saveAgentAsTemplate(t.db, b, added.id!, 'Контент', OWNER)).toMatchObject({
      ok: true,
      version: 1,
    });
    expect((await saveAgentAsTemplate(t.db, b, added.id!, 'Контент', OWNER)).version).toBe(2);

    const other = await brand();
    const file = exportTemplate((await getTemplate(t.db, b, 'sys:hashtags'))!);
    const renamed = { ...file, template: { ...file.template, slug: 'my_tags', name: 'Мои теги' } };
    expect((await importTemplate(t.db, other, renamed, OWNER)).version).toBe(1);
    expect((await importTemplate(t.db, other, renamed, OWNER)).version).toBe(2);
    const own = (await listTemplates(t.db, other)).filter((x) => !x.system);
    expect(own.map((x) => [x.id, x.version])).toEqual([['own:my_tags', 2]]);
    // System templates are read-only: an import under a system slug is refused.
    const sys = await importTemplate(t.db, other, file, OWNER);
    expect(sys.message).toMatch(/системный шаблон/);
    // Strict: a file with a key inside is refused.
    const bad = await importTemplate(
      t.db,
      other,
      { ...renamed, template: { ...renamed.template, apiKey: 'sk-test' } },
      OWNER,
    );
    expect(bad.ok).toBe(false);
    // An imported template is added like a system one.
    expect((await addFromTemplate(t.db, other, 'own:my_tags', OWNER)).ok).toBe(true);
    const audit = await t.db
      .select()
      .from(schema.auditLog)
      .where(
        sql`${schema.auditLog.brandId} = ${other} and ${schema.auditLog.action} like 'template_%'`,
      );
    expect(audit.length).toBe(2);
  });
});

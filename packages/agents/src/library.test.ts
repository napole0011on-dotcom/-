import { describe, expect, it } from 'vitest';
import { capabilityById, isToolCapability } from './capabilities.js';
import { CATEGORIES, TemplateBody, exportTemplate, loadLibraryFiles } from './library.js';

describe('agent library (config/library)', () => {
  const files = loadLibraryFiles();

  it('starting templates are valid, unique, in Russian, and cover every category', () => {
    expect(files.length).toBeGreaterThanOrEqual(19);
    const slugs = files.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(files.map((t) => t.category))).toEqual(new Set(CATEGORIES));
    for (const { version, ...t } of files) {
      expect(version).toBeGreaterThanOrEqual(1);
      expect(TemplateBody.safeParse(t).success, t.slug).toBe(true);
      if (isToolCapability(t.capability)) expect(t.prompt, t.slug).toBeNull();
      else expect(t.prompt!.length > 20 && /[А-Яа-я]/.test(t.prompt!), t.slug).toBe(true);
    }
  });

  it('the basic team: a planner, a writer and a reviewer, in that order', () => {
    const team = files
      .filter((t) => t.basicTeam !== null)
      .sort((a, b) => a.basicTeam! - b.basicTeam!);
    expect(team.map((t) => [t.teamRole, t.capability])).toEqual([
      ['planner', null],
      ['worker', 'copywriting'],
      ['reviewer', null],
    ]);
  });

  it('capabilities of the templates exist; the ones that need a paid service say so', () => {
    for (const t of files.filter((x) => x.capability))
      expect(capabilityById(t.capability), t.slug).toBeDefined();
    expect(capabilityById('mailer_send')!.realNeeds).toMatch(/нужен ваш «ок»/);
    expect(capabilityById('image_generate')!.realNeeds).toMatch(/Magnific/);
  });

  it('export has only template fields: nothing that looks like a key, token or install id', () => {
    const { version, ...t } = files[0]!;
    const out = exportTemplate({
      ...t,
      id: t.slug,
      version,
      source: 'file',
      system: true,
      createdAt: null,
    });
    const keys = JSON.stringify(out)
      .match(/"[a-zA-Z]+":/g)!
      .map((k) => k.slice(1, -2));
    for (const k of keys) expect(k).not.toMatch(/^api_?key$|token|secret|password|brand|^id$/i);
    expect(TemplateBody.safeParse({ ...out.template, apiKey: 'x' }).success).toBe(false);
  });
});

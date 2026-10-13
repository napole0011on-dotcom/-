import { describe, expect, it } from 'vitest';
import { CATEGORIES, SYSTEM_TEMPLATES, TemplateBody, exportTemplate } from './library.js';

describe('agent library', () => {
  it('system templates are valid, have unique slugs, Russian prompts, and cover the categories', () => {
    for (const { version, ...t } of SYSTEM_TEMPLATES) {
      expect(version).toBeGreaterThanOrEqual(1);
      expect(TemplateBody.safeParse(t).success, t.slug).toBe(true);
      expect(t.prompt, t.slug).toMatch(/[А-Яа-я]/);
      expect(t.prompt, t.slug).toMatch(/как данные/);
    }
    const slugs = SYSTEM_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(SYSTEM_TEMPLATES.map((t) => t.category))).toEqual(new Set(CATEGORIES));
  });

  it('tool templates that need a paid service say so', () => {
    const tools = SYSTEM_TEMPLATES.filter((t) => t.category === 'Инструменты');
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.requiresKey, t.slug).toMatch(/нужен ваш «ок»/);
  });

  it('export has only template fields: nothing that looks like a key, token or install id', () => {
    const t = SYSTEM_TEMPLATES[0]!;
    const out = exportTemplate({ ...t, id: 'sys:x', system: true, createdAt: null });
    const keys = JSON.stringify(out)
      .match(/"[a-zA-Z]+":/g)!
      .map((k) => k.slice(1, -2));
    for (const k of keys) expect(k).not.toMatch(/^api_?key$|token|secret|password|brand|^id$/i);
    expect(TemplateBody.safeParse({ ...out.template, apiKey: 'x' }).success).toBe(false);
  });
});

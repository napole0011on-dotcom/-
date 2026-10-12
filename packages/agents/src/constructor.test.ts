import { describe, expect, it } from 'vitest';
import { slugify } from './agent-registry.js';
import { ConstructorSpec, outputSchema, renderBySpec, specHash } from './constructor.js';

const spec = ConstructorSpec.parse({
  fields: [
    { key: 'title', label: 'Заголовок', type: 'text' },
    { key: 'tags', label: 'Теги', type: 'list', minItems: 2 },
    {
      key: 'ideas',
      label: 'Идеи',
      type: 'items',
      fields: [
        { key: 'name', label: 'Идея', type: 'text' },
        { key: 'score', label: 'Оценка', type: 'number' },
      ],
    },
    { key: 'ok', label: 'Готово', type: 'boolean', required: false },
  ],
});

describe('constructor spec', () => {
  it('builds a schema that enforces types, minItems and nullable optional fields', () => {
    const s = outputSchema('x', spec.fields);
    const good = {
      title: 'Т',
      tags: ['a', 'b'],
      ideas: [{ name: 'n', score: 3 }],
      ok: null,
    };
    expect(s.safeParse(good).success).toBe(true);
    expect(s.safeParse({ ...good, tags: ['a'] }).success).toBe(false);
    expect(s.safeParse({ ...good, ideas: [{ name: 'n', score: '3' }] }).success).toBe(false);
  });

  it('renders lines for the owner', () => {
    const r = renderBySpec('Агент', spec.fields, {
      title: 'Осень',
      tags: ['кофе', 'меню'],
      ideas: [{ name: 'Тыквенный латте', score: 5 }],
      ok: true,
    });
    expect(r.lines).toEqual([
      'Заголовок: Осень',
      'Теги: кофе, меню',
      'Идеи:',
      '• Тыквенный латте — 5',
      'Готово: да',
    ]);
  });

  it('rejects duplicate keys and items without sub-fields; hash follows fields', () => {
    expect(
      ConstructorSpec.safeParse({
        fields: [
          { key: 'a', label: 'A', type: 'text' },
          { key: 'a', label: 'B', type: 'text' },
        ],
      }).success,
    ).toBe(false);
    expect(
      ConstructorSpec.safeParse({ fields: [{ key: 'a', label: 'A', type: 'items' }] }).success,
    ).toBe(false);
    expect(specHash(spec)).not.toBe(specHash({ ...spec, criteria: ['x x x'] }));
  });

  it('slugifies Russian names', () => {
    expect(slugify('SEO-менеджер')).toBe('seo_menedzher');
    expect(slugify('Хэштеги')).toBe('heshtegi');
    expect(slugify('123')).toBe('agent_123');
  });
});

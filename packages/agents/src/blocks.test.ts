import { describe, expect, it } from 'vitest';
import {
  compileComposition,
  defaultComposition,
  validateBlockLink,
  type Composition,
} from './blocks.js';

const opts = {
  allowedModels: ['claude-sonnet-5-5'],
  nodes: ['seo', 'me', 'rev'],
  capabilities: ['kp_render', 'image_generate'],
  reviewer: 'rev',
};

function full(): Composition {
  const c = defaultComposition('Ты — SEO-редактор: подбираешь ключевые слова к постам кофейни.');
  c.blocks.find((b) => b.id === 'output')!.config = {
    fields: [{ key: 'keywords', label: 'Ключи', type: 'list', required: true, hint: '' }],
  };
  c.blocks.push(
    {
      id: 'kn',
      type: 'knowledge',
      x: 0,
      y: 200,
      config: { title: 'Словарь', text: 'раф, флэт уайт' },
    },
    { id: 'chk', type: 'check', x: 700, y: 200, config: { criteria: ['не больше 10 ключей'] } },
    { id: 'pass', type: 'handoff', x: 900, y: 200, config: { agent: 'seo' } },
  );
  c.links.push(
    { from: 'input', to: 'kn' },
    { from: 'kn', to: 'role' },
    { from: 'output', to: 'chk' },
    { from: 'chk', to: 'pass' },
  );
  return c;
}

describe('agents from blocks', () => {
  it('ports: only allowed block types connect, no cycles, nothing into «Вход»', () => {
    const c = defaultComposition();
    expect(validateBlockLink(c, 'role', 'output')).toMatch(/«Результат» принимает только: Модель/);
    expect(validateBlockLink(c, 'output', 'input')).toMatch(/начало агента/);
    expect(validateBlockLink(c, 'input', 'role')).toBe('Такая связь уже есть');
    expect(validateBlockLink(c, 'model', 'model')).toMatch(/сам с собой/);
    c.blocks.push({ id: 'k', type: 'knowledge', x: 0, y: 0, config: {} });
    expect(validateBlockLink(c, 'input', 'k')).toBeNull();
  });

  it('compiles: role + knowledge -> prompt, result -> fields, check -> criteria, links', () => {
    const r = compileComposition(full(), opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agent.prompt).toMatch(/^Ты — SEO-редактор/);
    expect(r.agent.prompt).toMatch(/## Словарь\nраф, флэт уайт/);
    expect(r.agent.fields.map((f) => f.key)).toEqual(['keywords']);
    expect(r.agent.criteria).toEqual(['не больше 10 ключей']);
    expect(r.agent.links).toEqual(['rev', 'seo', 'me']);
    expect(r.agent.capability).toBeNull();
    expect(r.agent.modelRole).toBe('worker');
  });

  it('explains what is missing in Russian', () => {
    const c = defaultComposition('коротко');
    c.blocks.find((b) => b.id === 'model')!.config = { modelRole: 'worker', model: 'gpt-x' };
    c.links = c.links.filter((l) => l.to !== 'output');
    const r = compileComposition(c, opts);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Нет пути от «Вход» до «Результат»/),
        expect.stringMatching(/«Роль»: опишите/),
        expect.stringMatching(/gpt-x нет в прайс-листе/),
        expect.stringMatching(/«Результат»: добавьте хотя бы одно поле/),
      ]),
    );
  });
});

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatMoney, loadCatalog, priceScope } from './catalog.js';

const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const catalog = loadCatalog(path.join(repo, 'config', 'pricing', 'services.yaml'));

describe('KP pricing: numbers only from the catalog, totals by code', () => {
  it('falls back to the example catalog and marks it', () => {
    expect(catalog.example).toBe(true);
    expect(catalog.items.length).toBeGreaterThan(3);
  });

  it('total = sum of lines; VAT on top; kopecks without float drift', () => {
    const r = priceScope(
      catalog,
      [
        { item_id: 'content-plan', qty: 1, comment: '' },
        { item_id: 'copy-post', qty: 8, comment: '' },
        { item_id: 'reels-script', qty: 0.1, comment: '' },
      ],
      20,
    );
    expect(r.lines.map((l) => l.totalMinor)).toEqual([1_500_000, 1_200_000, 30_000]);
    expect(r.totals.subtotalMinor).toBe(r.lines.reduce((a, l) => a + l.totalMinor!, 0));
    expect(r.totals.vatMinor).toBe(546_000);
    expect(r.totals.totalMinor).toBe(2_730_000 + 546_000);
    expect(formatMoney(r.totals.totalMinor, 'RUB')).toBe('32 760 ₽');
  });

  it('a position outside the catalog is not priced and is flagged; "по запросу" too', () => {
    const r = priceScope(
      catalog,
      [
        { item_id: 'made-up-service', qty: 1, comment: 'SEO сайта' },
        { item_id: 'ads-setup', qty: 1, comment: '' },
      ],
      0,
    );
    expect(r.lines[0]).toMatchObject({ inCatalog: false, priceMinor: null, totalMinor: null });
    expect(r.lines[1]).toMatchObject({ inCatalog: true, priceMinor: null });
    expect(r.totals).toMatchObject({ subtotalMinor: 0, totalMinor: 0, hasOnRequest: true });
    expect(r.warnings.join('\n')).toMatch(/made-up-service.*нет в справочнике/);
    expect(r.warnings.join('\n')).toMatch(/цена по запросу/);
  });
});

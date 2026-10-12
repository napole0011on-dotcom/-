import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const CatalogItem = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().min(2),
  unit: z.string().min(1),
  /** null = «цена по запросу». */
  price: z.number().nonnegative().nullable(),
});
export type CatalogItem = z.infer<typeof CatalogItem>;

export const Catalog = z
  .object({
    currency: z.string().min(1).default('RUB'),
    example: z.boolean().default(false),
    items: z.array(CatalogItem).min(1),
    requisites: z
      .object({
        company: z.string(),
        details: z.string().default(''),
        contact: z.string().default(''),
      })
      .optional(),
    cases: z.array(z.object({ id: z.string(), title: z.string(), text: z.string() })).default([]),
  })
  .superRefine((c, ctx) => {
    const ids = c.items.map((i) => i.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'id позиций должны быть разными' });
  });
export type Catalog = z.infer<typeof Catalog> & { hash: string; file: string };

/**
 * The price catalog (KP_CATALOG_FILE). Without the owner's file the example next to it is used
 * and marked: every KP made from it says «пример справочника».
 */
export function loadCatalog(file: string): Catalog {
  const example = path.join(path.dirname(file), 'services.example.yaml');
  const used = existsSync(file) ? file : example;
  const raw = readFileSync(used, 'utf8');
  const c = Catalog.parse(parse(raw));
  return {
    ...c,
    example: c.example || used !== file,
    hash: createHash('sha256').update(raw).digest('hex').slice(0, 12),
    file: used,
  };
}

export interface KpScopeInput {
  item_id: string;
  qty: number;
  comment: string;
}

export interface KpLine {
  itemId: string;
  name: string;
  unit: string;
  qty: number;
  /** Kopecks (integer); null = «цена по запросу» or not in the catalog. */
  priceMinor: number | null;
  totalMinor: number | null;
  inCatalog: boolean;
  comment: string;
}

export interface KpTotals {
  currency: string;
  subtotalMinor: number;
  vatPercent: number;
  vatMinor: number;
  totalMinor: number;
  /** Some positions have no price: the total is «от» and needs the owner. */
  hasOnRequest: boolean;
}

/**
 * Prices and sums are computed here, never by the model: positions not in the catalog are kept
 * as «цена по запросу» with a warning for the owner. Money in integer kopecks (no float drift).
 */
export function priceScope(
  catalog: Catalog,
  scope: KpScopeInput[],
  vatPercent: number,
): { lines: KpLine[]; totals: KpTotals; warnings: string[] } {
  const warnings: string[] = [];
  const lines: KpLine[] = scope.map((s) => {
    const item = catalog.items.find((i) => i.id === s.item_id);
    const qty = Number.isFinite(s.qty) && s.qty > 0 ? Math.round(s.qty * 100) / 100 : 1;
    if (!item) {
      warnings.push(`Позиции «${s.item_id}» нет в справочнике — цена по запросу, проверьте`);
      return {
        itemId: s.item_id,
        name: s.comment || s.item_id,
        unit: '—',
        qty,
        priceMinor: null,
        totalMinor: null,
        inCatalog: false,
        comment: s.comment,
      };
    }
    const priceMinor = item.price === null ? null : Math.round(item.price * 100);
    if (priceMinor === null) warnings.push(`«${item.name}»: цена по запросу`);
    return {
      itemId: item.id,
      name: item.name,
      unit: item.unit,
      qty,
      priceMinor,
      totalMinor: priceMinor === null ? null : Math.round(priceMinor * qty),
      inCatalog: true,
      comment: s.comment,
    };
  });
  const subtotalMinor = lines.reduce((a, l) => a + (l.totalMinor ?? 0), 0);
  const vatMinor = Math.round((subtotalMinor * vatPercent) / 100);
  if (catalog.example)
    warnings.push('КП собрано по ПРИМЕРУ справочника: заполните config/pricing/services.yaml');
  return {
    lines,
    totals: {
      currency: catalog.currency,
      subtotalMinor,
      vatPercent,
      vatMinor,
      totalMinor: subtotalMinor + vatMinor,
      hasOnRequest: lines.some((l) => l.totalMinor === null),
    },
    warnings,
  };
}

/** 1234567 kopecks -> "12 345,67 ₽". */
export function formatMoney(minor: number, currency: string): string {
  const sign = currency === 'RUB' ? '₽' : currency;
  const rub = Math.floor(Math.abs(minor) / 100);
  const kop = Math.abs(minor) % 100;
  const int = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${minor < 0 ? '−' : ''}${int}${kop ? `,${String(kop).padStart(2, '0')}` : ''}\u00a0${sign}`;
}

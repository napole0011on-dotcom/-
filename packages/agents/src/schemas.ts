import { z } from 'zod';

export const PLATFORMS = [
  'instagram_post',
  'instagram_carousel',
  'instagram_reels',
  'telegram_post',
] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram_post: 'пост Instagram',
  instagram_carousel: 'карусель Instagram',
  instagram_reels: 'Reels',
  telegram_post: 'пост Telegram',
};

/** Platform limits. Sources: Telegram Bot API typings; Instagram caption limits per public guides (2026). */
export const LIMITS = {
  hookChars: 125,
  instagramCaptionChars: 2200,
  telegramPostChars: 4096,
  carouselSlides: { min: 2, max: 10 },
  slideChars: 200,
} as const;

export const Deliverable = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/, 'lowercase latin slug, up to 32 chars'),
  platform: z.enum(PLATFORMS),
  topic: z.string().min(3),
  goal: z.string().min(3),
  notes: z.string(),
});
export type Deliverable = z.infer<typeof Deliverable>;

export const CeoPlan = z
  .object({
    summary: z.string().min(10),
    assumptions: z.array(z.string()),
    questions: z.array(z.string()),
    deliverables: z.array(Deliverable).min(1).max(7),
  })
  .superRefine((p, ctx) => {
    const ids = p.deliverables.map((d) => d.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['deliverables'],
        message: 'deliverable ids must be unique',
      });
    }
  })
  .meta({ title: 'CeoPlan' });
export type CeoPlan = z.infer<typeof CeoPlan>;

export const Variant = z.object({
  angle: z.string().min(3),
  hook: z.string().min(5),
  body: z.string().min(20),
  cta: z.string().min(3),
});
export type Variant = z.infer<typeof Variant>;

export const ReelsSegment = z.object({
  fromSec: z.number().int().min(0),
  toSec: z.number().int().min(1),
  visual: z.string().min(3),
  voiceover: z.string(),
  onScreenText: z.string(),
});

export const CopyItem = z.object({
  deliverableId: z.string(),
  variants: z.array(Variant).length(3),
  slides: z.array(z.string()).nullable(),
  reelsScript: z.array(ReelsSegment).nullable(),
});
export type CopyItem = z.infer<typeof CopyItem>;

export const fullCaption = (v: Variant) => `${v.hook}\n\n${v.body}\n\n${v.cta}`;

/** Format/length rules per platform. Returned as messages so they can be fed back to the model. */
export function formatProblems(item: CopyItem, platform: Platform): string[] {
  const out: string[] = [];
  item.variants.forEach((v, i) => {
    const n = i + 1;
    if (v.hook.length > LIMITS.hookChars)
      out.push(`variant ${n}: hook is ${v.hook.length} chars, max ${LIMITS.hookChars}`);
    const len = fullCaption(v).length;
    const max =
      platform === 'telegram_post' ? LIMITS.telegramPostChars : LIMITS.instagramCaptionChars;
    if (len > max) out.push(`variant ${n}: text is ${len} chars, max ${max} for ${platform}`);
  });
  if (platform === 'instagram_carousel') {
    const s = item.slides;
    if (!s || s.length < LIMITS.carouselSlides.min || s.length > LIMITS.carouselSlides.max) {
      out.push(
        `slides: carousel needs ${LIMITS.carouselSlides.min}-${LIMITS.carouselSlides.max} slides`,
      );
    } else {
      s.forEach(
        (t, i) =>
          t.length > LIMITS.slideChars &&
          out.push(`slide ${i + 1}: ${t.length} chars, max ${LIMITS.slideChars}`),
      );
    }
  } else if (item.slides !== null) {
    out.push('slides: must be null for this platform');
  }
  if (platform === 'instagram_reels') {
    const seg = item.reelsScript;
    if (!seg || seg.length === 0) out.push('reelsScript: required for Reels');
    else {
      let t = 0;
      seg.forEach((g, i) => {
        if (g.fromSec !== t)
          out.push(`reelsScript[${i}]: starts at ${g.fromSec}s, expected ${t}s (no gaps)`);
        if (g.toSec <= g.fromSec) out.push(`reelsScript[${i}]: toSec must be greater than fromSec`);
        t = g.toSec;
      });
    }
  } else if (item.reelsScript !== null) {
    out.push('reelsScript: must be null for this platform');
  }
  return out;
}

/** Copywriter output schema for a concrete set of deliverables: every one exactly once, valid format. */
export function copywriterOutputSchema(deliverables: Pick<Deliverable, 'id' | 'platform'>[]) {
  const ids = deliverables.map((d) => d.id) as [string, ...string[]];
  const byId = new Map(deliverables.map((d) => [d.id, d.platform]));
  return z
    .object({ items: z.array(CopyItem.extend({ deliverableId: z.enum(ids) })) })
    .superRefine((o, ctx) => {
      const got = o.items.map((i) => i.deliverableId);
      for (const id of ids) {
        const n = got.filter((g) => g === id).length;
        if (n !== 1)
          ctx.addIssue({
            code: 'custom',
            path: ['items'],
            message: `deliverable ${id} must appear exactly once (found ${n})`,
          });
      }
      o.items.forEach((item, idx) => {
        for (const p of formatProblems(item, byId.get(item.deliverableId)!)) {
          ctx.addIssue({
            code: 'custom',
            path: ['items', idx],
            message: `${item.deliverableId}: ${p}`,
          });
        }
      });
    })
    .meta({ title: 'CopywriterOutput' });
}
export type CopywriterOutput = { items: CopyItem[] };

const Check = z.object({ ok: z.boolean(), comment: z.string() });
export const CHECK_NAMES = [
  'briefFit',
  'brandVoice',
  'clichesAndBureaucratese',
  'facts',
  'lengthAndFormat',
] as const;
export const CHECK_LABEL: Record<(typeof CHECK_NAMES)[number], string> = {
  briefFit: 'соответствие брифу',
  brandVoice: 'голос бренда',
  clichesAndBureaucratese: 'штампы и канцелярит',
  facts: 'фактура',
  lengthAndFormat: 'длина и формат',
};

export const Issue = z.object({
  variant: z.number().int().min(1).max(3).nullable(),
  problem: z.string().min(3),
  fix: z.string().min(3),
});
export type Issue = z.infer<typeof Issue>;

export const Review = z.object({
  deliverableId: z.string(),
  verdict: z.enum(['pass', 'fail']),
  checks: z.object({
    briefFit: Check,
    brandVoice: Check,
    clichesAndBureaucratese: Check,
    facts: Check,
    lengthAndFormat: Check,
  }),
  issues: z.array(Issue).max(7),
  summary: z.string(),
});
export type Review = z.infer<typeof Review>;

export function criticOutputSchema(ids: string[]) {
  const e = ids as [string, ...string[]];
  return z
    .object({ reviews: z.array(Review.extend({ deliverableId: z.enum(e) })) })
    .superRefine((o, ctx) => {
      for (const id of ids) {
        if (o.reviews.filter((r) => r.deliverableId === id).length !== 1) {
          ctx.addIssue({
            code: 'custom',
            path: ['reviews'],
            message: `review for ${id} must appear exactly once`,
          });
        }
      }
    })
    .meta({ title: 'CriticOutput' });
}

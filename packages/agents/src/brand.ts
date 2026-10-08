import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { schema, sql, type DbOrTx } from '@cms/db';

/** Brand profile: everything agents know about the brand. Stored in DB, seeded from YAML. */
export const BrandProfile = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  language: z.string().default('ru'),
  description: z.string().default(''),
  audience: z.array(z.string()).default([]),
  tone: z.array(z.string()).default([]),
  vocabulary: z
    .object({ use: z.array(z.string()).default([]), avoid: z.array(z.string()).default([]) })
    .default({ use: [], avoid: [] }),
  bannedWords: z.array(z.string()).default([]),
  examples: z.array(z.object({ text: z.string(), why: z.string().default('') })).default([]),
  visualStyle: z
    .object({
      colors: z.array(z.string()).default([]),
      references: z.array(z.string()).default([]),
      notes: z.string().default(''),
    })
    .default({ colors: [], references: [], notes: '' }),
  formattingRules: z.array(z.string()).default([]),
});
export type BrandProfile = z.infer<typeof BrandProfile>;

export interface BrandRecord {
  id: string;
  slug: string;
  name: string;
  profile: BrandProfile;
  profileVersion: number;
}

export function loadBrandProfileFile(file: string): BrandProfile {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read brand profile ${file}: ${(err as Error).message}`, { cause: err });
  }
  const parsed = BrandProfile.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid brand profile ${file}: ${issues}`);
  }
  return parsed.data;
}

const hashOf = (p: BrandProfile) => createHash('sha256').update(JSON.stringify(p)).digest('hex');

/**
 * Inserts the brand or updates its profile. The profile version is bumped only when
 * the content actually changed, so every artifact can point at the exact profile used.
 */
export async function upsertBrand(
  db: DbOrTx,
  profile: BrandProfile,
): Promise<{ brand: BrandRecord; changed: boolean }> {
  const { brands } = schema;
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(brands)
      .where(sql`${brands.slug} = ${profile.slug}`)
      .for('update');
    if (!existing) {
      const [b] = await tx
        .insert(brands)
        .values({ slug: profile.slug, name: profile.name, profile })
        .returning();
      return { brand: toRecord(b!), changed: true };
    }
    const current = BrandProfile.safeParse(existing.profile);
    if (current.success && hashOf(current.data) === hashOf(profile)) {
      return { brand: toRecord(existing), changed: false };
    }
    const [b] = await tx
      .update(brands)
      .set({
        name: profile.name,
        profile,
        profileVersion: sql`${brands.profileVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(sql`${brands.id} = ${existing.id}`)
      .returning();
    return { brand: toRecord(b!), changed: true };
  });
}

export async function getBrand(db: DbOrTx, id: string): Promise<BrandRecord> {
  const { brands } = schema;
  const [b] = await db
    .select()
    .from(brands)
    .where(sql`${brands.id} = ${id}`);
  if (!b) throw new Error(`Brand ${id} not found`);
  return toRecord(b);
}

function toRecord(b: typeof schema.brands.$inferSelect): BrandRecord {
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    profile: BrandProfile.parse(b.profile),
    profileVersion: b.profileVersion,
  };
}

/** Rendered once per brand version and put in a cached system block. */
export function renderBrandForPrompt(brand: BrandRecord): string {
  return [
    `Профиль бренда (версия ${brand.profileVersion}):`,
    JSON.stringify(brand.profile, null, 2),
  ].join('\n');
}

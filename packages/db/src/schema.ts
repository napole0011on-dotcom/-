import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Stage 0 contains only the tenant root. Brand profile fields, tasks, runs, artifacts,
 * approvals, audit log and cost records arrive in stage 1.
 */
export const brands = pgTable('brands', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

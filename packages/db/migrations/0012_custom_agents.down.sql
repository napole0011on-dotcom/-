-- Links of the old main pipeline become "system" again; planned placeholders come back
-- (their links, deleted by the up migration, do not). Agents created after the up migration
-- have no legacyKind and become constructor agents.
UPDATE "agent_links" SET "kind" = 'system'
WHERE ("from_node", "to_node") IN (('brief', 'ceo'), ('ceo', 'copywriter'), ('copywriter', 'critic'), ('critic', 'me'));--> statement-breakpoint
UPDATE "agent_definitions" SET "deleted_at" = NULL WHERE "status" = 'planned';--> statement-breakpoint
UPDATE "agent_definitions"
SET "kind" = COALESCE("spec" ->> 'legacyKind', 'constructor'),
    "spec" = "spec" - 'legacyKind'
WHERE "kind" = 'custom';--> statement-breakpoint
-- Agents deleted after the up migration were soft-deleted; the old schema had no such state.
DELETE FROM "agent_definitions" WHERE "deleted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_templates" DROP COLUMN "deleted_at";--> statement-breakpoint
ALTER TABLE "agent_templates" DROP COLUMN "source";--> statement-breakpoint
ALTER TABLE "agent_definitions" DROP COLUMN "deleted_at";--> statement-breakpoint
ALTER TABLE "agent_definitions" DROP COLUMN "capability";--> statement-breakpoint
ALTER TABLE "agent_definitions" DROP COLUMN "team_role";--> statement-breakpoint
DROP TABLE "worker_heartbeats";

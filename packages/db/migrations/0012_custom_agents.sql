CREATE TABLE "worker_heartbeats" (
	"worker" text PRIMARY KEY NOT NULL,
	"pid" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"beat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_definitions" ADD COLUMN "team_role" text;--> statement-breakpoint
ALTER TABLE "agent_definitions" ADD COLUMN "capability" text;--> statement-breakpoint
ALTER TABLE "agent_definitions" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_templates" ADD COLUMN "source" text DEFAULT 'panel' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_templates" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
-- Stage 7: no built-in agents. Every agent becomes an ordinary owner's record ("custom") with a
-- team role and, for agents that run code, a capability. The previous kind is kept in
-- spec.legacyKind so the down migration can restore it.
UPDATE "agent_definitions"
SET "spec" = "spec" || jsonb_build_object('legacyKind', "kind"),
    "team_role" = CASE "id"
      WHEN 'ceo' THEN 'planner'
      WHEN 'critic' THEN 'reviewer'
      WHEN 'seo' THEN 'acceptor'
      ELSE 'worker' END,
    "capability" = CASE
      WHEN "id" = 'copywriter' THEN 'copywriting'
      WHEN "id" = 'image' THEN 'image_generate'
      WHEN "id" = 'kp' THEN 'kp_draft'
      WHEN "kind" = 'tool' THEN "id"
      ELSE NULL END,
    "kind" = 'custom'
WHERE "kind" IN ('code', 'constructor', 'tool');--> statement-breakpoint
-- "Planned" placeholders were never agents (no prompt, no runs): hidden like deleted ones.
-- Their links go (a link to a placeholder never worked).
DELETE FROM "agent_links" l USING "agent_definitions" d
WHERE d."brand_id" = l."brand_id" AND d."status" = 'planned'
  AND (l."from_node" = d."id" OR l."to_node" = d."id");--> statement-breakpoint
UPDATE "agent_definitions" SET "deleted_at" = now() WHERE "status" = 'planned';--> statement-breakpoint
-- All links are equal now: every one can be deleted by the owner.
UPDATE "agent_links" SET "kind" = 'user' WHERE "kind" = 'system';

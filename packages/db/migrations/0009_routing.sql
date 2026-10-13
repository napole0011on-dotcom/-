CREATE TABLE "route_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"from_agent" text NOT NULL,
	"from_sig" text NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mode" text NOT NULL,
	"reasons" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" numeric(4, 3),
	"need_help" boolean DEFAULT false NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_events" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "route_decisions" ADD CONSTRAINT "route_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "route_decisions_uq" ON "route_decisions" USING btree ("task_id","from_agent","from_sig");--> statement-breakpoint
CREATE INDEX "agent_events_task_idx" ON "agent_events" USING btree ("task_id","id");--> statement-breakpoint
-- One stream of what happened in a task, in the terms of the board (start/handoff/done/error/wait).
CREATE VIEW "run_events" AS
SELECT "id", "brand_id", "task_id", "run_id", "at" AS "ts", "agent",
  CASE "kind"
    WHEN 'started' THEN 'start'
    WHEN 'finished' THEN 'done'
    WHEN 'failed' THEN 'error'
    WHEN 'retry' THEN 'wait'
    WHEN 'wait' THEN 'wait'
    WHEN 'handoff' THEN 'handoff'
    ELSE "kind"
  END AS "type",
  "text", "cost_usd" AS "cost", "payload"
FROM "agent_events";

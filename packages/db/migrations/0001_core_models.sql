CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'changes_requested', 'rejected', 'regenerate', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."approval_gate" AS ENUM('plan', 'final', 'budget');--> statement-breakpoint
CREATE TYPE "public"."cost_status" AS ENUM('reserved', 'final', 'released');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'dead');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('draft', 'planned', 'awaiting_plan_approval', 'in_progress', 'in_review', 'revision', 'awaiting_final_approval', 'approved', 'rejected', 'exported', 'published', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"gate" "approval_gate" NOT NULL,
	"artifact_id" uuid,
	"artifact_version" integer,
	"decision" "approval_decision" NOT NULL,
	"comment" text,
	"decided_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid,
	"slot" text NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"storage_key" text,
	"agent" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_version_positive" CHECK ("artifacts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"task_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"period_key" text NOT NULL,
	"extra_usd" numeric(14, 8) NOT NULL,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"task_id" uuid,
	"run_id" uuid,
	"agent" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" "cost_status" DEFAULT 'reserved' NOT NULL,
	"reserved_usd" numeric(14, 8) NOT NULL,
	"cost_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "cost_records_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"task_id" uuid,
	"run_id" uuid,
	"agent" text NOT NULL,
	"prompt_version" text NOT NULL,
	"requested_model" text NOT NULL,
	"served_model" text,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"stop_reason" text,
	"request" jsonb,
	"response" jsonb,
	"error" jsonb,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"prompt_version" text,
	"started_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"brief" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "task_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"budget_usd" numeric(14, 8) NOT NULL,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "profile_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_overrides" ADD CONSTRAINT "budget_overrides_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_task_idx" ON "approvals" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_task_slot_version_uq" ON "artifacts" USING btree ("task_id","slot","version");--> statement-breakpoint
CREATE INDEX "audit_log_task_idx" ON "audit_log" USING btree ("task_id","id");--> statement-breakpoint
CREATE INDEX "budget_overrides_lookup_idx" ON "budget_overrides" USING btree ("brand_id","scope","period_key");--> statement-breakpoint
CREATE INDEX "cost_records_brand_created_idx" ON "cost_records" USING btree ("brand_id","created_at");--> statement-breakpoint
CREATE INDEX "cost_records_task_idx" ON "cost_records" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "llm_calls_run_idx" ON "llm_calls" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "llm_calls_task_idx" ON "llm_calls" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "runs_task_idx" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "runs_status_heartbeat_idx" ON "runs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "tasks_brand_status_idx" ON "tasks" USING btree ("brand_id","status");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_id");--> statement-breakpoint
-- Hand-written guards (not generated by drizzle-kit).
-- 1) tasks.status may only change inside engine/transitions.ts, which sets app.task_transition.
CREATE FUNCTION guard_task_status_change() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND coalesce(current_setting('app.task_transition', true), '') <> 'on' THEN
    RAISE EXCEPTION 'tasks.status must be changed via transitionTask() (% -> %)', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER tasks_status_guard BEFORE UPDATE OF status ON tasks
  FOR EACH ROW EXECUTE FUNCTION guard_task_status_change();
--> statement-breakpoint
-- 2) audit_log is append-only.
CREATE FUNCTION forbid_audit_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_log_mutation();

CREATE TABLE "agent_definitions" (
	"brand_id" uuid NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"color" text NOT NULL,
	"icon" text NOT NULL,
	"model_role" text,
	"spec" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_definitions_brand_id_id_pk" PRIMARY KEY("brand_id","id")
);
--> statement-breakpoint
CREATE TABLE "agent_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"brand_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent" text NOT NULL,
	"task_id" uuid,
	"run_id" uuid,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"cost_usd" numeric(14, 8)
);
--> statement-breakpoint
CREATE TABLE "agent_layout" (
	"brand_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"x" integer NOT NULL,
	"y" integer NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_layout_brand_id_node_id_pk" PRIMARY KEY("brand_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "agent_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"from_node" text NOT NULL,
	"to_node" text NOT NULL,
	"kind" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_definitions" ADD CONSTRAINT "agent_definitions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_layout" ADD CONSTRAINT "agent_layout_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_links" ADD CONSTRAINT "agent_links_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_events_brand_id_idx" ON "agent_events" USING btree ("brand_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_links_pair_uq" ON "agent_links" USING btree ("brand_id","from_node","to_node");--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_events_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('agent_events', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER agent_events_notify AFTER INSERT ON "agent_events"
  FOR EACH ROW EXECUTE FUNCTION agent_events_notify();

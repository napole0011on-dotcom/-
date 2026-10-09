CREATE TYPE "public"."prompt_source" AS ENUM('file', 'panel');--> statement-breakpoint
CREATE TABLE "agent_settings" (
	"brand_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"model_override" text,
	"active_prompt_id" uuid,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_settings_brand_id_agent_pk" PRIMARY KEY("brand_id","agent")
);
--> statement-breakpoint
CREATE TABLE "global_controls" (
	"brand_id" uuid PRIMARY KEY NOT NULL,
	"all_paused" boolean DEFAULT false NOT NULL,
	"changed_by" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"version" integer NOT NULL,
	"text" text NOT NULL,
	"hash" text NOT NULL,
	"source" "prompt_source" NOT NULL,
	"file_version" integer,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "waiting_for" text;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_active_prompt_id_prompt_versions_id_fk" FOREIGN KEY ("active_prompt_id") REFERENCES "public"."prompt_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_controls" ADD CONSTRAINT "global_controls_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_agent_version_uq" ON "prompt_versions" USING btree ("brand_id","agent","version");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_agent_hash_uq" ON "prompt_versions" USING btree ("brand_id","agent","hash");
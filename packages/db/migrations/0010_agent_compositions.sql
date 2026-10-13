CREATE TABLE "agent_compositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"blocks" jsonb NOT NULL,
	"links" jsonb NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"built_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_compositions" ADD CONSTRAINT "agent_compositions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_compositions_uq" ON "agent_compositions" USING btree ("brand_id","agent_id","version");
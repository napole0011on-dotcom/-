CREATE TABLE "wallet_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"balance_usd" numeric(14, 8) NOT NULL,
	"recorded_raw_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
	"wallet_spent_usd" numeric(14, 8),
	"source" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cost_records" ADD COLUMN "raw_cost_usd" numeric(14, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_snapshots" ADD CONSTRAINT "wallet_snapshots_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_snapshots_lookup_idx" ON "wallet_snapshots" USING btree ("brand_id","provider","created_at");
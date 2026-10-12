CREATE TABLE "provider_status" (
	"provider" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'ok' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" jsonb,
	"last_error_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"open_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "waiting_since" timestamp with time zone;
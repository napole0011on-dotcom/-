ALTER TABLE "runs" DROP COLUMN IF EXISTS "waiting_for";
DROP TABLE IF EXISTS "global_controls";
DROP TABLE IF EXISTS "agent_settings";
DROP TABLE IF EXISTS "prompt_versions";
DROP TYPE IF EXISTS "prompt_source";

DROP VIEW IF EXISTS "run_events";
DROP TABLE IF EXISTS "route_decisions";
DROP INDEX IF EXISTS "agent_events_task_idx";
ALTER TABLE "agent_events" DROP COLUMN IF EXISTS "payload";

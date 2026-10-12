DROP TABLE IF EXISTS "campaign_sends";
DROP TABLE IF EXISTS "campaigns";
DROP TABLE IF EXISTS "suppressions";
DROP TABLE IF EXISTS "contacts";
DROP TABLE IF EXISTS "transcripts";
DROP TABLE IF EXISTS "media_files";
ALTER TABLE "runs" DROP COLUMN IF EXISTS "progress";

BEGIN;

DROP INDEX IF EXISTS files_current_deliverable_unique;
DROP INDEX IF EXISTS files_deliverable_version_unique;
DROP INDEX IF EXISTS files_generation_request_unique;

ALTER TABLE files
  DROP COLUMN IF EXISTS superseded_at,
  DROP COLUMN IF EXISTS supersedes_file_id,
  DROP COLUMN IF EXISTS version,
  DROP COLUMN IF EXISTS generation_request_id,
  DROP COLUMN IF EXISTS deliverable_id;

COMMIT;

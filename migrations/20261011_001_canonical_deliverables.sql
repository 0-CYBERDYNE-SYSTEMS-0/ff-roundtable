-- BETA-02: add server-owned identity/version metadata to generated files.
-- Before applying, take a pg_dump backup of the target database.
-- Existing rows retain their IDs, paths, and bytes with NULL metadata; they
-- remain downloadable as legacy unversioned files.
-- Rollback: apply the matching .down.sql after taking another backup. This
-- drops only the new metadata/indexes and does not delete any file rows/bytes.

BEGIN;

ALTER TABLE files
  ADD COLUMN deliverable_id text,
  ADD COLUMN generation_request_id text,
  ADD COLUMN version integer,
  ADD COLUMN supersedes_file_id integer REFERENCES files(id),
  ADD COLUMN superseded_at timestamp;

CREATE UNIQUE INDEX files_generation_request_unique
  ON files (conversation_id, generation_request_id)
  WHERE generation_request_id IS NOT NULL;

CREATE UNIQUE INDEX files_deliverable_version_unique
  ON files (conversation_id, deliverable_id, version)
  WHERE deliverable_id IS NOT NULL AND version IS NOT NULL;

CREATE UNIQUE INDEX files_current_deliverable_unique
  ON files (conversation_id, deliverable_id)
  WHERE deliverable_id IS NOT NULL AND superseded_at IS NULL;

COMMIT;

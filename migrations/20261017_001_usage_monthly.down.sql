-- Rollback for 20261017_001_usage_monthly.sql. Take a backup first.
BEGIN;
DROP TABLE IF EXISTS usage_monthly;
COMMIT;

-- Pricing caps (Pro $20): per-user, per-UTC-month message count and
-- house-key AI spend. Additive only; no existing rows change.
-- Before applying, take a pg_dump backup of the target database.
-- Rollback: apply the matching .down.sql (drops only this table).

BEGIN;

CREATE TABLE IF NOT EXISTS usage_monthly (
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period text NOT NULL,
  message_count integer NOT NULL DEFAULT 0,
  ai_spend_usd double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, period)
);

COMMIT;

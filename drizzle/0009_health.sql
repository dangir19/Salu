-- Salu health integrations: connected accounts (OAuth tokens) + daily metrics.
-- Privacy: minimal fields only, tokens never logged, disconnect deletes data.
CREATE TABLE IF NOT EXISTS connected_health_accounts (
  id text PRIMARY KEY NOT NULL,
  member_id text NOT NULL,
  provider text NOT NULL,
  provider_user_id text,
  access_token text,
  refresh_token text,
  token_expires_at text,
  scopes text,
  connected_at text NOT NULL,
  last_sync_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS connected_health_accounts_member_provider_idx
  ON connected_health_accounts (member_id, provider);

CREATE TABLE IF NOT EXISTS health_device_tokens (
  id text PRIMARY KEY NOT NULL,
  member_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  device_name text,
  created_at text NOT NULL,
  last_used_at text
);

CREATE TABLE IF NOT EXISTS health_metrics (
  id text PRIMARY KEY NOT NULL,
  member_id text NOT NULL,
  date text NOT NULL,
  source text NOT NULL,
  workouts_json text,
  steps integer,
  sleep_hours real,
  resting_hr real,
  hrv_ms real,
  training_load real,
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS health_metrics_member_date_source_idx
  ON health_metrics (member_id, date, source);
CREATE INDEX IF NOT EXISTS health_metrics_member_date_idx
  ON health_metrics (member_id, date);

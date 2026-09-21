-- Salu Strava OAuth state persistence: single-use OAuth states live in D1 so the
-- authorize -> callback round trip survives Cloudflare Workers isolate changes
-- (in-memory state issued on one isolate is invisible to the callback on another).
-- States carry a 10-minute TTL, are deleted when consumed, and expired rows are
-- cleaned up lazily on write. Tokens are never stored here.
-- NOTE: D1 migrations are applied manually in production (same as 0007–0010);
-- db/health.ts ensureHealthSchema() also creates this table at runtime.
CREATE TABLE IF NOT EXISTS strava_oauth_states (
  state text PRIMARY KEY NOT NULL,
  member_id text NOT NULL,
  code_verifier text,
  redirect_uri text,
  created_at text NOT NULL,
  expires_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS strava_oauth_states_expires_at_idx ON strava_oauth_states (expires_at);

-- Salu "book with your own AI" MCP server: member API tokens + booking source label.
-- NOTE: D1 migrations are applied manually in production (same as 0007–0009);
-- db/tokens.ts ensureTokensSchema() also creates member_api_tokens at runtime.
CREATE TABLE IF NOT EXISTS member_api_tokens (
  id text PRIMARY KEY NOT NULL,
  member_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  name text NOT NULL,
  scopes text NOT NULL DEFAULT 'booking',
  created_at text,
  last_used_at text,
  revoked_at text
);
CREATE INDEX IF NOT EXISTS member_api_tokens_member_id_idx ON member_api_tokens (member_id);

-- Labels bookings made over MCP ("mcp") vs the web ("web"). Existing rows default to web.
ALTER TABLE bookings ADD COLUMN source text NOT NULL DEFAULT 'web';

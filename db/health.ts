import {sql} from "drizzle-orm";
import type {getDb as getDbType} from "./index";

type Db = ReturnType<typeof getDbType>;

// Lazy so plain Node test runs (which lack the cloudflare:workers module)
// can import this file: the D1 binding is only touched inside withHealthDb.
// Tests can inject an in-memory SQLite db via __injectHealthDbForTests().
let injectedTestDb: Db | null = null;

/** Test-only: replace the D1 binding with an injected db (e.g. in-memory SQLite). */
export function __injectHealthDbForTests(db: Db | null): void {
  injectedTestDb = db;
}

async function loadDb(): Promise<Db> {
  if (injectedTestDb) return injectedTestDb;
  const mod = await import("./index");
  return mod.getDb();
}

export type HealthProvider = "strava" | "apple_health" | "google_health";

export type HealthAccount = {
  id: string;
  memberId: string;
  provider: HealthProvider;
  providerUserId: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  scopes: string | null;
  connectedAt: string;
  lastSyncAt: string | null;
};

export type HealthMetric = {
  id: string;
  memberId: string;
  date: string;
  source: string;
  workoutsJson: string | null;
  steps: number | null;
  sleepHours: number | null;
  restingHr: number | null;
  hrvMs: number | null;
  trainingLoad: number | null;
};

async function withHealthDb<T>(fn: (db: Db) => Promise<T>): Promise<T | null> {
  try {
    return await fn(await loadDb());
  } catch {
    return null;
  }
}

export async function ensureHealthSchema(): Promise<boolean> {
  return Boolean(
    await withHealthDb(async (db) => {
      await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS connected_health_accounts (
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
      )`));
      await db.run(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS connected_health_accounts_member_provider_idx
        ON connected_health_accounts (member_id, provider)`));
      await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS health_device_tokens (
        id text PRIMARY KEY NOT NULL,
        member_id text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        device_name text,
        created_at text NOT NULL,
        last_used_at text
      )`));
      await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS health_metrics (
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
      )`));
      await db.run(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS health_metrics_member_date_source_idx
        ON health_metrics (member_id, date, source)`));
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS health_metrics_member_date_idx
        ON health_metrics (member_id, date)`));
      // Strava OAuth states: single-use, 10-minute TTL. Persisted in D1 so the
      // authorize -> callback round trip survives Workers isolate changes.
      await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS strava_oauth_states (
        state text PRIMARY KEY NOT NULL,
        member_id text NOT NULL,
        code_verifier text,
        redirect_uri text,
        created_at text NOT NULL,
        expires_at text NOT NULL
      )`));
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS strava_oauth_states_expires_at_idx
        ON strava_oauth_states (expires_at)`));
      return true;
    }),
  );
}

type AccountRow = {
  id: string;
  member_id: string;
  provider: string;
  provider_user_id: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  scopes: string | null;
  connected_at: string;
  last_sync_at: string | null;
};

function accountFromRow(row: AccountRow): HealthAccount {
  return {
    id: row.id,
    memberId: row.member_id,
    provider: row.provider as HealthProvider,
    providerUserId: row.provider_user_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    tokenExpiresAt: row.token_expires_at,
    scopes: row.scopes,
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
  };
}

export async function upsertHealthAccount(
  memberId: string,
  provider: HealthProvider,
  fields: Partial<Omit<HealthAccount, "id" | "memberId" | "provider">> & {id?: string},
): Promise<HealthAccount | null> {
  return withHealthDb(async (db) => {
    await ensureHealthSchema();
    const now = new Date().toISOString();
    const rows = (await db.all(
      sql.raw(`SELECT * FROM connected_health_accounts WHERE member_id = ${escape(memberId)} AND provider = ${escape(provider)} LIMIT 1`),
    )) as unknown as AccountRow[];
    if (rows[0]) {
      const current = rows[0];
      const next = {
        provider_user_id: fields.providerUserId ?? current.provider_user_id,
        access_token: fields.accessToken !== undefined ? fields.accessToken : current.access_token,
        refresh_token: fields.refreshToken !== undefined ? fields.refreshToken : current.refresh_token,
        token_expires_at: fields.tokenExpiresAt !== undefined ? fields.tokenExpiresAt : current.token_expires_at,
        scopes: fields.scopes ?? current.scopes,
        last_sync_at: fields.lastSyncAt !== undefined ? fields.lastSyncAt : current.last_sync_at,
      };
      await db.run(sql.raw(
        `UPDATE connected_health_accounts SET provider_user_id = ${escape(next.provider_user_id)}, access_token = ${escape(next.access_token)}, refresh_token = ${escape(next.refresh_token)}, token_expires_at = ${escape(next.token_expires_at)}, scopes = ${escape(next.scopes)}, last_sync_at = ${escape(next.last_sync_at)} WHERE id = ${escape(current.id)}`,
      ));
      return accountFromRow({...current, ...next});
    }
    const id = fields.id ?? `health_${provider}_${memberId}`;
    await db.run(sql.raw(
      `INSERT INTO connected_health_accounts (id, member_id, provider, provider_user_id, access_token, refresh_token, token_expires_at, scopes, connected_at, last_sync_at)
       VALUES (${escape(id)}, ${escape(memberId)}, ${escape(provider)}, ${escape(fields.providerUserId ?? null)}, ${escape(fields.accessToken ?? null)}, ${escape(fields.refreshToken ?? null)}, ${escape(fields.tokenExpiresAt ?? null)}, ${escape(fields.scopes ?? null)}, ${escape(now)}, ${escape(fields.lastSyncAt ?? null)})`,
    ));
    return {
      id,
      memberId,
      provider,
      providerUserId: fields.providerUserId ?? null,
      accessToken: fields.accessToken ?? null,
      refreshToken: fields.refreshToken ?? null,
      tokenExpiresAt: fields.tokenExpiresAt ?? null,
      scopes: fields.scopes ?? null,
      connectedAt: now,
      lastSyncAt: fields.lastSyncAt ?? null,
    };
  });
}

function escape(value: string | null): string {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

export async function getHealthAccount(memberId: string, provider: HealthProvider): Promise<HealthAccount | null> {
  return withHealthDb(async (db) => {
    await ensureHealthSchema();
    const rows = (await db.all(
      sql.raw(`SELECT * FROM connected_health_accounts WHERE member_id = ${escape(memberId)} AND provider = ${escape(provider)} LIMIT 1`),
    )) as unknown as AccountRow[];
    return rows[0] ? accountFromRow(rows[0]) : null;
  });
}

export async function listHealthAccounts(memberId: string): Promise<HealthAccount[] | null> {
  return withHealthDb(async (db) => {
    await ensureHealthSchema();
    const rows = (await db.all(
      sql.raw(`SELECT * FROM connected_health_accounts WHERE member_id = ${escape(memberId)} ORDER BY connected_at ASC`),
    )) as unknown as AccountRow[];
    return rows.map(accountFromRow);
  });
}

/** Disconnect: delete the account AND all metrics from that source. Never partial. */
export async function deleteHealthAccount(memberId: string, provider: HealthProvider): Promise<boolean> {
  return Boolean(
    await withHealthDb(async (db) => {
      await ensureHealthSchema();
      await db.run(sql.raw(`DELETE FROM health_metrics WHERE member_id = ${escape(memberId)} AND source = ${escape(provider)}`));
      await db.run(sql.raw(`DELETE FROM connected_health_accounts WHERE member_id = ${escape(memberId)} AND provider = ${escape(provider)}`));
      return true;
    }),
  );
}

export type MetricInput = {
  workoutsJson?: string | null;
  steps?: number | null;
  sleepHours?: number | null;
  restingHr?: number | null;
  hrvMs?: number | null;
  trainingLoad?: number | null;
};

type MetricRow = {
  id: string;
  member_id: string;
  date: string;
  source: string;
  workouts_json: string | null;
  steps: number | null;
  sleep_hours: number | null;
  resting_hr: number | null;
  hrv_ms: number | null;
  training_load: number | null;
};

function metricFromRow(row: MetricRow): HealthMetric {
  return {
    id: row.id,
    memberId: row.member_id,
    date: row.date,
    source: row.source,
    workoutsJson: row.workouts_json,
    steps: row.steps,
    sleepHours: row.sleep_hours,
    restingHr: row.resting_hr,
    hrvMs: row.hrv_ms,
    trainingLoad: row.training_load,
  };
}

const num = (value: number | null | undefined): string =>
  value === null || value === undefined || Number.isNaN(value) ? "NULL" : String(value);

/** Merge incoming fields into the day's row; workouts JSON is replaced when provided. */
export async function upsertHealthMetric(
  memberId: string,
  date: string,
  source: string,
  input: MetricInput,
): Promise<HealthMetric | null> {
  return withHealthDb(async (db) => {
    await ensureHealthSchema();
    const now = new Date().toISOString();
    const rows = (await db.all(
      sql.raw(`SELECT * FROM health_metrics WHERE member_id = ${escape(memberId)} AND date = ${escape(date)} AND source = ${escape(source)} LIMIT 1`),
    )) as unknown as MetricRow[];
    if (rows[0]) {
      const current = rows[0];
      const next = {
        workouts_json: input.workoutsJson !== undefined ? input.workoutsJson : current.workouts_json,
        steps: input.steps !== undefined ? input.steps : current.steps,
        sleep_hours: input.sleepHours !== undefined ? input.sleepHours : current.sleep_hours,
        resting_hr: input.restingHr !== undefined ? input.restingHr : current.resting_hr,
        hrv_ms: input.hrvMs !== undefined ? input.hrvMs : current.hrv_ms,
        training_load: input.trainingLoad !== undefined ? input.trainingLoad : current.training_load,
      };
      await db.run(sql.raw(
        `UPDATE health_metrics SET workouts_json = ${escape(next.workouts_json)}, steps = ${num(next.steps)}, sleep_hours = ${num(next.sleep_hours)}, resting_hr = ${num(next.resting_hr)}, hrv_ms = ${num(next.hrv_ms)}, training_load = ${num(next.training_load)}, updated_at = ${escape(now)} WHERE id = ${escape(current.id)}`,
      ));
      return metricFromRow({...current, ...next});
    }
    const id = `hm_${memberId}_${date}_${source}`.replace(/[^a-zA-Z0-9_]/g, "_");
    await db.run(sql.raw(
      `INSERT INTO health_metrics (id, member_id, date, source, workouts_json, steps, sleep_hours, resting_hr, hrv_ms, training_load, created_at, updated_at)
       VALUES (${escape(id)}, ${escape(memberId)}, ${escape(date)}, ${escape(source)}, ${escape(input.workoutsJson ?? null)}, ${num(input.steps)}, ${num(input.sleepHours)}, ${num(input.restingHr)}, ${num(input.hrvMs)}, ${num(input.trainingLoad)}, ${escape(now)}, ${escape(now)})`,
    ));
    return {
      id, memberId, date, source,
      workoutsJson: input.workoutsJson ?? null,
      steps: input.steps ?? null,
      sleepHours: input.sleepHours ?? null,
      restingHr: input.restingHr ?? null,
      hrvMs: input.hrvMs ?? null,
      trainingLoad: input.trainingLoad ?? null,
    };
  });
}

export async function listHealthMetrics(
  memberId: string,
  fromDate: string,
  toDate: string,
): Promise<HealthMetric[] | null> {
  return withHealthDb(async (db) => {
    await ensureHealthSchema();
    const rows = (await db.all(
      sql.raw(`SELECT * FROM health_metrics WHERE member_id = ${escape(memberId)} AND date >= ${escape(fromDate)} AND date <= ${escape(toDate)} ORDER BY date DESC`),
    )) as unknown as MetricRow[];
    return rows.map(metricFromRow);
  });
}

export async function storeDeviceToken(
  memberId: string,
  tokenHash: string,
  deviceName?: string,
): Promise<boolean> {
  return Boolean(
    await withHealthDb(async (db) => {
      await ensureHealthSchema();
      const id = `hdt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      await db.run(sql.raw(
        `INSERT INTO health_device_tokens (id, member_id, token_hash, device_name, created_at, last_used_at)
         VALUES (${escape(id)}, ${escape(memberId)}, ${escape(tokenHash)}, ${escape(deviceName ?? null)}, ${escape(new Date().toISOString())}, NULL)`,
      ));
      return true;
    }),
  );
}

export async function memberIdForDeviceToken(tokenHash: string): Promise<string | null> {
  return withHealthDb(async (db) => {
    await ensureHealthSchema();
    const rows = (await db.all(
      sql.raw(`SELECT member_id FROM health_device_tokens WHERE token_hash = ${escape(tokenHash)} LIMIT 1`),
    )) as unknown as Array<{member_id: string}>;
    if (!rows[0]) return null;
    await db.run(sql.raw(`UPDATE health_device_tokens SET last_used_at = ${escape(new Date().toISOString())} WHERE token_hash = ${escape(tokenHash)}`));
    return rows[0].member_id;
  });
}

// ---------------------------------------------------------------------------
// Strava OAuth states: single-use, 10-minute TTL, persisted in D1 so the
// authorize -> callback round trip works across Workers isolates.
// No tokens are stored here; raw health tokens/payloads are never logged.
// ---------------------------------------------------------------------------

export type StravaOAuthState = {
  state: string;
  memberId: string;
  codeVerifier: string | null; // reserved: Strava's auth-code flow does not use PKCE
  redirectUri: string | null;
  createdAt: string;
  expiresAt: string;
};

type StravaOAuthStateRow = {
  state: string;
  member_id: string;
  code_verifier: string | null;
  redirect_uri: string | null;
  created_at: string;
  expires_at: string;
};

/** Store a fresh OAuth state. Expired rows are pruned on write so the table stays small. */
export async function storeStravaOAuthState(args: {
  state: string;
  memberId: string;
  codeVerifier?: string | null;
  redirectUri?: string | null;
  expiresAt: string;
}): Promise<boolean> {
  return Boolean(
    await withHealthDb(async (db) => {
      await ensureHealthSchema();
      const now = new Date().toISOString();
      await db.run(sql.raw(
        `INSERT INTO strava_oauth_states (state, member_id, code_verifier, redirect_uri, created_at, expires_at)
         VALUES (${escape(args.state)}, ${escape(args.memberId)}, ${escape(args.codeVerifier ?? null)}, ${escape(args.redirectUri ?? null)}, ${escape(now)}, ${escape(args.expiresAt)})`,
      ));
      // Lazy cleanup: keep the table from growing unboundedly.
      await db.run(sql.raw(`DELETE FROM strava_oauth_states WHERE expires_at <= ${escape(now)}`));
      return true;
    }),
  );
}

/**
 * Consume an OAuth state (single-use). Returns null for unknown, expired, or
 * already-consumed states. The row is deleted on read in every case, so a
 * replay of a consumed state never succeeds.
 */
export async function consumeStravaOAuthState(state: string): Promise<StravaOAuthState | null> {
  return withHealthDb(async (db) => {
    await ensureHealthSchema();
    if (!state) return null;
    const rows = (await db.all(
      sql.raw(`SELECT * FROM strava_oauth_states WHERE state = ${escape(state)} LIMIT 1`),
    )) as unknown as StravaOAuthStateRow[];
    // Delete on read regardless of validity: states are single-use.
    await db.run(sql.raw(`DELETE FROM strava_oauth_states WHERE state = ${escape(state)}`));
    const row = rows[0];
    if (!row) return null;
    // ISO-8601 UTC strings compare lexicographically; expired states are rejected.
    if (row.expires_at <= new Date().toISOString()) return null;
    return {
      state: row.state,
      memberId: row.member_id,
      codeVerifier: row.code_verifier,
      redirectUri: row.redirect_uri,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  });
}

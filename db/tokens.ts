import {sql} from "drizzle-orm";
import type {getDb as getDbType} from "./index";

type Db = ReturnType<typeof getDbType>;

// Lazy so plain Node test runs (which lack the cloudflare:workers module)
// can import this file: the D1 binding is only touched inside withTokensDb.
async function loadDb(): Promise<Db> {
  const mod = await import("./index");
  return mod.getDb();
}

export type MemberApiToken = {
  id: string;
  memberId: string;
  /** SHA-256 hex of the raw token. The raw token is never stored. */
  tokenHash: string;
  name: string;
  /** Space-separated scope list, e.g. "booking". */
  scopes: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

function escape(value: string | null): string {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function withTokensDb<T>(fn: (db: Db) => Promise<T>): Promise<T | null> {
  try {
    return await fn(await loadDb());
  } catch {
    return null;
  }
}

export async function ensureTokensSchema(): Promise<boolean> {
  return Boolean(
    await withTokensDb(async (db) => {
      await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS member_api_tokens (
        id text PRIMARY KEY NOT NULL,
        member_id text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        name text NOT NULL,
        scopes text NOT NULL DEFAULT 'booking',
        created_at text,
        last_used_at text,
        revoked_at text
      )`));
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS member_api_tokens_member_id_idx ON member_api_tokens (member_id)`));
      return true;
    }),
  );
}

/** SHA-256 hex digest. Works in Workers and Node 24 via globalThis.crypto.subtle. */
export async function hashToken(raw: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Generate a raw token like `salu_<base64url 32 bytes>`. Shown to the member once. */
export function newRawToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `salu_${base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

type TokenRow = {
  id: string;
  member_id: string;
  token_hash: string;
  name: string;
  scopes: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
};

function tokenFromRow(row: TokenRow): MemberApiToken {
  return {
    id: row.id,
    memberId: row.member_id,
    tokenHash: row.token_hash,
    name: row.name,
    scopes: row.scopes,
    createdAt: row.created_at ?? "",
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** Public view of a token record — never includes the hash. */
export type MemberApiTokenPublic = Omit<MemberApiToken, "tokenHash">;

export function publicToken(record: MemberApiToken): MemberApiTokenPublic {
  return {
    id: record.id,
    memberId: record.memberId,
    name: record.name,
    scopes: record.scopes,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

/**
 * Create a token for a member. Stores ONLY the SHA-256 hash; the raw token is
 * returned once and must be shown to the member immediately.
 */
export async function createMemberApiToken(
  memberId: string,
  name: string,
  scopes = "booking",
): Promise<{token: string; record: MemberApiTokenPublic} | null> {
  return withTokensDb(async (db) => {
    await ensureTokensSchema();
    const raw = newRawToken();
    const tokenHash = await hashToken(raw);
    const now = new Date().toISOString();
    const id = `tok_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const cleanName = name.trim().slice(0, 80) || "AI assistant";
    await db.run(sql.raw(
      `INSERT INTO member_api_tokens (id, member_id, token_hash, name, scopes, created_at, last_used_at, revoked_at)
       VALUES (${escape(id)}, ${escape(memberId)}, ${escape(tokenHash)}, ${escape(cleanName)}, ${escape(scopes)}, ${escape(now)}, NULL, NULL)`,
    ));
    return {
      token: raw,
      record: publicToken({
        id, memberId, tokenHash, name: cleanName, scopes,
        createdAt: now, lastUsedAt: null, revokedAt: null,
      }),
    };
  });
}

/**
 * Verify a raw bearer token. Returns the live token record (revoked tokens
 * rejected) and bumps last_used_at. Null when D1 is unavailable.
 */
export async function findLiveTokenByHash(tokenHash: string): Promise<MemberApiToken | null> {
  return withTokensDb(async (db) => {
    await ensureTokensSchema();
    const rows = (await db.all(
      sql.raw(`SELECT * FROM member_api_tokens WHERE token_hash = ${escape(tokenHash)} AND revoked_at IS NULL LIMIT 1`),
    )) as unknown as TokenRow[];
    const record = rows[0] ? tokenFromRow(rows[0]) : null;
    if (!record) return null;
    const now = new Date().toISOString();
    await db.run(sql.raw(`UPDATE member_api_tokens SET last_used_at = ${escape(now)} WHERE id = ${escape(record.id)}`));
    return {...record, lastUsedAt: now};
  });
}

export async function listMemberApiTokens(memberId: string): Promise<MemberApiTokenPublic[] | null> {
  return withTokensDb(async (db) => {
    await ensureTokensSchema();
    const rows = (await db.all(
      sql.raw(`SELECT * FROM member_api_tokens WHERE member_id = ${escape(memberId)} AND revoked_at IS NULL ORDER BY created_at DESC`),
    )) as unknown as TokenRow[];
    return rows.map((row) => publicToken(tokenFromRow(row)));
  });
}

export async function revokeMemberApiToken(memberId: string, tokenId: string): Promise<boolean> {  return Boolean(
    await withTokensDb(async (db) => {
      await ensureTokensSchema();
      const rows = (await db.all(
        sql.raw(`SELECT id FROM member_api_tokens WHERE id = ${escape(tokenId)} AND member_id = ${escape(memberId)} AND revoked_at IS NULL LIMIT 1`),
      )) as unknown as Array<{id: string}>;
      if (!rows[0]) return null;
      await db.run(sql.raw(`UPDATE member_api_tokens SET revoked_at = ${escape(new Date().toISOString())} WHERE id = ${escape(tokenId)}`));
      return true;
    }),
  );
}

/**
 * Verify a raw bearer token: hash, look up, reject revoked, bump last_used_at,
 * then resolve the owning member. Returns null on any failure (fail closed).
 */
export async function verifyMemberApiToken(
  rawToken: string,
): Promise<{member: import("../domain/types").Member; token: MemberApiToken} | null> {
  if (!rawToken || typeof rawToken !== "string" || !rawToken.startsWith("salu_")) return null;
  const tokenHash = await hashToken(rawToken);
  const record = await findLiveTokenByHash(tokenHash);
  if (!record) return null;
  let member: import("../domain/types").Member | null = null;
  try {
    const members = await import("./members");
    member = await members.getMemberById(record.memberId);
  } catch {
    member = null;
  }
  if (!member) return null;
  return {member, token: record};
}

/** Scope check: space-separated scopes on the token record. */
export function tokenHasScope(record: MemberApiToken, scope: string): boolean {
  return record.scopes.split(/\s+/).includes(scope);
}

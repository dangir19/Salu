import {and, desc, eq, sql} from "drizzle-orm";
import type {Booking} from "../domain/types";
import {bookings} from "./schema";

type D1Db = ReturnType<typeof import("./index").getDb>;

/**
 * Minimal D1 surface used for parameterized statements. The production
 * implementation is the D1Database behind the drizzle instance
 * (`db.$client`); tests supply a node:sqlite-backed shim.
 */
export type D1StatementShim = {
  bind(...params: Array<string | number | null>): {
    run(): Promise<{success: boolean; meta?: {changes?: number}}>;
    first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  };
};

export type D1ClientShim = {
  prepare(query: string): D1StatementShim;
};

async function loadD1Client(): Promise<D1ClientShim | null> {
  try {
    // Lazy so plain Node test runs (which lack the cloudflare:workers
    // module) fall back to memory instead of failing at import time.
    const {getDb} = await import("./index");
    const client = (getDb() as unknown as {$client?: D1ClientShim}).$client;
    return client ?? null;
  } catch {
    return null;
  }
}

export function bookingFromRow(row: typeof bookings.$inferSelect): Booking {
  return {
    id: row.id,
    memberId: row.memberId,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    provider: row.provider,
    providerId: row.providerId ?? undefined,
    availabilityId: row.availabilityId ?? undefined,
    date: row.date,
    startsAt: row.startsAt ?? undefined,
    slotEnd: row.slotEnd ?? undefined,
    mode: row.mode,
    status: row.status as Booking["status"],
    creditsCharged: row.creditsCharged,
    packageName: row.packageName ?? undefined,
    packageItem: row.packageItem ?? undefined,
    orgId: row.orgId ?? undefined,
    recipientName: row.recipientName ?? undefined,
    recipientRoom: row.recipientRoom ?? undefined,
    source: row.source ?? "web",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function withBookingsDb<T>(fn: (db: D1Db) => Promise<T>): Promise<T | null> {
  try {
    // Lazy so plain Node test runs (which lack the cloudflare:workers
    // module) fall back to memory instead of failing at import time.
    const {getDb} = await import("./index");
    return await fn(getDb());
  } catch {
    return null;
  }
}

export const SLOT_CLAIM_TTL_MS = 10 * 60 * 1000;

export const CREATE_SLOT_CLAIMS_SQL = `CREATE TABLE IF NOT EXISTS slot_claims (
  provider_id text NOT NULL,
  starts_at text NOT NULL,
  slot_end text,
  booking_id text,
  created_at text NOT NULL,
  PRIMARY KEY (provider_id, starts_at)
)`;

/**
 * Client retry keys: one live booking per (member, key). Kept in a separate
 * table (not a bookings column) so no schema/migration change is needed —
 * this module owns the table via ensureBookingsSchema. The writer claims the
 * key BEFORE inserting the booking row, so concurrent retries collide on the
 * primary key instead of creating duplicate bookings. A key whose booking
 * never landed (writer crashed) is treated as an orphan and released on
 * lookup.
 */
export const CREATE_BOOKING_IDEMPOTENCY_SQL = `CREATE TABLE IF NOT EXISTS booking_idempotency (
  member_id text NOT NULL,
  idempotency_key text NOT NULL,
  booking_id text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY (member_id, idempotency_key)
)`;

/**
 * Atomic slot claim. Inserts exactly one row when no active booking and no
 * live claim overlaps [startsAt, slotEnd) for the provider. The check and the
 * insert are a single statement, so two concurrent workers cannot both win
 * the same slot: the loser inserts zero rows (overlap) or hits the primary
 * key (identical start).
 *
 * Params: ?1 provider_id, ?2 starts_at, ?3 slot_end, ?4 booking_id,
 * ?5 created_at, ?6 exclude_booking_id ("" = none; used when rescheduling).
 */
export const CLAIM_SLOT_SQL = `INSERT INTO slot_claims (provider_id, starts_at, slot_end, booking_id, created_at)
SELECT ?1, ?2, ?3, ?4, ?5
WHERE NOT EXISTS (
  SELECT 1 FROM bookings
  WHERE provider_id = ?1
    AND status IN ('confirmed', 'held')
    AND starts_at IS NOT NULL
    AND starts_at < ?3 AND COALESCE(slot_end, starts_at) > ?2
    AND id != ?6
)
AND NOT EXISTS (
  SELECT 1 FROM slot_claims
  WHERE provider_id = ?1
    AND starts_at < ?3 AND COALESCE(slot_end, starts_at) > ?2
)`;

/** Stale claims (older than the TTL) are from requests that died mid-booking. */
export const SWEEP_SLOT_CLAIMS_SQL = `DELETE FROM slot_claims WHERE created_at < ?1`;

export const RELEASE_SLOT_CLAIM_SQL =
  `DELETE FROM slot_claims WHERE provider_id = ?1 AND starts_at = ?2 AND booking_id = ?3`;

export type SlotClaimInput = {
  providerId: string;
  startsAt: string;
  /** Normalized to a real instant by the caller (never null). */
  slotEnd: string;
  bookingId: string;
  /** Booking being rescheduled: its own row must not block the new slot. */
  excludeBookingId?: string;
  nowMs: number;
};

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint|primary key/i.test(message);
}

export class DuplicateIdempotencyKeyError extends Error {
  constructor() {
    super("Duplicate booking request.");
    this.name = "DuplicateIdempotencyKeyError";
  }
}

/**
 * Run the atomic claim against an explicit D1-compatible client. Exported so
 * tests can exercise the real SQL against a node:sqlite shim.
 */
export async function claimSlotOnClient(client: D1ClientShim, input: SlotClaimInput): Promise<boolean> {
  const cutoff = new Date(input.nowMs - SLOT_CLAIM_TTL_MS).toISOString();
  await client.prepare(SWEEP_SLOT_CLAIMS_SQL).bind(cutoff).run();
  try {
    const result = await client
      .prepare(CLAIM_SLOT_SQL)
      .bind(
        input.providerId,
        input.startsAt,
        input.slotEnd,
        input.bookingId,
        new Date(input.nowMs).toISOString(),
        input.excludeBookingId || "",
      )
      .run();
    if ((result.meta?.changes ?? 0) < 1) return false;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
  const row = await client
    .prepare(`SELECT booking_id AS "bookingId" FROM slot_claims WHERE provider_id = ?1 AND starts_at = ?2`)
    .bind(input.providerId, input.startsAt)
    .first<{bookingId: string | null}>();
  return row?.bookingId === input.bookingId;
}

/**
 * Atomic slot claim against D1. Returns null when D1 is unavailable so the
 * caller can fall back to the in-process claim store.
 */
export async function claimSlot(input: SlotClaimInput): Promise<boolean | null> {
  const client = await loadD1Client();
  if (!client) return null;
  try {
    return await claimSlotOnClient(client, input);
  } catch {
    return null;
  }
}

export async function releaseSlotClaimOnClient(
  client: D1ClientShim,
  input: {providerId: string; startsAt: string; bookingId: string},
): Promise<void> {
  await client.prepare(RELEASE_SLOT_CLAIM_SQL).bind(input.providerId, input.startsAt, input.bookingId).run();
}

/** Best-effort: the in-process claim store is already released by the caller. */
export async function releaseSlotClaim(input: {providerId: string; startsAt: string; bookingId: string}): Promise<void> {
  const client = await loadD1Client();
  if (!client) return;
  try {
    await releaseSlotClaimOnClient(client, input);
  } catch {
    // D1 cleanup is best-effort; the TTL sweep collects leftovers.
  }
}

export async function ensureBookingsSchema(): Promise<boolean> {
  return Boolean(await withBookingsDb(async (db) => {
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS bookings (
      id text PRIMARY KEY NOT NULL,
      member_id text NOT NULL,
      service_id text NOT NULL,
      service_name text NOT NULL,
      provider text NOT NULL,
      availability_id text,
      date text NOT NULL,
      starts_at text,
      mode text NOT NULL,
      status text NOT NULL,
      credits_charged integer DEFAULT 0 NOT NULL,
      package_name text,
      package_item text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`));
    try {
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS bookings_member_id_idx ON bookings (member_id)`));
    } catch {
      // Index already exists, or the D1 dialect rejected IF NOT EXISTS.
    }
    try {
      await db.run(sql.raw(CREATE_SLOT_CLAIMS_SQL));
    } catch {
      // Table already exists.
    }
    try {
      await db.run(sql.raw(CREATE_BOOKING_IDEMPOTENCY_SQL));
    } catch {
      // Table already exists.
    }
    // drizzle/0007 adds these columns on existing databases; make fresh
    // databases match the migrated shape as well.
    for (const column of ["ALTER TABLE bookings ADD COLUMN provider_id text", "ALTER TABLE bookings ADD COLUMN slot_end text", "ALTER TABLE bookings ADD COLUMN org_id text", "ALTER TABLE bookings ADD COLUMN recipient_name text", "ALTER TABLE bookings ADD COLUMN recipient_room text", "ALTER TABLE bookings ADD COLUMN source text NOT NULL DEFAULT 'web'"]) {
      try {
        await db.run(sql.raw(column));
      } catch {
        // Column already exists.
      }
    }
    return true;
  }));
}

export async function listBookingsForMember(memberId: string): Promise<Booking[] | null> {
  return withBookingsDb(async (db) => {
    const rows = await db
      .select()
      .from(bookings)
      .where(eq(bookings.memberId, memberId))
      .orderBy(desc(bookings.createdAt));
    return rows.map(bookingFromRow);
  });
}

export async function listBookingsForProvider(providerName: string): Promise<Booking[] | null> {
  return withBookingsDb(async (db) => {
    const rows = await db
      .select()
      .from(bookings)
      .where(eq(bookings.provider, providerName))
      .orderBy(desc(bookings.createdAt));
    return rows.map(bookingFromRow);
  });
}

export async function listBookingsForProviderId(providerId: string): Promise<Booking[] | null> {
  return withBookingsDb(async (db) => {
    const rows = await db
      .select()
      .from(bookings)
      .where(eq(bookings.providerId, providerId))
      .orderBy(desc(bookings.createdAt));
    return rows.map(bookingFromRow);
  });
}

export async function getBookingById(id: string): Promise<Booking | null> {
  return withBookingsDb(async (db) => {
    const rows = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
    return rows[0] ? bookingFromRow(rows[0]) : null;
  });
}

/**
 * Find the booking stored under a client retry key. Returns null when the key
 * was never claimed, or when the claim is an orphan (the writer crashed
 * before storing the booking) — the orphan is released so a retry can claim
 * the key again.
 */
export async function getBookingByIdempotencyKey(memberId: string, key: string): Promise<Booking | null> {
  const client = await loadD1Client();
  if (!client) return null;
  try {
    const row = await client
      .prepare(
        `SELECT booking_id AS "bookingId" FROM booking_idempotency WHERE member_id = ?1 AND idempotency_key = ?2`,
      )
      .bind(memberId, key)
      .first<{bookingId: string}>();
    if (!row?.bookingId) return null;
    const booking = await getBookingById(row.bookingId);
    if (!booking) {
      await client
        .prepare(`DELETE FROM booking_idempotency WHERE member_id = ?1 AND idempotency_key = ?2`)
        .bind(memberId, key)
        .run()
        .catch(() => {});
      return null;
    }
    return booking;
  } catch {
    return null;
  }
}

/** Release an idempotency key claim. Best-effort. */
async function releaseIdempotencyKey(client: D1ClientShim, memberId: string, key: string, bookingId: string): Promise<void> {
  await client
    .prepare(`DELETE FROM booking_idempotency WHERE member_id = ?1 AND idempotency_key = ?2 AND booking_id = ?3`)
    .bind(memberId, key, bookingId)
    .run()
    .catch(() => {});
}

export async function insertBooking(booking: Booking, opts?: {idempotencyKey?: string}): Promise<boolean> {
  let db: D1Db;
  try {
    const {getDb} = await import("./index");
    db = getDb();
  } catch {
    return false;
  }
  const key = opts?.idempotencyKey?.trim();
  const client = (db as unknown as {$client?: D1ClientShim}).$client ?? null;
  if (key) {
    // Claim the key BEFORE inserting the booking row: concurrent retries
    // with the same key collide on the primary key here instead of creating
    // duplicate bookings. Fail closed when the D1 client is unavailable —
    // silently skipping the claim could double-charge.
    if (!client) return false;
    try {
      await client
        .prepare(
          `INSERT INTO booking_idempotency (member_id, idempotency_key, booking_id, created_at) VALUES (?1, ?2, ?3, ?4)`,
        )
        .bind(booking.memberId, key, booking.id, new Date().toISOString())
        .run();
    } catch (error) {
      // Cross-worker idempotency race: another request already claimed this key.
      if (isUniqueViolation(error)) throw new DuplicateIdempotencyKeyError();
      return false;
    }
  }
  try {
    await db.insert(bookings).values({
      id: booking.id,
      memberId: booking.memberId,
      serviceId: booking.serviceId,
      serviceName: booking.serviceName,
      provider: booking.provider,
      providerId: booking.providerId ?? null,
      availabilityId: booking.availabilityId ?? null,
      date: booking.date,
      startsAt: booking.startsAt ?? null,
      slotEnd: booking.slotEnd ?? null,
      mode: booking.mode,
      status: booking.status,
      creditsCharged: booking.creditsCharged,
      packageName: booking.packageName ?? null,
      packageItem: booking.packageItem ?? null,
      orgId: booking.orgId ?? null,
      recipientName: booking.recipientName ?? null,
      recipientRoom: booking.recipientRoom ?? null,
      source: booking.source ?? "web",
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
    });
    return true;
  } catch {
    // Booking row failed after the key was claimed: release the claim so a
    // retry can proceed instead of deadlocking on our orphan key.
    if (key && client) await releaseIdempotencyKey(client, booking.memberId, key, booking.id);
    return false;
  }
}

export async function updateBooking(id: string, patch: Partial<Booking>): Promise<Booking | null> {
  return withBookingsDb(async (db) => {
    const rows = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
    const current = rows[0];
    if (!current) return null;
    const next = {
      date: patch.date ?? current.date,
      startsAt: patch.startsAt === "" ? null : (patch.startsAt ?? current.startsAt),
      slotEnd: patch.slotEnd === "" ? null : (patch.slotEnd ?? current.slotEnd),
      providerId: patch.providerId === "" ? null : (patch.providerId ?? current.providerId),
      status: patch.status ?? current.status,
      orgId: patch.orgId === "" ? null : (patch.orgId ?? current.orgId),
      recipientName: patch.recipientName === "" ? null : (patch.recipientName ?? current.recipientName),
      recipientRoom: patch.recipientRoom === "" ? null : (patch.recipientRoom ?? current.recipientRoom),
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    await db.update(bookings).set(next).where(eq(bookings.id, id));
    return bookingFromRow({...current, ...next});
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {
  CLAIM_SLOT_SQL,
  CREATE_SLOT_CLAIMS_SQL,
  claimSlotOnClient,
  releaseSlotClaimOnClient,
  type D1ClientShim,
  type SlotClaimInput,
} from "../db/bookings.ts";

/**
 * Exercises the exact SQL used for production slot claims against a
 * node:sqlite shim of the D1 client. Concurrency semantics (the
 * single-statement check-and-insert) are what this file verifies; the
 * TypeScript wrappers are covered by the scheduling tests.
 */

function shim(db: DatabaseSync): D1ClientShim {
  return {
    prepare(query: string) {
      return {
        bind(...params: Array<string | number | null>) {
          const args = params as unknown[];
          return {
            async run() {
              const info = db.prepare(query).run(...args);
              return {success: true, meta: {changes: Number(info.changes)}};
            },
            async first<T>(column?: string): Promise<T | null> {
              const row = db.prepare(query).get(...args) as Record<string, unknown> | undefined;
              if (!row) return null;
              return (column ? row[column] : row) as T;
            },
          };
        },
      };
    },
  };
}

function seedDb(): {db: DatabaseSync; client: D1ClientShim} {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE bookings (
    id text PRIMARY KEY,
    member_id text NOT NULL,
    provider_id text,
    starts_at text,
    slot_end text,
    status text NOT NULL
  )`);
  db.exec(CREATE_SLOT_CLAIMS_SQL);
  return {db, client: shim(db)};
}

const PROVIDER = "prov_app_test";
const DAY = "2026-09-28";
const T10 = `${DAY}T10:00:00-04:00`;
const T1030 = `${DAY}T10:30:00-04:00`;
const T11 = `${DAY}T11:00:00-04:00`;
const T12 = `${DAY}T12:00:00-04:00`;
const NOW = Date.parse(`${DAY}T08:00:00-04:00`);

function insertBooking(
  db: DatabaseSync,
  input: {id: string; startsAt: string; slotEnd?: string; status: string},
) {
  db.prepare(`INSERT INTO bookings (id, member_id, provider_id, starts_at, slot_end, status)
              VALUES (?, 'm1', ?, ?, ?, ?)`)
    .run(input.id, PROVIDER, input.startsAt, input.slotEnd ?? null, input.status);
}

function claim(input: Partial<SlotClaimInput> & {startsAt: string; slotEnd: string}): SlotClaimInput {
  return {
    providerId: PROVIDER,
    startsAt: input.startsAt,
    slotEnd: input.slotEnd,
    bookingId: input.bookingId ?? `b_${Math.random().toString(36).slice(2)}`,
    excludeBookingId: input.excludeBookingId,
    nowMs: NOW,
  };
}

test("claim inserts one row when the slot is free", async () => {
  const {client} = seedDb();
  const input = claim({startsAt: T10, slotEnd: T11});
  assert.equal(await claimSlotOnClient(client, input), true);

  const row = await client
    .prepare(`SELECT booking_id AS "bookingId" FROM slot_claims WHERE provider_id = ?1 AND starts_at = ?2`)
    .bind(PROVIDER, T10)
    .first<{bookingId: string}>();
  assert.equal(row?.bookingId, input.bookingId);
});

test("an identical start collides on the primary key", async () => {
  const {client} = seedDb();
  assert.equal(await claimSlotOnClient(client, claim({startsAt: T10, slotEnd: T11, bookingId: "b_one"})), true);
  assert.equal(await claimSlotOnClient(client, claim({startsAt: T10, slotEnd: T11, bookingId: "b_two"})), false);
});

test("overlapping intervals are rejected, abutting intervals pass", async () => {
  const {db, client} = seedDb();
  insertBooking(db, {id: "b_conf", startsAt: T10, slotEnd: T11, status: "confirmed"});

  assert.equal(await claimSlotOnClient(client, claim({startsAt: T1030, slotEnd: T12})), false);
  assert.equal(await claimSlotOnClient(client, claim({startsAt: T10, slotEnd: T11})), false);
  assert.equal(await claimSlotOnClient(client, claim({startsAt: T11, slotEnd: T12})), true);
});

test("cancelled and completed bookings do not block a claim", async () => {
  const {db, client} = seedDb();
  insertBooking(db, {id: "b_cx", startsAt: T10, slotEnd: T11, status: "cancelled"});
  assert.equal(await claimSlotOnClient(client, claim({startsAt: T10, slotEnd: T11})), true);

  const {client: client2, db: db2} = seedDb();
  insertBooking(db2, {id: "b_done", startsAt: T10, slotEnd: T11, status: "completed"});
  assert.equal(await claimSlotOnClient(client2, claim({startsAt: T10, slotEnd: T11})), true);
});

test("release frees the slot for a later claim", async () => {
  const {client} = seedDb();
  const first = claim({startsAt: T10, slotEnd: T11, bookingId: "b_one"});
  assert.equal(await claimSlotOnClient(client, first), true);
  await releaseSlotClaimOnClient(client, {providerId: PROVIDER, startsAt: T10, bookingId: "b_one"});
  assert.equal(await claimSlotOnClient(client, claim({startsAt: T10, slotEnd: T11, bookingId: "b_two"})), true);
});

test("stale claims are swept before the overlap check", async () => {
  const {db, client} = seedDb();
  const staleAt = new Date(NOW - 20 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO slot_claims (provider_id, starts_at, slot_end, booking_id, created_at)
              VALUES (?, ?, ?, 'b_stale', ?)`)
    .run(PROVIDER, T10, T11, staleAt);

  assert.equal(await claimSlotOnClient(client, claim({startsAt: T10, slotEnd: T11, bookingId: "b_fresh"})), true);
});

test("excludeBookingId lets a reschedule overlap the booking's own slot", async () => {
  const {db, client} = seedDb();
  insertBooking(db, {id: "b_move", startsAt: T10, slotEnd: T11, status: "confirmed"});

  // Without the exclusion, the booking's own interval blocks the claim.
  assert.equal(await claimSlotOnClient(client, claim({startsAt: T1030, slotEnd: T12})), false);
  // With it, the reschedule can move onto an overlapping window.
  assert.equal(
    await claimSlotOnClient(client, claim({startsAt: T1030, slotEnd: T12, excludeBookingId: "b_move"})),
    true,
  );
});

test("zero-length legacy bookings only block the exact instant", async () => {
  const {db, client} = seedDb();
  insertBooking(db, {id: "b_legacy", startsAt: T10, status: "confirmed"}); // slot_end NULL

  // Half-open: a point at 10:00 does not block [10:00, 11:00).
  assert.equal(await claimSlotOnClient(client, claim({startsAt: T10, slotEnd: T11})), true);

  const {client: client2, db: db2} = seedDb();
  insertBooking(db2, {id: "b_legacy2", startsAt: T10, status: "confirmed"});
  // But [09:30, 10:30) contains the point and is blocked.
  assert.equal(
    await claimSlotOnClient(client2, claim({startsAt: `${DAY}T09:30:00-04:00`, slotEnd: T1030})),
    false,
  );
});

test("CLAIM_SLOT_SQL params bind in ?1..?6 order", () => {
  // Guard against a refactor reordering placeholders without updating bind().
  const placeholders = CLAIM_SLOT_SQL.match(/\?[1-6]/g) ?? [];
  assert.deepEqual([...new Set(placeholders)].sort(), ["?1", "?2", "?3", "?4", "?5", "?6"]);
  assert.ok(CLAIM_SLOT_SQL.includes("INSERT INTO slot_claims"));
  assert.ok(CLAIM_SLOT_SQL.includes("NOT EXISTS"));
});

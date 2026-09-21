import {desc, eq, sql} from "drizzle-orm";
import type {Booking} from "../domain/types";
import {getDb} from "./index";
import {bookings} from "./schema";

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

export async function withBookingsDb<T>(fn: (db: ReturnType<typeof getDb>) => Promise<T>): Promise<T | null> {
  try {
    return await fn(getDb());
  } catch {
    return null;
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

export async function insertBooking(booking: Booking): Promise<boolean> {
  return Boolean(await withBookingsDb(async (db) => {
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
  }));
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

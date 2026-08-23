import {desc, eq, sql} from "drizzle-orm";
import type {Booking} from "../domain/types";
import {getDb} from "./index";
import {bookings} from "./schema";

function bookingFromRow(row: typeof bookings.$inferSelect): Booking {
  return {
    id: row.id,
    memberId: row.memberId,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    provider: row.provider,
    availabilityId: row.availabilityId ?? undefined,
    date: row.date,
    startsAt: row.startsAt ?? undefined,
    mode: row.mode,
    status: row.status as Booking["status"],
    creditsCharged: row.creditsCharged,
    packageName: row.packageName ?? undefined,
    packageItem: row.packageItem ?? undefined,
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
      availabilityId: booking.availabilityId ?? null,
      date: booking.date,
      startsAt: booking.startsAt ?? null,
      mode: booking.mode,
      status: booking.status,
      creditsCharged: booking.creditsCharged,
      packageName: booking.packageName ?? null,
      packageItem: booking.packageItem ?? null,
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
      status: patch.status ?? current.status,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    await db.update(bookings).set(next).where(eq(bookings.id, id));
    return bookingFromRow({...current, ...next});
  });
}

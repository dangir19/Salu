import {eq, sql} from "drizzle-orm";
import type {getDb} from "./index";
import {providerAvailability, providerDateOverrides} from "./schema";

export type AvailabilityWindow = {
  id: string;
  providerId: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  createdAt: string;
  updatedAt: string;
};

export type WeeklyWindowInput = {
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
};

export type DateOverride = {
  id: string;
  providerId: string;
  date: string;
  startMinutes?: number;
  endMinutes?: number;
  isClosed: boolean;
  note?: string;
  createdAt: string;
  updatedAt: string;
};

export type DateOverrideInput = {
  date: string;
  startMinutes?: number;
  endMinutes?: number;
  isClosed: boolean;
  note?: string;
};

const availabilityMemory = new Map<string, AvailabilityWindow[]>();
const overrideMemory = new Map<string, DateOverride[]>();

export function resetSchedulingMemory(): void {
  availabilityMemory.clear();
  overrideMemory.clear();
}

export async function withSchedulingDb<T>(fn: (db: ReturnType<typeof getDb>) => Promise<T>): Promise<T | null> {
  try {
    // Lazy so plain Node test runs (which lack the cloudflare:workers
    // module) fall back to memory instead of failing at import time.
    const {getDb: loadDb} = await import("./index");
    return await fn(loadDb());
  } catch {
    return null;
  }
}

export async function ensureSchedulingSchema(): Promise<boolean> {
  return Boolean(await withSchedulingDb(async (db) => {
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS provider_availability (
      id text PRIMARY KEY NOT NULL,
      provider_id text NOT NULL,
      day_of_week integer NOT NULL,
      start_minutes integer NOT NULL,
      end_minutes integer NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`));
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS provider_date_overrides (
      id text PRIMARY KEY NOT NULL,
      provider_id text NOT NULL,
      date text NOT NULL,
      start_minutes integer,
      end_minutes integer,
      is_closed integer DEFAULT 0 NOT NULL,
      note text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`));
    try {
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS provider_availability_provider_day_idx ON provider_availability (provider_id, day_of_week)`));
      await db.run(sql.raw(`CREATE INDEX IF NOT EXISTS provider_date_overrides_provider_date_idx ON provider_date_overrides (provider_id, date)`));
    } catch {
      // Index already exists, or the D1 dialect rejected IF NOT EXISTS.
    }
    return true;
  }));
}

function windowFromRow(row: typeof providerAvailability.$inferSelect): AvailabilityWindow {
  return {
    id: row.id,
    providerId: row.providerId,
    dayOfWeek: row.dayOfWeek,
    startMinutes: row.startMinutes,
    endMinutes: row.endMinutes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function overrideFromRow(row: typeof providerDateOverrides.$inferSelect): DateOverride {
  return {
    id: row.id,
    providerId: row.providerId,
    date: row.date,
    startMinutes: row.startMinutes ?? undefined,
    endMinutes: row.endMinutes ?? undefined,
    isClosed: Boolean(row.isClosed),
    note: row.note ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listAvailability(providerId: string): Promise<AvailabilityWindow[]> {
  await ensureSchedulingSchema();
  const persisted = await withSchedulingDb(async (db) => {
    const rows = await db
      .select()
      .from(providerAvailability)
      .where(eq(providerAvailability.providerId, providerId));
    return rows.map(windowFromRow);
  });
  if (persisted) {
    const merged = new Map<string, AvailabilityWindow>();
    for (const row of availabilityMemory.get(providerId) ?? []) merged.set(row.id, row);
    for (const row of persisted) merged.set(row.id, row);
    return [...merged.values()].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinutes - b.startMinutes);
  }
  return (availabilityMemory.get(providerId) ?? [])
    .slice()
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinutes - b.startMinutes);
}

export async function replaceWeeklyAvailability(
  providerId: string,
  windows: WeeklyWindowInput[],
): Promise<AvailabilityWindow[]> {
  await ensureSchedulingSchema();
  const now = new Date().toISOString();
  const rows: AvailabilityWindow[] = windows.map((window) => ({
    id: `av_${crypto.randomUUID()}`,
    providerId,
    dayOfWeek: window.dayOfWeek,
    startMinutes: window.startMinutes,
    endMinutes: window.endMinutes,
    createdAt: now,
    updatedAt: now,
  }));
  availabilityMemory.set(providerId, rows);
  await withSchedulingDb(async (db) => {
    await db.delete(providerAvailability).where(eq(providerAvailability.providerId, providerId));
    if (rows.length) {
      await db.insert(providerAvailability).values(rows.map((row) => ({
        id: row.id,
        providerId: row.providerId,
        dayOfWeek: row.dayOfWeek,
        startMinutes: row.startMinutes,
        endMinutes: row.endMinutes,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })));
    }
    return true;
  });
  return rows;
}

export async function listOverrides(providerId: string): Promise<DateOverride[]> {
  await ensureSchedulingSchema();
  const persisted = await withSchedulingDb(async (db) => {
    const rows = await db
      .select()
      .from(providerDateOverrides)
      .where(eq(providerDateOverrides.providerId, providerId));
    return rows.map(overrideFromRow);
  });
  if (persisted) {
    const merged = new Map<string, DateOverride>();
    for (const row of overrideMemory.get(providerId) ?? []) merged.set(row.id, row);
    for (const row of persisted) merged.set(row.id, row);
    return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
  return (overrideMemory.get(providerId) ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
}

export async function upsertOverride(providerId: string, input: DateOverrideInput): Promise<DateOverride> {
  await ensureSchedulingSchema();
  const now = new Date().toISOString();
  const existing = (overrideMemory.get(providerId) ?? []).find((row) => row.date === input.date);
  const row: DateOverride = {
    id: existing?.id ?? `ov_${crypto.randomUUID()}`,
    providerId,
    date: input.date,
    startMinutes: input.startMinutes,
    endMinutes: input.endMinutes,
    isClosed: input.isClosed,
    note: input.note,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const list = (overrideMemory.get(providerId) ?? []).filter((entry) => entry.date !== input.date);
  list.push(row);
  overrideMemory.set(providerId, list);
  await withSchedulingDb(async (db) => {
    const current = await db
      .select()
      .from(providerDateOverrides)
      .where(eq(providerDateOverrides.providerId, providerId));
    const match = current.map(overrideFromRow).find((entry) => entry.date === input.date);
    const values = {
      id: row.id,
      providerId: row.providerId,
      date: row.date,
      startMinutes: row.startMinutes ?? null,
      endMinutes: row.endMinutes ?? null,
      isClosed: row.isClosed ? 1 : 0,
      note: row.note ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (match) {
      await db.update(providerDateOverrides).set(values).where(eq(providerDateOverrides.id, match.id));
    } else {
      await db.insert(providerDateOverrides).values(values);
    }
    return true;
  });
  return row;
}

export async function deleteOverride(providerId: string, id: string): Promise<boolean> {
  await ensureSchedulingSchema();
  const list = (overrideMemory.get(providerId) ?? []).filter((row) => row.id !== id);
  const removed = list.length !== (overrideMemory.get(providerId) ?? []).length;
  overrideMemory.set(providerId, list);
  const persisted = await withSchedulingDb(async (db) => {
    const current = await db
      .select()
      .from(providerDateOverrides)
      .where(eq(providerDateOverrides.providerId, providerId));
    const match = current.map(overrideFromRow).find((row) => row.id === id);
    if (!match) return false;
    await db.delete(providerDateOverrides).where(eq(providerDateOverrides.id, id));
    return true;
  });
  return persisted ?? removed;
}
import {desc, eq, sql} from "drizzle-orm";
import type {AppointmentRequest, ProviderAccount, ProviderAssignment, ProviderBlock} from "../domain/types";
import {getDb} from "./index";
import {appointmentRequests, providerAccounts, providerAssignments, providerBlocks} from "./schema";

function parseServiceIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return raw ? raw.split(",").map((value) => value.trim()).filter(Boolean) : [];
  }
}

function accountFromRow(row: typeof providerAccounts.$inferSelect): ProviderAccount {
  return {
    id: row.id,
    memberId: row.memberId ?? undefined,
    email: row.email,
    displayName: row.displayName,
    practiceId: row.practiceId,
    practiceName: row.practiceName,
    status: row.status as ProviderAccount["status"],
    serviceIds: parseServiceIds(row.serviceIds),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function requestFromRow(row: typeof appointmentRequests.$inferSelect): AppointmentRequest {
  return {
    id: row.id,
    bookingId: row.bookingId,
    memberId: row.memberId,
    memberDisplayName: row.memberDisplayName,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    practiceId: row.practiceId,
    practiceName: row.practiceName,
    date: row.date,
    mode: row.mode,
    creditsCharged: row.creditsCharged,
    status: row.status as AppointmentRequest["status"],
    assignedProviderId: row.assignedProviderId ?? undefined,
    proposedDate: row.proposedDate ?? undefined,
    note: row.note ?? undefined,
    walkthrough: Boolean(row.walkthrough),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assignmentFromRow(row: typeof providerAssignments.$inferSelect): ProviderAssignment {
  return {
    id: row.id,
    requestId: row.requestId,
    bookingId: row.bookingId,
    providerId: row.providerId,
    practiceId: row.practiceId,
    status: row.status as ProviderAssignment["status"],
    proposedDate: row.proposedDate ?? undefined,
    createdAt: row.createdAt,
  };
}

function blockFromRow(row: typeof providerBlocks.$inferSelect): ProviderBlock {
  return {
    id: row.id,
    providerId: row.providerId,
    practiceId: row.practiceId,
    date: row.date,
    note: row.note ?? undefined,
    createdAt: row.createdAt,
  };
}

export async function withProviderDb<T>(fn: (db: ReturnType<typeof getDb>) => Promise<T>): Promise<T | null> {
  try {
    return await fn(getDb());
  } catch {
    return null;
  }
}

export async function ensureProviderWorkspaceSchema(): Promise<boolean> {
  return Boolean(await withProviderDb(async (db) => {
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS provider_accounts (
      id text PRIMARY KEY NOT NULL,
      member_id text,
      email text NOT NULL,
      display_name text NOT NULL,
      practice_id text NOT NULL,
      practice_name text NOT NULL,
      status text NOT NULL,
      service_ids text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`));
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS appointment_requests (
      id text PRIMARY KEY NOT NULL,
      booking_id text NOT NULL,
      member_id text NOT NULL,
      member_display_name text NOT NULL,
      service_id text NOT NULL,
      service_name text NOT NULL,
      practice_id text NOT NULL,
      practice_name text NOT NULL,
      date text NOT NULL,
      mode text NOT NULL,
      credits_charged integer DEFAULT 0 NOT NULL,
      status text NOT NULL,
      assigned_provider_id text,
      proposed_date text,
      note text,
      walkthrough integer DEFAULT 0 NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`));
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS provider_assignments (
      id text PRIMARY KEY NOT NULL,
      request_id text NOT NULL,
      booking_id text NOT NULL,
      provider_id text NOT NULL,
      practice_id text NOT NULL,
      status text NOT NULL,
      proposed_date text,
      created_at text NOT NULL
    )`));
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS provider_blocks (
      id text PRIMARY KEY NOT NULL,
      provider_id text NOT NULL,
      practice_id text NOT NULL,
      date text NOT NULL,
      note text,
      created_at text NOT NULL
    )`));
    for (const statement of [
      `CREATE UNIQUE INDEX IF NOT EXISTS provider_accounts_email_idx ON provider_accounts (email)`,
      `CREATE INDEX IF NOT EXISTS provider_accounts_practice_id_idx ON provider_accounts (practice_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS appointment_requests_booking_id_idx ON appointment_requests (booking_id)`,
      `CREATE INDEX IF NOT EXISTS appointment_requests_practice_id_idx ON appointment_requests (practice_id)`,
      `CREATE INDEX IF NOT EXISTS appointment_requests_status_idx ON appointment_requests (status)`,
      `CREATE INDEX IF NOT EXISTS provider_assignments_provider_id_idx ON provider_assignments (provider_id)`,
      `CREATE INDEX IF NOT EXISTS provider_blocks_provider_id_idx ON provider_blocks (provider_id)`,
    ]) {
      try {
        await db.run(sql.raw(statement));
      } catch {
        // Index already exists, or the D1 dialect rejected IF NOT EXISTS.
      }
    }
    return true;
  }));
}

export async function getProviderAccountByEmail(email: string): Promise<ProviderAccount | null> {
  return withProviderDb(async (db) => {
    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.email, email)).limit(1);
    return rows[0] ? accountFromRow(rows[0]) : null;
  });
}

export async function getProviderAccountById(id: string): Promise<ProviderAccount | null> {
  return withProviderDb(async (db) => {
    const rows = await db.select().from(providerAccounts).where(eq(providerAccounts.id, id)).limit(1);
    return rows[0] ? accountFromRow(rows[0]) : null;
  });
}

export async function upsertProviderAccountRow(account: ProviderAccount): Promise<boolean> {
  return Boolean(await withProviderDb(async (db) => {
    const existing = await db.select().from(providerAccounts).where(eq(providerAccounts.email, account.email)).limit(1);
    const values = {
      id: existing[0]?.id ?? account.id,
      memberId: account.memberId ?? existing[0]?.memberId ?? null,
      email: account.email,
      displayName: account.displayName,
      practiceId: account.practiceId,
      practiceName: account.practiceName,
      status: account.status,
      serviceIds: JSON.stringify(account.serviceIds),
      createdAt: existing[0]?.createdAt ?? account.createdAt,
      updatedAt: account.updatedAt,
    };
    if (existing[0]) {
      await db.update(providerAccounts).set(values).where(eq(providerAccounts.email, account.email));
    } else {
      await db.insert(providerAccounts).values(values);
    }
    return true;
  }));
}

export async function listAppointmentRequests(): Promise<AppointmentRequest[] | null> {
  return withProviderDb(async (db) => {
    const rows = await db.select().from(appointmentRequests).orderBy(desc(appointmentRequests.createdAt));
    return rows.map(requestFromRow);
  });
}

export async function getAppointmentRequestById(id: string): Promise<AppointmentRequest | null> {
  return withProviderDb(async (db) => {
    const rows = await db.select().from(appointmentRequests).where(eq(appointmentRequests.id, id)).limit(1);
    return rows[0] ? requestFromRow(rows[0]) : null;
  });
}

export async function getAppointmentRequestByBookingId(bookingId: string): Promise<AppointmentRequest | null> {
  return withProviderDb(async (db) => {
    const rows = await db.select().from(appointmentRequests).where(eq(appointmentRequests.bookingId, bookingId)).limit(1);
    return rows[0] ? requestFromRow(rows[0]) : null;
  });
}

export async function insertAppointmentRequest(request: AppointmentRequest): Promise<boolean> {
  return Boolean(await withProviderDb(async (db) => {
    await db.insert(appointmentRequests).values({
      id: request.id,
      bookingId: request.bookingId,
      memberId: request.memberId,
      memberDisplayName: request.memberDisplayName,
      serviceId: request.serviceId,
      serviceName: request.serviceName,
      practiceId: request.practiceId,
      practiceName: request.practiceName,
      date: request.date,
      mode: request.mode,
      creditsCharged: request.creditsCharged,
      status: request.status,
      assignedProviderId: request.assignedProviderId ?? null,
      proposedDate: request.proposedDate ?? null,
      note: request.note ?? null,
      walkthrough: request.walkthrough ? 1 : 0,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    });
    return true;
  }));
}

export async function updateAppointmentRequest(id: string, patch: Partial<AppointmentRequest>): Promise<AppointmentRequest | null> {
  return withProviderDb(async (db) => {
    const rows = await db.select().from(appointmentRequests).where(eq(appointmentRequests.id, id)).limit(1);
    const current = rows[0];
    if (!current) return null;
    const next = {
      date: patch.date ?? current.date,
      status: patch.status ?? current.status,
      assignedProviderId: patch.assignedProviderId === "" ? null : (patch.assignedProviderId ?? current.assignedProviderId),
      proposedDate: patch.proposedDate === "" ? null : (patch.proposedDate ?? current.proposedDate),
      note: patch.note === "" ? null : (patch.note ?? current.note),
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    await db.update(appointmentRequests).set(next).where(eq(appointmentRequests.id, id));
    return requestFromRow({...current, ...next});
  });
}

export async function insertProviderAssignment(assignment: ProviderAssignment): Promise<boolean> {
  return Boolean(await withProviderDb(async (db) => {
    await db.insert(providerAssignments).values({
      id: assignment.id,
      requestId: assignment.requestId,
      bookingId: assignment.bookingId,
      providerId: assignment.providerId,
      practiceId: assignment.practiceId,
      status: assignment.status,
      proposedDate: assignment.proposedDate ?? null,
      createdAt: assignment.createdAt,
    });
    return true;
  }));
}

export async function listAssignmentsForProvider(providerId: string): Promise<ProviderAssignment[] | null> {
  return withProviderDb(async (db) => {
    const rows = await db
      .select()
      .from(providerAssignments)
      .where(eq(providerAssignments.providerId, providerId))
      .orderBy(desc(providerAssignments.createdAt));
    return rows.map(assignmentFromRow);
  });
}

export async function insertProviderBlock(block: ProviderBlock): Promise<boolean> {
  return Boolean(await withProviderDb(async (db) => {
    await db.insert(providerBlocks).values({
      id: block.id,
      providerId: block.providerId,
      practiceId: block.practiceId,
      date: block.date,
      note: block.note ?? null,
      createdAt: block.createdAt,
    });
    return true;
  }));
}

export async function deleteProviderBlock(id: string): Promise<boolean> {
  return Boolean(await withProviderDb(async (db) => {
    await db.delete(providerBlocks).where(eq(providerBlocks.id, id));
    return true;
  }));
}

export async function listBlocksForProvider(providerId: string): Promise<ProviderBlock[] | null> {
  return withProviderDb(async (db) => {
    const rows = await db
      .select()
      .from(providerBlocks)
      .where(eq(providerBlocks.providerId, providerId))
      .orderBy(desc(providerBlocks.createdAt));
    return rows.map(blockFromRow);
  });
}

export async function getProviderBlockById(id: string): Promise<ProviderBlock | null> {
  return withProviderDb(async (db) => {
    const rows = await db.select().from(providerBlocks).where(eq(providerBlocks.id, id)).limit(1);
    return rows[0] ? blockFromRow(rows[0]) : null;
  });
}

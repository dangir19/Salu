import {desc, eq, sql} from "drizzle-orm";
import type {Booking, Member} from "../domain/types";
import {getDb} from "./index";
import {
  bookingLineItems,
  bookings,
  orgCreditTransactions,
  orgMembers,
  orgRecurringOrders,
  orgWallets,
  organizations,
} from "./schema";
import {bookingFromRow} from "./bookings";

export type Org = typeof organizations.$inferSelect;
export type OrgMember = typeof orgMembers.$inferSelect;
export type OrgWallet = typeof orgWallets.$inferSelect;
export type OrgCreditTransaction = typeof orgCreditTransactions.$inferSelect;
export type BookingLineItem = typeof bookingLineItems.$inferSelect;
export type OrgRecurringOrder = typeof orgRecurringOrders.$inferSelect;

async function withOrgsDb<T>(fn: (db: ReturnType<typeof getDb>) => Promise<T>): Promise<T | null> {
  try {
    return await fn(getDb());
  } catch {
    return null;
  }
}

export async function ensureOrgsSchema(): Promise<boolean> {
  return Boolean(await withOrgsDb(async (db) => {
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS organizations (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      org_type text DEFAULT 'other' NOT NULL,
      contact_name text NOT NULL,
      contact_email text NOT NULL,
      contact_phone text,
      address text,
      billing_email text,
      status text DEFAULT 'pending' NOT NULL,
      stripe_customer_id text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`));
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS org_members (
      id text PRIMARY KEY NOT NULL,
      org_id text NOT NULL,
      member_id text NOT NULL,
      role text DEFAULT 'staff' NOT NULL,
      created_at text NOT NULL
    )`));
    try {
      await db.run(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS org_members_org_member_idx ON org_members (org_id, member_id)`));
    } catch {
      // Index already exists, or the D1 dialect rejected IF NOT EXISTS.
    }
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS org_wallets (
      id text PRIMARY KEY NOT NULL,
      org_id text NOT NULL UNIQUE,
      available_credits integer DEFAULT 0 NOT NULL,
      updated_at text NOT NULL
    )`));
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS org_credit_transactions (
      id text PRIMARY KEY NOT NULL,
      wallet_id text NOT NULL,
      kind text NOT NULL,
      credits integer NOT NULL,
      label text NOT NULL,
      created_at text NOT NULL,
      booking_id text,
      stripe_event_id text,
      stripe_object_id text
    )`));
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS booking_line_items (
      id text PRIMARY KEY NOT NULL,
      booking_id text NOT NULL,
      label text NOT NULL,
      quantity integer DEFAULT 1 NOT NULL,
      unit_credits integer NOT NULL,
      total_credits integer NOT NULL,
      created_at text NOT NULL
    )`));
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS org_recurring_orders (
      id text PRIMARY KEY NOT NULL,
      org_id text NOT NULL,
      service_id text NOT NULL,
      provider_id text,
      recipient_name text,
      recipient_room text,
      weekday integer NOT NULL,
      time_local text NOT NULL,
      start_date text NOT NULL,
      end_date text NOT NULL,
      status text DEFAULT 'active' NOT NULL,
      created_by text NOT NULL,
      created_at text NOT NULL
    )`));
    for (const column of [
      "ALTER TABLE bookings ADD COLUMN org_id text",
      "ALTER TABLE bookings ADD COLUMN recipient_name text",
      "ALTER TABLE bookings ADD COLUMN recipient_room text",
    ]) {
      try {
        await db.run(sql.raw(column));
      } catch {
        // Column already exists.
      }
    }
    return true;
  }));
}

export async function insertOrganization(org: Org): Promise<boolean> {
  return Boolean(await withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    await db.insert(organizations).values(org);
    return true;
  }));
}

export async function getOrganizationById(id: string): Promise<Org | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    const rows = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    return rows[0] ?? null;
  });
}

export async function listOrganizations(): Promise<Org[] | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    return db.select().from(organizations).orderBy(desc(organizations.createdAt));
  });
}

export async function updateOrganizationStatus(id: string, status: string): Promise<Org | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    await db
      .update(organizations)
      .set({status, updatedAt: new Date().toISOString()})
      .where(eq(organizations.id, id));
    const rows = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
    return rows[0] ?? null;
  });
}

export async function insertOrgMember(row: OrgMember): Promise<boolean> {
  return Boolean(await withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    await db.insert(orgMembers).values(row).onConflictDoNothing({target: [orgMembers.orgId, orgMembers.memberId]});
    return true;
  }));
}

export async function updateOrgMemberRole(orgId: string, memberId: string, role: string): Promise<boolean> {
  return Boolean(await withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    await db
      .update(orgMembers)
      .set({role})
      .where(sql`${orgMembers.orgId} = ${orgId} AND ${orgMembers.memberId} = ${memberId}`);
    return true;
  }));
}

export async function listOrgMembers(orgId: string): Promise<OrgMember[] | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    return db.select().from(orgMembers).where(eq(orgMembers.orgId, orgId)).orderBy(orgMembers.createdAt);
  });
}

export async function getMembershipForMember(orgId: string, memberId: string): Promise<OrgMember | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    const rows = await db
      .select()
      .from(orgMembers)
      .where(sql`${orgMembers.orgId} = ${orgId} AND ${orgMembers.memberId} = ${memberId}`)
      .limit(1);
    return rows[0] ?? null;
  });
}

export async function getMembershipsForMember(memberId: string): Promise<OrgMember[] | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    return db.select().from(orgMembers).where(eq(orgMembers.memberId, memberId));
  });
}

export type OrgMemberDisplay = {
  memberId: string;
  email: string | null;
  displayName: string | null;
  role: string;
};

export async function listOrgMemberDisplays(orgId: string): Promise<OrgMemberDisplay[] | null> {
  const rows = await listOrgMembers(orgId);
  if (!rows) return null;
  const {findMemberRecord} = await import("../auth/members");
  const displays: OrgMemberDisplay[] = [];
  for (const row of rows) {
    const member: Member | null = await findMemberRecord({id: row.memberId}).catch(() => null);
    displays.push({
      memberId: row.memberId,
      email: member?.email ?? null,
      displayName: member?.displayName ?? null,
      role: row.role,
    });
  }
  return displays;
}

export async function getOrgWallet(orgId: string): Promise<OrgWallet | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    const rows = await db.select().from(orgWallets).where(eq(orgWallets.orgId, orgId)).limit(1);
    return rows[0] ?? null;
  });
}

export async function upsertOrgWallet(orgId: string, availableCredits: number): Promise<boolean> {
  return Boolean(await withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    await db
      .insert(orgWallets)
      .values({
        id: `ow_${orgId}`,
        orgId,
        availableCredits,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: orgWallets.orgId,
        set: {availableCredits, updatedAt: new Date().toISOString()},
      });
    return true;
  }));
}

export async function hasOrgObjectTransaction(objectId: string, kind: string): Promise<boolean | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    const rows = await db
      .select({id: orgCreditTransactions.id})
      .from(orgCreditTransactions)
      .where(sql`${orgCreditTransactions.stripeObjectId} = ${objectId} AND ${orgCreditTransactions.kind} = ${kind}`)
      .limit(1);
    return rows.length > 0;
  });
}

export async function insertOrgTransaction(tx: OrgCreditTransaction): Promise<boolean> {
  return Boolean(await withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    await db.insert(orgCreditTransactions).values(tx);
    return true;
  }));
}

export async function listOrgTransactions(walletId: string): Promise<OrgCreditTransaction[] | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    return db
      .select()
      .from(orgCreditTransactions)
      .where(eq(orgCreditTransactions.walletId, walletId))
      .orderBy(desc(orgCreditTransactions.createdAt));
  });
}

export async function insertLineItem(item: BookingLineItem): Promise<boolean> {
  return Boolean(await withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    await db.insert(bookingLineItems).values(item);
    return true;
  }));
}

export async function listLineItemsForBooking(bookingId: string): Promise<BookingLineItem[] | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    return db.select().from(bookingLineItems).where(eq(bookingLineItems.bookingId, bookingId));
  });
}

export async function insertRecurringOrder(order: OrgRecurringOrder): Promise<boolean> {
  return Boolean(await withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    await db.insert(orgRecurringOrders).values(order);
    return true;
  }));
}

export async function listRecurringOrders(orgId: string): Promise<OrgRecurringOrder[] | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    return db
      .select()
      .from(orgRecurringOrders)
      .where(eq(orgRecurringOrders.orgId, orgId))
      .orderBy(desc(orgRecurringOrders.createdAt));
  });
}

export async function updateRecurringOrderStatus(id: string, status: string): Promise<boolean> {
  return Boolean(await withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    await db.update(orgRecurringOrders).set({status}).where(eq(orgRecurringOrders.id, id));
    return true;
  }));
}

export async function listBookingsForOrg(orgId: string): Promise<Booking[] | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    const rows = await db
      .select()
      .from(bookings)
      .where(eq(bookings.orgId, orgId))
      .orderBy(desc(bookings.createdAt));
    return rows.map(bookingFromRow);
  });
}

export async function getOrganizationByContactEmail(email: string): Promise<Org | null> {
  return withOrgsDb(async (db) => {
    await ensureOrgsSchema();
    const rows = await db
      .select()
      .from(organizations)
      .where(eq(organizations.contactEmail, email.toLowerCase()))
      .limit(1);
    return rows[0] ?? null;
  });
}

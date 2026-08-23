import {desc, eq, sql} from "drizzle-orm";
import type {ConnectStatus, Provider, ProviderPayout, ProviderPayoutStatus} from "../domain/types";
import {getDb} from "./index";
import {providerPayouts, providers} from "./schema";

function flag(value: number | boolean | null | undefined): boolean {
  return Boolean(value);
}

function providerFromRow(row: typeof providers.$inferSelect): Provider {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? undefined,
    memberId: row.memberId ?? undefined,
    status: row.status as Provider["status"],
    commissionRate: row.commissionRate,
    stripeConnectAccountId: row.stripeConnectAccountId ?? undefined,
    connectStatus: row.connectStatus as ConnectStatus,
    chargesEnabled: flag(row.chargesEnabled),
    payoutsEnabled: flag(row.payoutsEnabled),
    detailsSubmitted: flag(row.detailsSubmitted),
  };
}

function payoutFromRow(row: typeof providerPayouts.$inferSelect): ProviderPayout {
  return {
    id: row.id,
    bookingId: row.bookingId,
    providerId: row.providerId,
    grossAmount: row.grossAmount,
    commissionAmount: row.commissionAmount,
    netPayout: row.netPayout,
    status: row.status as ProviderPayoutStatus,
    stripeTransferId: row.stripeTransferId ?? undefined,
  };
}

export async function withConnectDb<T>(fn: (db: ReturnType<typeof getDb>) => Promise<T>): Promise<T | null> {
  try {
    return await fn(getDb());
  } catch {
    return null;
  }
}

export async function ensureConnectSchema(): Promise<boolean> {
  return Boolean(await withConnectDb(async (db) => {
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS providers (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      email text,
      member_id text,
      status text DEFAULT 'approved' NOT NULL,
      commission_rate integer DEFAULT 20 NOT NULL,
      stripe_connect_account_id text,
      connect_status text DEFAULT 'not_connected' NOT NULL,
      charges_enabled integer DEFAULT 0 NOT NULL,
      payouts_enabled integer DEFAULT 0 NOT NULL,
      details_submitted integer DEFAULT 0 NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`));
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS provider_payouts (
      id text PRIMARY KEY NOT NULL,
      booking_id text NOT NULL,
      provider_id text NOT NULL,
      gross_amount integer NOT NULL,
      commission_amount integer NOT NULL,
      net_payout integer NOT NULL,
      status text NOT NULL,
      stripe_transfer_id text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    )`));
    return true;
  }));
}

export async function listProviderRows(): Promise<Provider[] | null> {
  return withConnectDb(async (db) => {
    const rows = await db.select().from(providers);
    return rows.map(providerFromRow);
  });
}

export async function getProviderById(id: string): Promise<Provider | null> {
  return withConnectDb(async (db) => {
    const rows = await db.select().from(providers).where(eq(providers.id, id)).limit(1);
    return rows[0] ? providerFromRow(rows[0]) : null;
  });
}

export async function getProviderByMemberId(memberId: string): Promise<Provider | null> {
  return withConnectDb(async (db) => {
    const rows = await db.select().from(providers).where(eq(providers.memberId, memberId)).limit(1);
    return rows[0] ? providerFromRow(rows[0]) : null;
  });
}

export async function getProviderByConnectAccountId(accountId: string): Promise<Provider | null> {
  return withConnectDb(async (db) => {
    const rows = await db.select().from(providers).where(eq(providers.stripeConnectAccountId, accountId)).limit(1);
    return rows[0] ? providerFromRow(rows[0]) : null;
  });
}

export async function upsertProviderRow(provider: Provider): Promise<Provider | null> {
  return withConnectDb(async (db) => {
    const now = new Date().toISOString();
    const existing = await db.select().from(providers).where(eq(providers.id, provider.id)).limit(1);
    const record = {
      id: provider.id,
      name: provider.name,
      email: provider.email ?? null,
      memberId: provider.memberId ?? null,
      status: provider.status,
      commissionRate: provider.commissionRate,
      stripeConnectAccountId: provider.stripeConnectAccountId ?? null,
      connectStatus: provider.connectStatus,
      chargesEnabled: provider.chargesEnabled ? 1 : 0,
      payoutsEnabled: provider.payoutsEnabled ? 1 : 0,
      detailsSubmitted: provider.detailsSubmitted ? 1 : 0,
      createdAt: existing[0]?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing[0]) {
      await db.update(providers).set(record).where(eq(providers.id, provider.id));
    } else {
      await db.insert(providers).values(record);
    }
    return providerFromRow(record);
  });
}

export async function getPayoutByBookingId(bookingId: string): Promise<ProviderPayout | null> {
  return withConnectDb(async (db) => {
    const rows = await db.select().from(providerPayouts).where(eq(providerPayouts.bookingId, bookingId)).limit(1);
    return rows[0] ? payoutFromRow(rows[0]) : null;
  });
}

export async function getPayoutByTransferId(transferId: string): Promise<ProviderPayout | null> {
  return withConnectDb(async (db) => {
    const rows = await db.select().from(providerPayouts).where(eq(providerPayouts.stripeTransferId, transferId)).limit(1);
    return rows[0] ? payoutFromRow(rows[0]) : null;
  });
}

export async function listPayoutsForProvider(providerId: string): Promise<ProviderPayout[] | null> {
  return withConnectDb(async (db) => {
    const rows = await db
      .select()
      .from(providerPayouts)
      .where(eq(providerPayouts.providerId, providerId))
      .orderBy(desc(providerPayouts.createdAt));
    return rows.map(payoutFromRow);
  });
}

export async function upsertPayoutRow(payout: ProviderPayout): Promise<ProviderPayout | null> {
  return withConnectDb(async (db) => {
    const now = new Date().toISOString();
    const existing = await db.select().from(providerPayouts).where(eq(providerPayouts.bookingId, payout.bookingId)).limit(1);
    const record = {
      id: existing[0]?.id ?? payout.id,
      bookingId: payout.bookingId,
      providerId: payout.providerId,
      grossAmount: payout.grossAmount,
      commissionAmount: payout.commissionAmount,
      netPayout: payout.netPayout,
      status: payout.status,
      stripeTransferId: payout.stripeTransferId ?? null,
      createdAt: existing[0]?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing[0]) {
      await db.update(providerPayouts).set(record).where(eq(providerPayouts.id, existing[0].id));
    } else {
      await db.insert(providerPayouts).values(record);
    }
    return payoutFromRow(record);
  });
}

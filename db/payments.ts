import {desc, eq, sql} from "drizzle-orm";
import type {CreditTransaction, Wallet} from "../domain/types";
import {getDb} from "./index";
import {creditTransactions, stripeEvents, wallets} from "./schema";

export type WalletRow = {
  wallet: Wallet & {memberId: string};
  transactions: CreditTransaction[];
};

function walletFromRow(row: typeof wallets.$inferSelect): Wallet & {memberId: string} {
  return {
    id: row.id,
    householdId: row.householdId,
    memberId: row.memberId,
    availableCredits: row.availableCredits,
  };
}

function transactionFromRow(row: typeof creditTransactions.$inferSelect): CreditTransaction {
  return {
    id: row.id,
    walletId: row.walletId,
    kind: row.kind as CreditTransaction["kind"],
    credits: row.credits,
    createdAt: row.createdAt,
    bookingId: row.bookingId ?? undefined,
    label: row.label,
    stripeEventId: row.stripeEventId ?? undefined,
    stripeObjectId: row.stripeObjectId ?? undefined,
  };
}

export async function withPaymentsDb<T>(fn: (db: ReturnType<typeof getDb>) => Promise<T>): Promise<T | null> {
  try {
    return await fn(getDb());
  } catch {
    return null;
  }
}

export async function ensurePaymentsSchema(): Promise<boolean> {
  return Boolean(await withPaymentsDb(async (db) => {
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS wallets (
      id text PRIMARY KEY NOT NULL,
      household_id text NOT NULL,
      member_id text NOT NULL,
      available_credits integer DEFAULT 0 NOT NULL,
      updated_at text NOT NULL
    )`));
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS credit_transactions (
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
    await db.run(sql.raw(`CREATE TABLE IF NOT EXISTS stripe_events (
      id text PRIMARY KEY NOT NULL,
      type text NOT NULL,
      processed_at text NOT NULL
    )`));
    for (const column of ["stripe_customer_id", "stripe_subscription_id", "membership_status"]) {
      try {
        await db.run(sql.raw(`ALTER TABLE members ADD COLUMN ${column} text`));
      } catch {
        // Column already exists after the first deploy.
      }
    }
    return true;
  }));
}

export async function getWalletForMember(memberId: string): Promise<WalletRow | null> {
  return withPaymentsDb(async (db) => {
    const rows = await db.select().from(wallets).where(eq(wallets.memberId, memberId)).limit(1);
    const row = rows[0];
    if (!row) return {wallet: {id: `wallet_${memberId}`, householdId: `hh_${memberId}`, memberId, availableCredits: 0}, transactions: []};
    const ledger = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.walletId, row.id))
      .orderBy(desc(creditTransactions.createdAt));
    return {wallet: walletFromRow(row), transactions: ledger.map(transactionFromRow)};
  });
}

export async function upsertWalletCredits(input: {
  walletId: string;
  householdId: string;
  memberId: string;
  availableCredits: number;
}): Promise<Wallet | null> {
  return withPaymentsDb(async (db) => {
    const now = new Date().toISOString();
    const existing = await db.select().from(wallets).where(eq(wallets.id, input.walletId)).limit(1);
    const record = {
      id: input.walletId,
      householdId: input.householdId,
      memberId: input.memberId,
      availableCredits: input.availableCredits,
      updatedAt: now,
    };
    if (existing[0]) {
      await db.update(wallets).set(record).where(eq(wallets.id, input.walletId));
    } else {
      await db.insert(wallets).values(record);
    }
    return walletFromRow(record);
  });
}

export async function insertCreditTransaction(tx: CreditTransaction & {label: string}): Promise<boolean> {
  return Boolean(await withPaymentsDb(async (db) => {
    await db.insert(creditTransactions).values({
      id: tx.id,
      walletId: tx.walletId,
      kind: tx.kind,
      credits: tx.credits,
      label: tx.label,
      createdAt: tx.createdAt,
      bookingId: tx.bookingId ?? null,
      stripeEventId: tx.stripeEventId ?? null,
      stripeObjectId: tx.stripeObjectId ?? null,
    });
    return true;
  }));
}

export async function hasStripeEvent(eventId: string): Promise<boolean | null> {
  return withPaymentsDb(async (db) => {
    const rows = await db.select().from(stripeEvents).where(eq(stripeEvents.id, eventId)).limit(1);
    return Boolean(rows[0]);
  });
}

export async function recordStripeEvent(eventId: string, type: string): Promise<boolean> {
  return Boolean(await withPaymentsDb(async (db) => {
    await db.insert(stripeEvents).values({
      id: eventId,
      type,
      processedAt: new Date().toISOString(),
    });
    return true;
  }));
}

export async function hasObjectTransaction(stripeObjectId: string, kind: CreditTransaction["kind"]): Promise<boolean | null> {
  return withPaymentsDb(async (db) => {
    const rows = await db
      .select()
      .from(creditTransactions)
      .where(eq(creditTransactions.stripeObjectId, stripeObjectId));
    return rows.some((row) => row.kind === kind);
  });
}

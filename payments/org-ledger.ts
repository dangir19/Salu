import {InsufficientCreditsError} from "./ledger";

export type OrgWallet = {id: string; orgId: string; availableCredits: number};

export type OrgTransactionKind = "topup" | "booking" | "refund" | "adjustment";

export type OrgCreditTransaction = {
  id: string;
  walletId: string;
  kind: OrgTransactionKind;
  credits: number;
  label: string;
  createdAt: string;
  bookingId?: string;
  stripeEventId?: string;
  stripeObjectId?: string;
};

export type OrgBillingSnapshot = {
  wallet: OrgWallet;
  transactions: OrgCreditTransaction[];
};

type MemoryOrgWallet = {
  wallet: OrgWallet;
  transactions: OrgCreditTransaction[];
};

const wallets = new Map<string, MemoryOrgWallet>();
const processedEvents = new Set<string>();
const processedObjects = new Set<string>();

export function resetOrgLedgerMemory(): void {
  wallets.clear();
  processedEvents.clear();
  processedObjects.clear();
}

export function walletIdForOrg(orgId: string): string {
  return `ow_${orgId}`;
}

function emptyWallet(orgId: string): OrgWallet {
  return {id: walletIdForOrg(orgId), orgId, availableCredits: 0};
}

function memoryState(orgId: string): MemoryOrgWallet {
  const id = walletIdForOrg(orgId);
  const current = wallets.get(id) ?? {wallet: emptyWallet(orgId), transactions: []};
  wallets.set(id, current);
  return current;
}

function toRow(tx: OrgCreditTransaction) {
  return {
    id: tx.id,
    walletId: tx.walletId,
    kind: tx.kind,
    credits: tx.credits,
    label: tx.label,
    createdAt: tx.createdAt,
    bookingId: tx.bookingId ?? null,
    stripeEventId: tx.stripeEventId ?? null,
    stripeObjectId: tx.stripeObjectId ?? null,
  };
}

function fromRow(row: {
  id: string;
  walletId: string;
  kind: string;
  credits: number;
  label: string;
  createdAt: string;
  bookingId?: string | null;
  stripeEventId?: string | null;
  stripeObjectId?: string | null;
}): OrgCreditTransaction {
  return {
    id: row.id,
    walletId: row.walletId,
    kind: row.kind as OrgTransactionKind,
    credits: row.credits,
    label: row.label,
    createdAt: row.createdAt,
    bookingId: row.bookingId ?? undefined,
    stripeEventId: row.stripeEventId ?? undefined,
    stripeObjectId: row.stripeObjectId ?? undefined,
  };
}

async function persistWallet(orgId: string, state: MemoryOrgWallet): Promise<void> {
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    await db.upsertOrgWallet(orgId, state.wallet.availableCredits);
  } catch {
    // D1 is optional until the business migration is applied.
  }
}

export async function getOrgBilling(orgId: string): Promise<OrgBillingSnapshot> {
  try {
    const db = await import("../db/orgs");
    await db.ensureOrgsSchema();
    const stored = await db.getOrgWallet(orgId);
    if (stored) {
      const transactions = (await db.listOrgTransactions(stored.id)) ?? [];
      const state: MemoryOrgWallet = {
        wallet: {id: stored.id, orgId, availableCredits: stored.availableCredits},
        transactions: transactions.map(fromRow),
      };
      wallets.set(state.wallet.id, state);
      return {wallet: state.wallet, transactions: state.transactions};
    }
  } catch {
    // Fall through to memory.
  }
  const state = memoryState(orgId);
  return {wallet: state.wallet, transactions: state.transactions};
}

export async function claimOrgStripeEvent(eventId: string, type: string): Promise<boolean> {
  if (!eventId) return false;
  if (processedEvents.has(eventId)) return false;
  try {
    const db = await import("../db/payments");
    await db.ensurePaymentsSchema();
    const seen = await db.hasStripeEvent(eventId);
    if (seen) {
      processedEvents.add(eventId);
      return false;
    }
    const recorded = await db.recordStripeEvent(eventId, type);
    if (recorded) {
      processedEvents.add(eventId);
      return true;
    }
  } catch {
    // Memory fallback.
  }
  processedEvents.add(eventId);
  return true;
}

export async function hasOrgLedgerObject(objectId: string, kind: OrgTransactionKind): Promise<boolean> {
  if (!objectId) return false;
  if (processedObjects.has(`${kind}:${objectId}`)) return true;
  try {
    const db = await import("../db/orgs");
    const seen = await db.hasOrgObjectTransaction(objectId, kind);
    if (seen) {
      processedObjects.add(`${kind}:${objectId}`);
      return true;
    }
  } catch {
    // Memory fallback.
  }
  return false;
}

export async function applyOrgCreditEntry(input: {
  orgId: string;
  credits: number;
  kind: OrgTransactionKind;
  label: string;
  bookingId?: string;
  stripeEventId?: string;
  stripeObjectId?: string;
}): Promise<OrgCreditTransaction | null> {
  if (!input.credits) return null;
  if (input.stripeObjectId && await hasOrgLedgerObject(input.stripeObjectId, input.kind)) {
    return null;
  }

  const snapshot = await getOrgBilling(input.orgId);
  const state = memoryState(input.orgId);
  state.wallet = {
    ...snapshot.wallet,
    availableCredits: snapshot.wallet.availableCredits + input.credits,
  };
  const transaction: OrgCreditTransaction = {
    id: `otx_${input.stripeEventId ?? input.stripeObjectId ?? crypto.randomUUID()}`,
    walletId: state.wallet.id,
    kind: input.kind,
    credits: input.credits,
    createdAt: new Date().toISOString(),
    label: input.label,
    bookingId: input.bookingId,
    stripeEventId: input.stripeEventId,
    stripeObjectId: input.stripeObjectId,
  };
  state.transactions = [transaction, ...snapshot.transactions];
  wallets.set(state.wallet.id, state);
  if (input.stripeObjectId) processedObjects.add(`${input.kind}:${input.stripeObjectId}`);

  try {
    const db = await import("../db/orgs");
    await persistWallet(input.orgId, state);
    await db.insertOrgTransaction(toRow(transaction));
  } catch {
    // Memory remains the source of truth when D1 is unavailable.
  }

  return transaction;
}

export async function spendOrgBookingCredits(input: {
  orgId: string;
  credits: number;
  bookingId: string;
  label: string;
  enforce: boolean;
}): Promise<{transaction: OrgCreditTransaction | null; availableCredits: number; applied: boolean}> {
  const snapshot = await getOrgBilling(input.orgId);
  if (input.credits <= 0) {
    return {transaction: null, availableCredits: snapshot.wallet.availableCredits, applied: false};
  }
  if (snapshot.transactions.some((row) => row.bookingId === input.bookingId && row.kind === "booking")) {
    return {transaction: null, availableCredits: snapshot.wallet.availableCredits, applied: false};
  }
  if (snapshot.wallet.availableCredits < input.credits) {
    if (input.enforce) {
      throw new InsufficientCreditsError(input.credits, snapshot.wallet.availableCredits);
    }
    return {transaction: null, availableCredits: snapshot.wallet.availableCredits, applied: false};
  }
  const transaction = await applyOrgCreditEntry({
    orgId: input.orgId,
    credits: -input.credits,
    kind: "booking",
    label: input.label,
    bookingId: input.bookingId,
  });
  const after = await getOrgBilling(input.orgId);
  return {transaction, availableCredits: after.wallet.availableCredits, applied: Boolean(transaction)};
}

export async function restoreOrgBookingCredits(input: {
  orgId: string;
  credits: number;
  bookingId: string;
  label: string;
}): Promise<{transaction: OrgCreditTransaction | null; availableCredits: number; applied: boolean}> {
  const snapshot = await getOrgBilling(input.orgId);
  if (input.credits <= 0) {
    return {transaction: null, availableCredits: snapshot.wallet.availableCredits, applied: false};
  }
  if (snapshot.transactions.some((row) => row.bookingId === input.bookingId && row.kind === "refund")) {
    return {transaction: null, availableCredits: snapshot.wallet.availableCredits, applied: false};
  }
  const transaction = await applyOrgCreditEntry({
    orgId: input.orgId,
    credits: input.credits,
    kind: "refund",
    label: input.label,
    bookingId: input.bookingId,
  });
  const after = await getOrgBilling(input.orgId);
  return {transaction, availableCredits: after.wallet.availableCredits, applied: Boolean(transaction)};
}

import {findMemberRecord, updateMemberBilling, upsertMemberRecord} from "../auth/members";
import type {CreditTransaction, Member, MembershipStatus, Wallet} from "../domain/types";
import {planNameFromId, type PlanId} from "./catalog";

export type LedgerWallet = Wallet & {memberId: string};

export type MemberBillingSnapshot = {
  member: Member;
  wallet: LedgerWallet;
  transactions: CreditTransaction[];
};

type MemoryWallet = {
  wallet: LedgerWallet;
  transactions: CreditTransaction[];
};

const wallets = new Map<string, MemoryWallet>();
const processedEvents = new Set<string>();
const processedObjects = new Set<string>();

export function resetPaymentMemory(): void {
  wallets.clear();
  processedEvents.clear();
  processedObjects.clear();
}

export function walletIdForMember(member: Pick<Member, "id" | "householdId">): string {
  return `wallet_${member.householdId ?? member.id}`;
}

function emptyWallet(member: Pick<Member, "id" | "householdId">): LedgerWallet {
  return {
    id: walletIdForMember(member),
    householdId: member.householdId ?? `hh_${member.id}`,
    memberId: member.id,
    availableCredits: 0,
  };
}

function memoryState(member: Pick<Member, "id" | "householdId">): MemoryWallet {
  const id = walletIdForMember(member);
  const current = wallets.get(id) ?? {wallet: emptyWallet(member), transactions: []};
  wallets.set(id, current);
  return current;
}

async function persistWallet(state: MemoryWallet): Promise<void> {
  try {
    const db = await import("../db/payments");
    await db.ensurePaymentsSchema();
    await db.upsertWalletCredits({
      walletId: state.wallet.id,
      householdId: state.wallet.householdId,
      memberId: state.wallet.memberId,
      availableCredits: state.wallet.availableCredits,
    });
  } catch {
    // D1 is optional until the payments migration is applied.
  }
}

export async function getMemberBilling(member: Member): Promise<MemberBillingSnapshot> {
  const latest = await findMemberRecord({
    id: member.id,
    email: member.email,
    stripeCustomerId: member.stripeCustomerId,
  }) ?? member;
  try {
    const db = await import("../db/payments");
    await db.ensurePaymentsSchema();
    const stored = await db.getWalletForMember(latest.id);
    if (stored) {
      const state: MemoryWallet = {
        wallet: {
          ...stored.wallet,
          householdId: stored.wallet.householdId || latest.householdId || `hh_${latest.id}`,
          memberId: latest.id,
        },
        transactions: stored.transactions,
      };
      wallets.set(state.wallet.id, state);
      return {member: latest, wallet: state.wallet, transactions: state.transactions};
    }
  } catch {
    // Fall through to memory.
  }
  const state = memoryState(latest);
  return {member: latest, wallet: state.wallet, transactions: state.transactions};
}

export async function claimStripeEvent(eventId: string, type: string): Promise<boolean> {
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

export async function hasLedgerObject(objectId: string, kind: CreditTransaction["kind"]): Promise<boolean> {
  if (!objectId) return false;
  if (processedObjects.has(`${kind}:${objectId}`)) return true;
  try {
    const db = await import("../db/payments");
    const seen = await db.hasObjectTransaction(objectId, kind);
    if (seen) {
      processedObjects.add(`${kind}:${objectId}`);
      return true;
    }
  } catch {
    // Memory fallback.
  }
  return false;
}

export async function applyCreditEntry(input: {
  member: Member;
  credits: number;
  kind: CreditTransaction["kind"];
  label: string;
  stripeEventId?: string;
  stripeObjectId?: string;
  bookingId?: string;
}): Promise<CreditTransaction | null> {
  if (!input.credits) return null;
  if (input.stripeObjectId && await hasLedgerObject(input.stripeObjectId, input.kind)) {
    return null;
  }

  const snapshot = await getMemberBilling(input.member);
  const state = memoryState(input.member);
  state.wallet = {
    ...snapshot.wallet,
    availableCredits: snapshot.wallet.availableCredits + input.credits,
  };
  const transaction: CreditTransaction = {
    id: `tx_${input.stripeEventId ?? input.stripeObjectId ?? crypto.randomUUID()}`,
    walletId: state.wallet.id,
    kind: input.kind,
    credits: input.credits,
    createdAt: new Date().toISOString(),
    label: input.label,
    stripeEventId: input.stripeEventId,
    stripeObjectId: input.stripeObjectId,
    bookingId: input.bookingId,
  };
  state.transactions = [transaction, ...snapshot.transactions];
  wallets.set(state.wallet.id, state);
  if (input.stripeObjectId) processedObjects.add(`${input.kind}:${input.stripeObjectId}`);

  try {
    const db = await import("../db/payments");
    await persistWallet(state);
    await db.insertCreditTransaction({...transaction, label: input.label});
  } catch {
    // Memory remains the source of truth when D1 is unavailable.
  }

  return transaction;
}

export async function rememberMember(member: Member): Promise<Member> {
  return upsertMemberRecord(member);
}

export async function resolveMember(input: {
  memberId?: string | null;
  email?: string | null;
  stripeCustomerId?: string | null;
}): Promise<Member | null> {
  return findMemberRecord({
    id: input.memberId,
    email: input.email,
    stripeCustomerId: input.stripeCustomerId,
  });
}

export async function setMemberMembership(input: {
  member: Member;
  planId: PlanId;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string | null;
  membershipStatus?: MembershipStatus;
}): Promise<Member> {
  const updated = await updateMemberBilling(input.member.id, {
    planId: input.planId,
    stripeCustomerId: input.stripeCustomerId ?? input.member.stripeCustomerId,
    stripeSubscriptionId: input.stripeSubscriptionId === null ? "" : (input.stripeSubscriptionId ?? input.member.stripeSubscriptionId),
    membershipStatus: input.membershipStatus ?? input.member.membershipStatus,
  });
  return updated ?? {
    ...input.member,
    planId: input.planId,
    stripeCustomerId: input.stripeCustomerId ?? input.member.stripeCustomerId,
    stripeSubscriptionId: input.stripeSubscriptionId ?? input.member.stripeSubscriptionId,
    membershipStatus: input.membershipStatus ?? input.member.membershipStatus,
  };
}

export function membershipLabel(planId: PlanId, kind: "contribution" | "topup" | "refund"): string {
  if (kind === "topup") return "One-time Credit purchase";
  if (kind === "refund") return "Stripe refund · Credits returned";
  return `Salu ${planNameFromId(planId)} monthly contribution`;
}

export class InsufficientCreditsError extends Error {
  needed: number;
  available: number;
  constructor(needed: number, available: number) {
    super(`You need ${needed - available} more Credits to confirm.`);
    this.name = "InsufficientCreditsError";
    this.needed = needed;
    this.available = available;
  }
}

export async function spendBookingCredits(input: {
  member: Member;
  credits: number;
  bookingId: string;
  label: string;
  enforce: boolean;
}): Promise<{transaction: CreditTransaction | null; availableCredits: number; applied: boolean}> {
  const snapshot = await getMemberBilling(input.member);
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
  const transaction = await applyCreditEntry({
    member: input.member,
    credits: -input.credits,
    kind: "booking",
    label: input.label,
    bookingId: input.bookingId,
  });
  const after = await getMemberBilling(input.member);
  return {transaction, availableCredits: after.wallet.availableCredits, applied: Boolean(transaction)};
}

export async function restoreBookingCredits(input: {
  member: Member;
  credits: number;
  bookingId: string;
  label: string;
}): Promise<{transaction: CreditTransaction | null; availableCredits: number; applied: boolean}> {
  const snapshot = await getMemberBilling(input.member);
  if (input.credits <= 0) {
    return {transaction: null, availableCredits: snapshot.wallet.availableCredits, applied: false};
  }
  if (snapshot.transactions.some((row) => row.bookingId === input.bookingId && row.kind === "refund")) {
    return {transaction: null, availableCredits: snapshot.wallet.availableCredits, applied: false};
  }
  const transaction = await applyCreditEntry({
    member: input.member,
    credits: input.credits,
    kind: "refund",
    label: input.label,
    bookingId: input.bookingId,
  });
  const after = await getMemberBilling(input.member);
  return {transaction, availableCredits: after.wallet.availableCredits, applied: Boolean(transaction)};
}

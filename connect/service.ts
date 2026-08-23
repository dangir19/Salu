import type {Booking, ConnectStatus, Member, Provider, ProviderPayout} from "../domain/types";
import {isStripeReady, type StripeEnv} from "../payments/env";
import {
  createAccountLink,
  createAccountLoginLink,
  createConnectAccount,
  createTransfer,
  retrieveConnectAccount,
  type StripeAccount,
  type StripeTransfer,
} from "../payments/stripe";
import {bookingGrossCredits, catalogPractices, creditsToUsdCents, DEFAULT_COMMISSION_RATE, findCatalogPractice, splitMarketplaceAmount} from "./catalog";
import {connectStatusFromAccount, isPayoutsEnabled} from "./status";

export class ConnectError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ConnectError";
    this.status = status;
  }
}

export type TransferFn = (secret: string, input: {
  amountCents: number;
  destination: string;
  bookingId: string;
  providerId: string;
  commissionAmount: number;
}) => Promise<StripeTransfer>;

type MemoryState = {
  providers: Map<string, Provider>;
  payouts: Map<string, ProviderPayout>;
};

const memory: MemoryState = {
  providers: new Map(),
  payouts: new Map(),
};

export function resetConnectMemory(): void {
  memory.providers.clear();
  memory.payouts.clear();
}

function approvedProvider(practice: {id: string; name: string; commissionRate: number}): Provider {
  return {
    id: practice.id,
    name: practice.name,
    status: "approved",
    commissionRate: practice.commissionRate,
    connectStatus: "not_connected",
  };
}

async function persistProvider(provider: Provider): Promise<Provider> {
  memory.providers.set(provider.id, provider);
  try {
    const db = await import("../db/connect");
    await db.ensureConnectSchema();
    await db.upsertProviderRow(provider);
  } catch {
    // D1 is optional until the Connect migration is applied.
  }
  return provider;
}

async function persistPayout(payout: ProviderPayout): Promise<ProviderPayout> {
  memory.payouts.set(payout.bookingId, payout);
  try {
    const db = await import("../db/connect");
    await db.ensureConnectSchema();
    await db.upsertPayoutRow(payout);
  } catch {
    // Memory remains the source of truth when D1 is unavailable.
  }
  return payout;
}

async function hydrateProviders(): Promise<void> {
  try {
    const db = await import("../db/connect");
    await db.ensureConnectSchema();
    const rows = await db.listProviderRows();
    if (rows) {
      for (const row of rows) memory.providers.set(row.id, row);
    }
  } catch {
    // Memory fallback.
  }
  for (const practice of catalogPractices()) {
    if (!memory.providers.has(practice.id)) {
      memory.providers.set(practice.id, approvedProvider(practice));
    }
  }
}

async function storedProvider(id: string): Promise<Provider | null> {
  await hydrateProviders();
  if (memory.providers.has(id)) return memory.providers.get(id) ?? null;
  try {
    const db = await import("../db/connect");
    const row = await db.getProviderById(id);
    if (row) {
      memory.providers.set(row.id, row);
      return row;
    }
  } catch {
    // Fall through.
  }
  return null;
}

export async function listProviders(): Promise<Provider[]> {
  await hydrateProviders();
  return [...memory.providers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function findProvider(input: {
  id?: string | null;
  memberId?: string | null;
  name?: string | null;
  accountId?: string | null;
}): Promise<Provider | null> {
  await hydrateProviders();
  if (input.id) {
    const byId = await storedProvider(input.id);
    if (byId) return byId;
  }
  if (input.memberId) {
    const byMember = [...memory.providers.values()].find((row) => row.memberId === input.memberId);
    if (byMember) return byMember;
    try {
      const db = await import("../db/connect");
      const row = await db.getProviderByMemberId(input.memberId);
      if (row) {
        memory.providers.set(row.id, row);
        return row;
      }
    } catch {
      // Fall through.
    }
  }
  if (input.accountId) {
    const byAccount = [...memory.providers.values()].find((row) => row.stripeConnectAccountId === input.accountId);
    if (byAccount) return byAccount;
    try {
      const db = await import("../db/connect");
      const row = await db.getProviderByConnectAccountId(input.accountId);
      if (row) {
        memory.providers.set(row.id, row);
        return row;
      }
    } catch {
      // Fall through.
    }
  }
  if (input.name) {
    const practice = findCatalogPractice(input.name);
    if (practice) return storedProvider(practice.id);
    return [...memory.providers.values()].find((row) => row.name === input.name) ?? null;
  }
  return null;
}

export async function claimProvider(input: {
  member: Member;
  providerId: string;
  practiceName?: string;
}): Promise<Provider> {
  const practice = findCatalogPractice(input.providerId)
    ?? (input.practiceName
      ? {id: input.providerId, name: input.practiceName, commissionRate: DEFAULT_COMMISSION_RATE}
      : null);
  if (!practice) throw new ConnectError("That practice is not on the Salu menu.");
  const existingForMember = await findProvider({memberId: input.member.id});
  if (existingForMember && existingForMember.id !== practice.id) {
    throw new ConnectError("This account already claimed another practice.");
  }
  const provider = await storedProvider(practice.id) ?? approvedProvider(practice);
  if (provider.memberId && provider.memberId !== input.member.id) {
    throw new ConnectError("That practice is already claimed.", 409);
  }
  if (provider.status !== "approved") {
    throw new ConnectError("Only approved providers can set up payouts.", 403);
  }
  return persistProvider({
    ...provider,
    name: practice.name,
    email: input.member.email,
    memberId: input.member.id,
    status: "approved",
  });
}

export async function applyAccountToProvider(provider: Provider, account: StripeAccount): Promise<Provider> {
  const connectStatus = connectStatusFromAccount(account);
  return persistProvider({
    ...provider,
    stripeConnectAccountId: account.id,
    connectStatus,
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    email: provider.email || account.email || undefined,
  });
}

export async function syncProviderFromAccount(input: {
  account: StripeAccount;
  providerId?: string | null;
}): Promise<Provider | null> {
  const provider = await findProvider({
    accountId: input.account.id,
    id: input.providerId || input.account.metadata?.providerId,
  });
  if (!provider) return null;
  return applyAccountToProvider(provider, input.account);
}

export async function startConnectOnboarding(input: {
  member: Member;
  providerId?: string;
  practiceName?: string;
  origin: string;
  env: StripeEnv;
}): Promise<{url: string | null; demo: boolean; provider: Provider; status: ConnectStatus}> {
  const providerId = input.providerId || (await findProvider({memberId: input.member.id}))?.id;
  if (!providerId) throw new ConnectError("Choose a practice before setting up payouts.");
  const provider = await claimProvider({
    member: input.member,
    providerId,
    practiceName: input.practiceName,
  });
  if (!isStripeReady(input.env)) {
    return {url: null, demo: true, provider, status: provider.connectStatus};
  }

  let accountId = provider.stripeConnectAccountId;
  if (!accountId) {
    const account = await createConnectAccount(input.env.STRIPE_SECRET_KEY, {
      email: input.member.email,
      name: provider.name,
      providerId: provider.id,
      memberId: input.member.id,
    });
    const stored = await applyAccountToProvider(provider, account);
    accountId = stored.stripeConnectAccountId;
  }
  if (!accountId) throw new ConnectError("Stripe could not create a connected account.");

  const latest = await storedProvider(provider.id) ?? provider;
  if (latest.connectStatus === "not_connected") {
    await persistProvider({...latest, stripeConnectAccountId: accountId, connectStatus: "pending"});
  }

  const link = await createAccountLink(input.env.STRIPE_SECRET_KEY, {
    account: accountId,
    refreshUrl: `${input.origin}/provider?connect=refresh`,
    returnUrl: `${input.origin}/provider?connect=return`,
  });
  const ready = await storedProvider(provider.id) ?? latest;
  return {url: link.url, demo: false, provider: ready, status: ready.connectStatus};
}

export async function startConnectDashboard(input: {
  member: Member;
  env: StripeEnv;
}): Promise<{url: string | null; demo: boolean; provider: Provider | null}> {
  const provider = await findProvider({memberId: input.member.id});
  if (!provider) throw new ConnectError("Claim a practice before opening payouts.", 404);
  if (!isStripeReady(input.env)) {
    return {url: null, demo: true, provider};
  }
  if (!provider.stripeConnectAccountId) {
    throw new ConnectError("Set up payouts before opening the Stripe dashboard.");
  }
  const link = await createAccountLoginLink(input.env.STRIPE_SECRET_KEY, provider.stripeConnectAccountId);
  return {url: link.url, demo: false, provider};
}

export async function refreshProviderAccount(input: {
  provider: Provider;
  env: StripeEnv;
}): Promise<Provider> {
  if (!isStripeReady(input.env) || !input.provider.stripeConnectAccountId) return input.provider;
  try {
    const account = await retrieveConnectAccount(input.env.STRIPE_SECRET_KEY, input.provider.stripeConnectAccountId);
    return applyAccountToProvider(input.provider, account);
  } catch {
    return input.provider;
  }
}

export async function listProviderPayouts(providerId: string): Promise<ProviderPayout[]> {
  try {
    const db = await import("../db/connect");
    await db.ensureConnectSchema();
    const rows = await db.listPayoutsForProvider(providerId);
    if (rows) {
      for (const row of rows) memory.payouts.set(row.bookingId, row);
      return rows;
    }
  } catch {
    // Memory fallback.
  }
  return [...memory.payouts.values()].filter((row) => row.providerId === providerId);
}

export async function getPayoutForBooking(bookingId: string): Promise<ProviderPayout | null> {
  if (memory.payouts.has(bookingId)) return memory.payouts.get(bookingId) ?? null;
  try {
    const db = await import("../db/connect");
    const row = await db.getPayoutByBookingId(bookingId);
    if (row) {
      memory.payouts.set(row.bookingId, row);
      return row;
    }
  } catch {
    // Fall through.
  }
  return null;
}

export async function applyTransferToPayout(input: {
  transfer: StripeTransfer;
  status?: ProviderPayout["status"];
}): Promise<ProviderPayout | null> {
  const bookingId = input.transfer.metadata?.bookingId;
  const existing = bookingId
    ? await getPayoutForBooking(bookingId)
    : input.transfer.id
      ? [...memory.payouts.values()].find((row) => row.stripeTransferId === input.transfer.id) ?? null
      : null;
  if (!existing) {
    if (input.transfer.id) {
      try {
        const db = await import("../db/connect");
        const row = await db.getPayoutByTransferId(input.transfer.id);
        if (row) return persistPayout({...row, status: input.status ?? row.status, stripeTransferId: input.transfer.id});
      } catch {
        return null;
      }
    }
    return null;
  }
  const status = input.status
    ?? (input.transfer.reversed ? "failed" : "paid");
  return persistPayout({
    ...existing,
    status,
    stripeTransferId: input.transfer.id || existing.stripeTransferId,
  });
}

export async function settleBookingPayout(input: {
  booking: Booking;
  env?: StripeEnv;
  createTransfer?: TransferFn;
}): Promise<ProviderPayout | null> {
  const existing = await getPayoutForBooking(input.booking.id);
  if (existing && (existing.status === "paid" || existing.status === "scheduled")) {
    return existing;
  }

  const practice = findCatalogPractice(input.booking.provider) ?? findCatalogPractice(input.booking.serviceId);
  const provider = await findProvider({
    name: input.booking.provider,
    id: practice?.id,
  }) ?? (practice ? await persistProvider(approvedProvider(practice)) : null);
  if (!provider) return null;

  const split = splitMarketplaceAmount({
    grossCredits: bookingGrossCredits(input.booking),
    commissionRate: provider.commissionRate,
  });
  if (!split.grossAmount) return existing;

  const payout: ProviderPayout = existing ?? {
    id: `po_${input.booking.id}`,
    bookingId: input.booking.id,
    providerId: provider.id,
    grossAmount: split.grossAmount,
    commissionAmount: split.commissionAmount,
    netPayout: split.netPayout,
    status: "estimated",
  };
  payout.grossAmount = split.grossAmount;
  payout.commissionAmount = split.commissionAmount;
  payout.netPayout = split.netPayout;

  const env = input.env;
  const canTransfer = Boolean(
    env
    && isStripeReady(env)
    && isPayoutsEnabled(provider.connectStatus)
    && provider.stripeConnectAccountId
    && split.netPayout > 0,
  );

  if (!canTransfer || !env || !provider.stripeConnectAccountId) {
    return persistPayout({...payout, status: existing?.status === "failed" ? "failed" : "estimated"});
  }

  try {
    const transferFn = input.createTransfer ?? createTransfer;
    const transfer = await transferFn(env.STRIPE_SECRET_KEY, {
      amountCents: creditsToUsdCents(split.netPayout),
      destination: provider.stripeConnectAccountId,
      bookingId: input.booking.id,
      providerId: provider.id,
      commissionAmount: split.commissionAmount,
    });
    return persistPayout({
      ...payout,
      status: "paid",
      stripeTransferId: transfer.id,
    });
  } catch {
    return persistPayout({...payout, status: "failed"});
  }
}

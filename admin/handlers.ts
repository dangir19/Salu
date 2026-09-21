import {desc, eq} from "drizzle-orm";
import type {Booking, Member} from "../domain/types";
import {bookings as bookingsTable, members as membersTable, wallets as walletsTable} from "../db/schema";
import {authorizeAdmin} from "../providers/session";

type RuntimeEnv = Record<string, string | undefined>;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {status});
}

export class AdminError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AdminError";
    this.status = status;
  }
}

function errorResponse(error: unknown): Response {
  const status = error !== null && typeof error === "object" && "status" in error && typeof (error as {status?: unknown}).status === "number"
    ? (error as {status: number}).status
    : 400;
  const message = error instanceof Error ? error.message : "The admin request could not be completed.";
  return json({source: "server", error: message}, status);
}

export type AdminMemberRow = {
  id: string;
  email: string;
  displayName: string;
  planId: string;
  membershipStatus?: string;
  availableCredits: number;
  bookingCount: number;
};

export type AdminBookingRow = {
  id: string;
  member: {id: string; displayName: string; email: string};
  service: {id: string; name: string};
  provider: string;
  providerId?: string;
  date: string;
  startsAt?: string;
  status: string;
  creditsCharged: number;
  source?: string;
};

export type AdminOverview = {
  members: number;
  applications: Record<string, number>;
  bookings: Record<string, number>;
  creditsOutstanding: number;
  organizations: {total: number; pending: number; active: number};
};

export type AdminOrgRow = {
  id: string;
  name: string;
  orgType: string;
  contactName: string;
  contactEmail: string;
  status: string;
  memberCount: number;
  orderCount: number;
  creditsSpent: number;
  createdAt: string;
};

export const ADMIN_ORG_STATUSES = ["pending", "active", "suspended", "rejected"] as const;
export type AdminOrgStatus = (typeof ADMIN_ORG_STATUSES)[number];

function isAdminOrgStatus(value: unknown): value is AdminOrgStatus {
  return typeof value === "string" && (ADMIN_ORG_STATUSES as readonly string[]).includes(value);
}

export type AdminStore = {
  listMembers(): Promise<AdminMemberRow[] | null>;
  listBookings(): Promise<AdminBookingRow[] | null>;
  overview(): Promise<AdminOverview | null>;
  cancelBooking(id: string): Promise<{booking: AdminBookingRow; refunded: boolean; availableCredits: number} | null>;
  assignProvider(id: string, providerId: string): Promise<AdminBookingRow | null>;
  adjustCredits(memberId: string, credits: number, label: string): Promise<{memberId: string; availableCredits: number; transactionId: string} | null>;
  listOrgs(): Promise<AdminOrgRow[] | null>;
  approveOrg(id: string): Promise<AdminOrgRow | null>;
  setOrgStatus(id: string, status: AdminOrgStatus): Promise<AdminOrgRow | null>;
};

type D1 = Awaited<ReturnType<typeof getD1>>;

async function getD1() {
  const mod = await import("../db/index");
  return mod.getDb();
}

async function d1(): Promise<D1 | null> {
  try {
    return await getD1();
  } catch {
    return null;
  }
}

async function resolveMemberRecord(memberId: string): Promise<Member | null> {
  try {
    const ledger = await import("../payments/ledger");
    return ledger.resolveMember({memberId});
  } catch {
    return null;
  }
}

async function walletBalance(member: Member): Promise<number> {
  try {
    const ledger = await import("../payments/ledger");
    const snapshot = await ledger.getMemberBilling(member);
    return snapshot.wallet.availableCredits;
  } catch {
    return 0;
  }
}

function toBookingRow(booking: Booking, member: Member | null): AdminBookingRow {
  return {
    id: booking.id,
    member: {
      id: booking.memberId,
      displayName: member?.displayName ?? "Unknown member",
      email: member?.email ?? "",
    },
    service: {id: booking.serviceId, name: booking.serviceName},
    provider: booking.provider,
    date: booking.date,
    startsAt: booking.startsAt,
    status: booking.status,
    creditsCharged: booking.creditsCharged,
    source: booking.source ?? "web",
  };
}

async function providerNameFor(providerId: string): Promise<string | null> {
  try {
    const service = await import("../providers/service");
    const catalog = await service.listApprovedCatalog();
    return catalog.providers.find((provider) => provider.id === providerId)?.name ?? null;
  } catch {
    return null;
  }
}

type OrgLike = {
  id: string;
  name: string;
  orgType: string;
  contactName: string;
  contactEmail: string;
  status: string;
  createdAt: string;
};

type OrgBookingLike = {
  status?: string;
  creditsCharged?: number;
};

type OrgDbModule = {
  listOrganizations(): Promise<OrgLike[]>;
  listOrgMembers(orgId: string): Promise<unknown[]>;
  listBookingsForOrg(orgId: string): Promise<OrgBookingLike[]>;
  updateOrganizationStatus(id: string, status: string): Promise<OrgLike | null>;
};

async function loadOrgDb(): Promise<OrgDbModule | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: ../db/orgs is being built in parallel; this resolves once it lands.
    const mod = await import("../db/orgs");
    return mod as unknown as OrgDbModule;
  } catch {
    return null;
  }
}

async function toAdminOrgRow(org: OrgLike, orgDb: OrgDbModule | null): Promise<AdminOrgRow> {
  let memberCount = 0;
  let orderCount = 0;
  let creditsSpent = 0;
  if (orgDb) {
    try {
      const [members, bookings] = await Promise.all([
        orgDb.listOrgMembers(org.id).catch(() => [] as unknown[]),
        orgDb.listBookingsForOrg(org.id).catch(() => [] as OrgBookingLike[]),
      ]);
      memberCount = members.length;
      const billable = bookings.filter((booking) => booking.status !== "cancelled");
      orderCount = billable.length;
      creditsSpent = billable.reduce(
        (sum, booking) => sum + Math.max(0, Number(booking.creditsCharged ?? 0) || 0),
        0,
      );
    } catch {
      // Per-org enrichment failures fall back to zeros.
    }
  }
  return {
    id: org.id,
    name: org.name,
    orgType: org.orgType,
    contactName: org.contactName,
    contactEmail: org.contactEmail,
    status: org.status,
    memberCount,
    orderCount,
    creditsSpent,
    createdAt: org.createdAt,
  };
}

async function setOrgStatusInStore(orgDb: OrgDbModule, id: string, status: AdminOrgStatus): Promise<AdminOrgRow> {
  const updated = await orgDb.updateOrganizationStatus(id, status).catch(() => null);
  if (!updated) {
    throw new AdminError("That organization is not on file.", 404);
  }
  return toAdminOrgRow(updated, orgDb);
}

const defaultStore: AdminStore = {
  async listMembers(): Promise<AdminMemberRow[] | null> {
    const db = await d1();
    if (!db) return null;
    try {
      const rows = await db.select().from(membersTable).orderBy(desc(membersTable.createdAt));
      return Promise.all(rows.map(async (row) => {
        const member: Member = {
          id: row.id,
          email: row.email,
          displayName: row.displayName,
          planId: row.planId,
          createdAt: row.createdAt,
          membershipStatus: (row.membershipStatus as Member["membershipStatus"]) ?? undefined,
        };
        const [availableCredits, bookingRows] = await Promise.all([
          walletBalance(member),
          db.select({id: bookingsTable.id}).from(bookingsTable).where(eq(bookingsTable.memberId, row.id)).catch(() => []),
        ]);
        return {
          id: row.id,
          email: row.email,
          displayName: row.displayName,
          planId: row.planId,
          membershipStatus: row.membershipStatus ?? undefined,
          availableCredits,
          bookingCount: bookingRows.length,
        } satisfies AdminMemberRow;
      }));
    } catch {
      return null;
    }
  },

  async listBookings(): Promise<AdminBookingRow[] | null> {
    const db = await d1();
    if (!db) return null;
    try {
      const dbBookings = await import("../db/bookings");
      const rows = await dbBookings.withBookingsDb(async (inner) =>
        inner.select().from(bookingsTable).orderBy(desc(bookingsTable.createdAt)),
      );
      if (!rows) return null;
      return Promise.all(rows.map(async (row) => {
        const member = await resolveMemberRecord(row.memberId);
        return toBookingRow({
          id: row.id,
          memberId: row.memberId,
          serviceId: row.serviceId,
          serviceName: row.serviceName,
          provider: row.provider,
          date: row.date,
          startsAt: row.startsAt ?? undefined,
          mode: row.mode,
          status: row.status as Booking["status"],
          creditsCharged: row.creditsCharged,
          source: row.source ?? "web",
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }, member);
      }));
    } catch {
      return null;
    }
  },

  async overview(): Promise<AdminOverview | null> {
    const db = await d1();
    if (!db) return null;
    try {
      const [memberRows, walletRows, applications, bookings] = await Promise.all([
        db.select({id: membersTable.id}).from(membersTable).catch(() => []),
        db.select({availableCredits: walletsTable.availableCredits}).from(walletsTable).catch(() => []),
        import("../providers/service").then((mod) => mod.listApplications()).catch(() => []),
        this.listBookings().catch(() => null),
      ]);
      const applicationCounts: Record<string, number> = {};
      for (const application of applications) {
        applicationCounts[application.status] = (applicationCounts[application.status] ?? 0) + 1;
      }
      const bookingCounts: Record<string, number> = {};
      for (const booking of bookings ?? []) {
        bookingCounts[booking.status] = (bookingCounts[booking.status] ?? 0) + 1;
      }
      const creditsOutstanding = walletRows.reduce(
        (sum, row) => sum + Math.max(0, row.availableCredits ?? 0),
        0,
      );
      const orgDb = await loadOrgDb();
      const orgRows = orgDb ? await orgDb.listOrganizations().catch(() => [] as OrgLike[]) : [];
      return {
        members: memberRows.length,
        applications: applicationCounts,
        bookings: bookingCounts,
        creditsOutstanding,
        organizations: {
          total: orgRows.length,
          pending: orgRows.filter((org) => org.status === "pending").length,
          active: orgRows.filter((org) => org.status === "active").length,
        },
      };
    } catch {
      return null;
    }
  },

  async cancelBooking(id: string) {
    let booking: Booking | null = null;
    try {
      const dbBookings = await import("../db/bookings");
      booking = await dbBookings.getBookingById(id);
    } catch {
      booking = null;
    }
    if (!booking) return null;
    const member = await resolveMemberRecord(booking.memberId);
    if (!member) {
      throw new AdminError("The member for this booking is not on file.", 404);
    }
    try {
      const service = await import("../bookings/service");
      const result = await service.cancelMemberBooking({member, bookingId: id});
      return {
        booking: toBookingRow(result.booking, member),
        refunded: result.creditsApplied,
        availableCredits: result.availableCredits,
      };
    } catch (error) {
      throw error instanceof AdminError ? error : new AdminError(
        error instanceof Error ? error.message : "That booking could not be cancelled.",
        typeof (error as {status?: unknown})?.status === "number" ? (error as {status: number}).status : 400,
      );
    }
  },

  async assignProvider(id: string, providerId: string) {
    const db = await d1();
    if (!db) return null;
    let booking: Booking | null = null;
    try {
      const dbBookings = await import("../db/bookings");
      booking = await dbBookings.getBookingById(id);
    } catch {
      booking = null;
    }
    if (!booking) return null;
    if (booking.status === "cancelled" || booking.status === "completed") {
      throw new AdminError(`Only upcoming bookings can be reassigned (this one is ${booking.status}).`);
    }
    const providerName = await providerNameFor(providerId);
    try {
      await db
        .update(bookingsTable)
        .set({provider: providerName ?? providerId, providerId, updatedAt: new Date().toISOString()})
        .where(eq(bookingsTable.id, id));
    } catch {
      throw new AdminError("The provider could not be assigned.");
    }
    const member = await resolveMemberRecord(booking.memberId);
    return {...toBookingRow(booking, member), provider: providerName ?? providerId, providerId};
  },

  async adjustCredits(memberId: string, credits: number, label: string) {
    const member = await resolveMemberRecord(memberId);
    if (!member) return null;
    try {
      const ledger = await import("../payments/ledger");
      const transaction = await ledger.applyCreditEntry({member, credits, kind: "adjustment", label});
      if (!transaction) throw new AdminError("Those credits could not be adjusted.");
      const snapshot = await ledger.getMemberBilling(member);
      return {memberId: member.id, availableCredits: snapshot.wallet.availableCredits, transactionId: transaction.id};
    } catch (error) {
      if (error instanceof AdminError) throw error;
      throw new AdminError(error instanceof Error ? error.message : "Those credits could not be adjusted.");
    }
  },

  async listOrgs(): Promise<AdminOrgRow[] | null> {
    const db = await d1();
    if (!db) return null;
    const orgDb = await loadOrgDb();
    if (!orgDb) return null;
    try {
      const orgs = await orgDb.listOrganizations();
      return Promise.all(orgs.map((org) => toAdminOrgRow(org, orgDb)));
    } catch {
      return null;
    }
  },

  async approveOrg(id: string): Promise<AdminOrgRow | null> {
    const orgDb = await loadOrgDb();
    if (!orgDb) return null;
    return setOrgStatusInStore(orgDb, id, "active");
  },

  async setOrgStatus(id: string, status: AdminOrgStatus): Promise<AdminOrgRow | null> {
    if (!isAdminOrgStatus(status)) {
      throw new AdminError("Status must be pending, active, suspended, or rejected.");
    }
    const orgDb = await loadOrgDb();
    if (!orgDb) return null;
    return setOrgStatusInStore(orgDb, id, status);
  },
};

function requireStoreValue<T>(value: T | null, message: string): T {
  if (value === null) throw new AdminError(message, 503);
  return value;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Fall through to the 400 below.
  }
  throw new AdminError("Send a JSON body with this request.");
}

async function handleOverview(store: AdminStore): Promise<Record<string, unknown>> {
  const overview = requireStoreValue(await store.overview(), "D1 is unavailable — overview counts are empty.");
  return {overview};
}

async function handleMembers(store: AdminStore): Promise<Record<string, unknown>> {
  const rows = await store.listMembers();
  if (rows === null) {
    return {members: [], mockFallback: true, message: "D1 is unavailable — the member list is empty."};
  }
  return {members: rows};
}

async function handleBookings(store: AdminStore): Promise<Record<string, unknown>> {
  const rows = await store.listBookings();
  if (rows === null) {
    return {bookings: [], mockFallback: true, message: "D1 is unavailable — the booking list is empty."};
  }
  return {bookings: rows};
}

async function handleCancel(request: Request, store: AdminStore): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) throw new AdminError("Choose a booking to cancel.");
  const result = requireStoreValue(await store.cancelBooking(id), "That booking is not in the admin store.");
  return {booking: result.booking, refunded: result.refunded, availableCredits: result.availableCredits};
}

async function handleAssign(request: Request, store: AdminStore): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
  if (!id) throw new AdminError("Choose a booking to assign.");
  if (!providerId) throw new AdminError("Choose a provider for this booking.");
  const booking = requireStoreValue(await store.assignProvider(id, providerId), "That booking is not in the admin store.");
  return {booking};
}

async function handleCredit(request: Request, store: AdminStore): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const credits = typeof body.credits === "number" ? body.credits : Number.NaN;
  if (!memberId) throw new AdminError("Choose a member to adjust.");
  if (!Number.isFinite(credits) || credits === 0) throw new AdminError("Credits must be a non-zero number.");
  if (!Number.isInteger(credits)) throw new AdminError("Credits must be a whole number.");
  if (Math.abs(credits) > 10000) throw new AdminError("Adjustments are capped at 10,000 credits.");
  if (!label) throw new AdminError("Add a label for this adjustment.");
  if (label.length > 140) throw new AdminError("Keep the label under 140 characters.");
  const result = requireStoreValue(
    await store.adjustCredits(memberId, credits, label),
    "That member is not in the admin store.",
  );
  return {memberId: result.memberId, availableCredits: result.availableCredits, transactionId: result.transactionId};
}

async function handleOrgs(store: AdminStore): Promise<Record<string, unknown>> {
  const orgs = await store.listOrgs();
  if (orgs === null) {
    return {orgs: [], mockFallback: true, message: "D1 is unavailable — the organization list is empty."};
  }
  return {orgs};
}

async function handleApproveOrg(request: Request, store: AdminStore): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  if (!orgId) throw new AdminError("Choose an organization to approve.");
  const org = requireStoreValue(await store.approveOrg(orgId), "That organization is not in the admin store.");
  return {org};
}

async function handleOrgStatus(request: Request, store: AdminStore): Promise<Record<string, unknown>> {
  const body = await readBody(request);
  const orgId = typeof body.orgId === "string" ? body.orgId.trim() : "";
  const status = typeof body.status === "string" ? body.status.trim() : "";
  if (!orgId) throw new AdminError("Choose an organization to update.");
  if (!isAdminOrgStatus(status)) throw new AdminError("Status must be pending, active, suspended, or rejected.");
  const org = requireStoreValue(await store.setOrgStatus(orgId, status), "That organization is not in the admin store.");
  return {org};
}

async function withAdmin(
  request: Request,
  runtimeEnv: RuntimeEnv,
  run: () => Promise<Record<string, unknown>>,
): Promise<Response> {
  const auth = await authorizeAdmin(request, runtimeEnv);
  if (!auth.ok) {
    return json({source: "server", error: auth.error, opsOpen: false}, auth.status);
  }
  try {
    const data = await run();
    return json({source: "server", opsOpen: auth.open, ...data});
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleAdminFetch(
  request: Request,
  runtimeEnv: RuntimeEnv = {},
  store: AdminStore = defaultStore,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/api/admin/overview" && request.method === "GET") {
    return withAdmin(request, runtimeEnv, () => handleOverview(store));
  }
  if (url.pathname === "/api/admin/members" && request.method === "GET") {
    return withAdmin(request, runtimeEnv, () => handleMembers(store));
  }
  if (url.pathname === "/api/admin/bookings" && request.method === "GET") {
    return withAdmin(request, runtimeEnv, () => handleBookings(store));
  }
  if (url.pathname === "/api/admin/bookings/cancel" && request.method === "POST") {
    return withAdmin(request, runtimeEnv, () => handleCancel(request, store));
  }
  if (url.pathname === "/api/admin/bookings/assign" && request.method === "POST") {
    return withAdmin(request, runtimeEnv, () => handleAssign(request, store));
  }
  if (url.pathname === "/api/admin/members/credit" && request.method === "POST") {
    return withAdmin(request, runtimeEnv, () => handleCredit(request, store));
  }
  if (url.pathname === "/api/admin/orgs" && request.method === "GET") {
    return withAdmin(request, runtimeEnv, () => handleOrgs(store));
  }
  if (url.pathname === "/api/admin/orgs/approve" && request.method === "POST") {
    return withAdmin(request, runtimeEnv, () => handleApproveOrg(request, store));
  }
  if (url.pathname === "/api/admin/orgs/status" && request.method === "POST") {
    return withAdmin(request, runtimeEnv, () => handleOrgStatus(request, store));
  }
  return new Response("Not found", {status: 404});
}

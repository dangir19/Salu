import {getMemberSession} from "../auth/session";
import {toUiBooking} from "../bookings/service";
import {applyStripeEnvToProcess, isStripeReady, readStripeEnv, type StripeEnv} from "../payments/env";
import {applyOrgCreditEntry, getOrgBilling} from "../payments/org-ledger";
import {startCheckout} from "../payments/checkout";
import {InsufficientCreditsError} from "../payments/ledger";
import {rememberMember} from "../payments/ledger";
import {
  addStaffMember,
  BusinessError,
  createRecurringOrder,
  getMemberOrgs,
  listOrgOrders,
  listRecurringOrders,
  listStaffMembers,
  placeOrgOrder,
  publicOrg,
  requireOrgRole,
  signupBusiness,
} from "./service";

type RuntimeEnv = Record<string, string | undefined>;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {status});
}

function stripeEnvFrom(request: Request, runtimeEnv: RuntimeEnv): StripeEnv {
  const env = readStripeEnv({
    ...runtimeEnv,
    STRIPE_SECRET_KEY: runtimeEnv.STRIPE_SECRET_KEY,
  });
  applyStripeEnvToProcess(env);
  void request;
  return env;
}

async function requireMember(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return null;
  return rememberMember(session.member);
}

function errorResponse(error: unknown): Response {
  if (error instanceof InsufficientCreditsError) {
    return json({source: "server", error: error.message, needed: error.needed, available: error.available}, 402);
  }
  if (error instanceof BusinessError) {
    return json({source: "server", error: error.message}, error.status);
  }
  const message = error instanceof Error ? error.message : "That business request could not be saved.";
  return json({source: "server", error: message}, 400);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" ? value : undefined;
}

function originFrom(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

async function handleSignup(request: Request): Promise<Response> {
  const body = await readBody(request);
  const result = await signupBusiness({
    orgName: stringField(body, "orgName"),
    orgType: stringField(body, "orgType"),
    contactName: stringField(body, "contactName"),
    contactEmail: stringField(body, "contactEmail"),
    contactPhone: stringField(body, "contactPhone"),
    address: stringField(body, "address"),
    billingEmail: stringField(body, "billingEmail"),
    password: stringField(body, "password"),
    ip: request.headers.get("x-forwarded-for") ?? request.headers.get("cf-connecting-ip"),
  });
  if (!result.ok) {
    return json({source: "server", error: result.error}, result.status);
  }
  return json(
    {
      org: publicOrg(result.org),
      member: {id: result.member.id, email: result.member.email, displayName: result.member.displayName},
    },
    201,
  );
}

async function handleMe(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
  const memberships = await getMemberOrgs(member.id);
  return json({
    orgs: memberships.map(({org, role, availableCredits}) => ({org: publicOrg(org), role, availableCredits})),
  });
}

async function handleCreateOrder(request: Request, env: StripeEnv): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
  const body = await readBody(request);
  const orgId = stringField(body, "orgId") ?? "";
  if (!orgId) return json({source: "server", error: "Choose a business account."}, 400);
  try {
    const result = await placeOrgOrder({
      member,
      orgId,
      serviceId: stringField(body, "serviceId") ?? "",
      slotStart: stringField(body, "slotStart") ?? "",
      providerId: stringField(body, "providerId") ?? undefined,
      mode: stringField(body, "mode") ?? undefined,
      recipientName: stringField(body, "recipientName") ?? undefined,
      recipientRoom: stringField(body, "recipientRoom") ?? undefined,
      enforceCredits: isStripeReady(env),
    });
    return json({
      booking: {
        ...toUiBooking(result.booking),
        orgId: result.booking.orgId,
        recipientName: result.booking.recipientName,
        recipientRoom: result.booking.recipientRoom,
      },
      provider: result.provider,
      wallet: {availableCredits: result.availableCredits},
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleListOrders(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
  const orgId = new URL(request.url).searchParams.get("orgId") ?? "";
  if (!orgId) return json({source: "server", error: "Choose a business account."}, 400);
  try {
    await requireOrgRole(member.id, orgId);
    const {orders, summary} = await listOrgOrders(orgId);
    return json({
      orders: orders.map((order) => ({
        booking: {
          ...toUiBooking(order.booking),
          orgId: order.booking.orgId,
          recipientName: order.booking.recipientName,
          recipientRoom: order.booking.recipientRoom,
        },
        lineItems: order.lineItems,
        orderedBy: order.orderedBy,
      })),
      summary,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCreateRecurring(request: Request, env: StripeEnv): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
  const body = await readBody(request);
  try {
    const result = await createRecurringOrder({
      member,
      orgId: stringField(body, "orgId") ?? "",
      serviceId: stringField(body, "serviceId") ?? "",
      weekday: typeof body.weekday === "number" ? body.weekday : Number.NaN,
      timeLocal: stringField(body, "timeLocal") ?? "",
      startDate: stringField(body, "startDate") ?? "",
      endDate: stringField(body, "endDate") ?? "",
      recipientName: stringField(body, "recipientName") ?? undefined,
      recipientRoom: stringField(body, "recipientRoom") ?? undefined,
      providerId: stringField(body, "providerId") ?? undefined,
      enforceCredits: isStripeReady(env),
    });
    return json({schedule: result.schedule, created: result.created, failed: result.failed}, 201);
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleListRecurring(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
  const orgId = new URL(request.url).searchParams.get("orgId") ?? "";
  if (!orgId) return json({source: "server", error: "Choose a business account."}, 400);
  try {
    await requireOrgRole(member.id, orgId);
    const schedules = await listRecurringOrders(orgId);
    return json({schedules});
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleListStaff(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
  const orgId = new URL(request.url).searchParams.get("orgId") ?? "";
  if (!orgId) return json({source: "server", error: "Choose a business account."}, 400);
  try {
    await requireOrgRole(member.id, orgId);
    const staff = await listStaffMembers(orgId);
    return json({staff});
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleAddStaff(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
  const body = await readBody(request);
  const orgId = stringField(body, "orgId") ?? "";
  const email = stringField(body, "email") ?? "";
  if (!orgId || !email) return json({source: "server", error: "A business and an email are required."}, 400);
  try {
    const added = await addStaffMember({adminMember: member, orgId, email});
    return json({member: {id: added.id, email: added.email, displayName: added.displayName}});
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCredits(request: Request, env: StripeEnv): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
  const body = await readBody(request);
  const orgId = stringField(body, "orgId") ?? "";
  const credits = typeof body.credits === "number" ? body.credits : Number(body.credits);
  if (!orgId) return json({source: "server", error: "Choose a business account."}, 400);
  if (!Number.isInteger(credits) || credits <= 0) {
    return json({source: "server", error: "Choose how many Credits to add."}, 400);
  }
  try {
    await requireOrgRole(member.id, orgId, ["admin"]);
    if (!isStripeReady(env)) {
      const transaction = await applyOrgCreditEntry({
        orgId,
        credits,
        kind: "topup",
        label: "Demo top-up",
      });
      if (!transaction) {
        return json({source: "server", error: "That top-up was already applied."}, 409);
      }
      const billing = await getOrgBilling(orgId);
      return json({applied: true, wallet: {availableCredits: billing.wallet.availableCredits}});
    }
    const checkout = await startCheckout(
      env,
      member,
      {kind: "credits", credits, orgId},
      originFrom(request),
    );
    return json(checkout);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleBusinessFetch(request: Request, runtimeEnv: RuntimeEnv = {}): Promise<Response> {
  const url = new URL(request.url);
  const env = stripeEnvFrom(request, runtimeEnv);

  if (url.pathname === "/api/business/signup" && request.method === "POST") {
    return handleSignup(request);
  }
  if (url.pathname === "/api/business/me" && request.method === "GET") {
    return handleMe(request);
  }
  if (url.pathname === "/api/business/orders" && request.method === "POST") {
    return handleCreateOrder(request, env);
  }
  if (url.pathname === "/api/business/orders" && request.method === "GET") {
    return handleListOrders(request);
  }
  if (url.pathname === "/api/business/recurring" && request.method === "POST") {
    return handleCreateRecurring(request, env);
  }
  if (url.pathname === "/api/business/recurring" && request.method === "GET") {
    return handleListRecurring(request);
  }
  if (url.pathname === "/api/business/staff" && request.method === "GET") {
    return handleListStaff(request);
  }
  if (url.pathname === "/api/business/staff" && request.method === "POST") {
    return handleAddStaff(request);
  }
  if (url.pathname === "/api/business/credits" && request.method === "POST") {
    return handleCredits(request, env);
  }
  return new Response("Not found", {status: 404});
}

import {getMemberSession} from "../auth/session";
import {rememberMember} from "../payments/ledger";
import {applyStripeEnvToProcess, isStripeReady, readStripeEnv, type StripeEnv} from "../payments/env";
import {
  acceptProposedBookingTime,
  assignMemberBooking,
  BookingError,
  cancelMemberBooking,
  completeMemberBooking,
  createMemberBooking,
  createScheduledMemberBooking,
  declineProposedBookingTime,
  InsufficientCreditsError,
  listMemberBookings,
  rescheduleMemberBooking,
  toUiBooking,
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
  if (error instanceof BookingError) {
    return json({source: "server", error: error.message}, error.status);
  }
  const message = error instanceof Error ? error.message : "The reservation could not be saved.";
  return json({source: "server", error: message}, 400);
}

export async function handleBookingsFetch(request: Request, runtimeEnv: RuntimeEnv = {}): Promise<Response> {
  const url = new URL(request.url);
  const env = stripeEnvFrom(request, runtimeEnv);

  if (url.pathname === "/api/bookings" && request.method === "GET") {
    return handleList(request);
  }
  if (url.pathname === "/api/bookings" && request.method === "POST") {
    return handleCreate(request, env);
  }
  if (url.pathname === "/api/bookings/assign" && request.method === "POST") {
    return handleAssign(request, env);
  }
  if (url.pathname === "/api/bookings/reschedule" && request.method === "POST") {
    return handleReschedule(request);
  }
  if (url.pathname === "/api/bookings/cancel" && request.method === "POST") {
    return handleCancel(request);
  }
  if (url.pathname === "/api/bookings/complete" && request.method === "POST") {
    return handleComplete(request);
  }
  if (url.pathname === "/api/bookings/accept-proposal" && request.method === "POST") {
    return handleAcceptProposal(request);
  }
  if (url.pathname === "/api/bookings/decline-proposal" && request.method === "POST") {
    return handleDeclineProposal(request);
  }
  return new Response("Not found", {status: 404});
}

async function handleList(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) {
    return json({
      source: "demo",
      bookings: [],
      message: "Sign in to keep appointments on the server. This local preview still uses labeled demo bookings.",
    });
  }
  const bookings = await listMemberBookings(member.id);
  return json({source: "server", bookings: bookings.map(toUiBooking)});
}

async function handleCreate(request: Request, env: StripeEnv): Promise<Response> {
  const member = await requireMember(request);
  if (!member) {
    return json({
      source: "demo",
      error: "Sign in to persist this reservation.",
      message: "This local preview still uses labeled demo bookings.",
    }, 401);
  }

  let body: {
    serviceId?: string;
    date?: string;
    mode?: string;
    packageName?: string;
    packageItem?: string;
    availabilityId?: string;
    providerId?: string;
    slotStart?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a service and time."}, 400);
  }

  try {
    if (body.providerId && body.slotStart) {
      const result = await createScheduledMemberBooking({
        member,
        serviceId: body.serviceId ?? "",
        mode: body.mode,
        providerId: body.providerId,
        slotStart: body.slotStart,
        packageName: body.packageName,
        packageItem: body.packageItem,
        enforceCredits: isStripeReady(env),
      });
      const bookings = await listMemberBookings(member.id);
      return json({
        source: "server",
        booking: toUiBooking(result.booking),
        bookings: bookings.map(toUiBooking),
        provider: result.provider,
        creditsApplied: result.creditsApplied,
        wallet: {availableCredits: result.availableCredits},
      });
    }
    const result = await createMemberBooking({
      member,
      serviceId: body.serviceId ?? "",
      date: body.date ?? "",
      mode: body.mode ?? "",
      packageName: body.packageName,
      packageItem: body.packageItem,
      availabilityId: body.availabilityId,
      enforceCredits: isStripeReady(env),
    });
    const bookings = await listMemberBookings(member.id);
    return json({
      source: "server",
      booking: toUiBooking(result.booking),
      bookings: bookings.map(toUiBooking),
      creditsApplied: result.creditsApplied,
      wallet: {availableCredits: result.availableCredits},
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleAssign(request: Request, env: StripeEnv): Promise<Response> {
  const member = await requireMember(request);
  if (!member) {
    return json({source: "demo", error: "Sign in to persist this reservation."}, 401);
  }

  let body: {serviceId?: string; startISO?: string; mode?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a service and time."}, 400);
  }

  try {
    const result = await assignMemberBooking({
      member,
      serviceId: body.serviceId ?? "",
      startISO: body.startISO ?? "",
      mode: body.mode,
      enforceCredits: isStripeReady(env),
    });
    const bookings = await listMemberBookings(member.id);
    return json({
      source: "server",
      booking: toUiBooking(result.booking),
      bookings: bookings.map(toUiBooking),
      provider: result.provider,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleReschedule(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) {
    return json({source: "demo", error: "Sign in to move a saved reservation."}, 401);
  }

  let body: {id?: string; date?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a reservation to move."}, 400);
  }

  try {
    const booking = await rescheduleMemberBooking({
      member,
      bookingId: body.id ?? "",
      date: body.date ?? "",
    });
    const bookings = await listMemberBookings(member.id);
    return json({
      source: "server",
      booking: toUiBooking(booking),
      bookings: bookings.map(toUiBooking),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleCancel(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) {
    return json({source: "demo", error: "Sign in to cancel a saved reservation."}, 401);
  }

  let body: {id?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a reservation to cancel."}, 400);
  }

  try {
    const result = await cancelMemberBooking({member, bookingId: body.id ?? ""});
    const bookings = await listMemberBookings(member.id);
    return json({
      source: "server",
      booking: toUiBooking(result.booking),
      bookings: bookings.map(toUiBooking),
      creditsApplied: result.creditsApplied,
      wallet: {availableCredits: result.availableCredits},
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleAcceptProposal(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) {
    return json({source: "demo", error: "Sign in to accept a proposed time."}, 401);
  }

  let body: {id?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a reservation to accept."}, 400);
  }

  try {
    const result = await acceptProposedBookingTime({member, bookingId: body.id ?? ""});
    const bookings = await listMemberBookings(member.id);
    return json({
      source: "server",
      booking: toUiBooking(result.booking),
      bookings: bookings.map(toUiBooking),
      creditsApplied: result.creditsApplied,
      wallet: {availableCredits: result.availableCredits},
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleDeclineProposal(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) {
    return json({source: "demo", error: "Sign in to decline a proposed time."}, 401);
  }

  let body: {id?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a reservation to decline."}, 400);
  }

  try {
    const result = await declineProposedBookingTime({member, bookingId: body.id ?? ""});
    const bookings = await listMemberBookings(member.id);
    return json({
      source: "server",
      booking: toUiBooking(result.booking),
      bookings: bookings.map(toUiBooking),
      creditsApplied: result.creditsApplied,
      wallet: {availableCredits: result.availableCredits},
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleComplete(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) {
    return json({source: "demo", error: "Sign in to complete a saved reservation."}, 401);
  }

  let body: {id?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({source: "server", error: "Choose a reservation to complete."}, 400);
  }

  try {
    const result = await completeMemberBooking({member, bookingId: body.id ?? ""});
    const bookings = await listMemberBookings(member.id);
    return json({
      source: "server",
      booking: toUiBooking(result.booking),
      bookings: bookings.map(toUiBooking),
      payout: result.payout,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

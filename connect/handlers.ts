import {getMemberSession} from "../auth/session";
import {listProviderBookings, toUiBooking} from "../bookings/service";
import type {ConnectStatus} from "../domain/types";
import {rememberMember} from "../payments/ledger";
import {getProviderSession} from "../provider/session";
import {applyStripeEnvToProcess, paymentsSurface, readStripeEnv, type StripeEnv} from "../payments/env";
import {catalogPractices} from "./catalog";
import {
  claimProvider,
  ConnectError,
  findProvider,
  listProviderPayouts,
  listProviders,
  refreshProviderAccount,
  startConnectDashboard,
  startConnectOnboarding,
} from "./service";
import {connectStatusLabel} from "./status";

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
  if (error instanceof ConnectError) {
    return json({error: error.message}, error.status);
  }
  const message = error instanceof Error ? error.message : "Stripe Connect is unavailable.";
  return json({error: message}, 400);
}

export async function handleConnectFetch(request: Request, runtimeEnv: RuntimeEnv = {}): Promise<Response> {
  const url = new URL(request.url);
  const env = stripeEnvFrom(request, runtimeEnv);

  if (url.pathname === "/api/connect/me" && request.method === "GET") {
    return handleConnectMe(request, env, runtimeEnv);
  }
  if (url.pathname === "/api/connect/claim" && request.method === "POST") {
    return handleClaim(request);
  }
  if (url.pathname === "/api/connect/onboard" && request.method === "POST") {
    return handleOnboard(request, env, runtimeEnv);
  }
  if (url.pathname === "/api/connect/login" && request.method === "POST") {
    return handleLogin(request, env);
  }
  return new Response("Not found", {status: 404});
}

async function handleConnectMe(request: Request, env: StripeEnv, runtimeEnv: RuntimeEnv): Promise<Response> {
  const session = await getMemberSession(request);
  const providerSession = await getProviderSession(request, runtimeEnv);
  const surface = paymentsSurface(env);
  const practices = catalogPractices();
  const providers = await listProviders();

  if (!session) {
    return json({
      signedIn: false,
      surface,
      provider: null,
      status: "not_connected" as ConnectStatus,
      statusLabel: connectStatusLabel("not_connected"),
      practices,
      payouts: [],
      bookings: [],
      message: "Sign in as a provider to set up Stripe Connect payouts. This local preview still uses labeled demo payouts.",
    });
  }

  const member = await rememberMember(session.member);
  let provider = await findProvider({memberId: member.id});
  if (!provider && providerSession) {
    provider = await claimProvider({
      member,
      providerId: providerSession.provider.practiceId,
      practiceName: providerSession.provider.practiceName,
    });
  }
  if (provider && surface.connect) {
    provider = await refreshProviderAccount({provider, env});
  }
  const payouts = provider ? await listProviderPayouts(provider.id) : [];
  const bookings = provider
    ? (await listProviderBookings(provider.name)).map(toUiBooking)
    : [];

  return json({
    signedIn: true,
    surface,
    member: {id: member.id, email: member.email, displayName: member.displayName},
    provider,
    status: provider?.connectStatus ?? "not_connected",
    statusLabel: connectStatusLabel(provider?.connectStatus ?? "not_connected"),
    practices: practices.map((practice) => ({
      ...practice,
      claimed: Boolean(providers.find((row) => row.id === practice.id)?.memberId),
      claimedByYou: providers.find((row) => row.id === practice.id)?.memberId === member.id,
    })),
    payouts,
    bookings,
  });
}

async function handleClaim(request: Request): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({error: "Sign in to claim a practice."}, 401);

  let body: {providerId?: string};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({error: "Choose a practice."}, 400);
  }

  try {
    const provider = await claimProvider({member, providerId: body.providerId ?? ""});
    return json({provider, status: provider.connectStatus, statusLabel: connectStatusLabel(provider.connectStatus)});
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleOnboard(request: Request, env: StripeEnv, runtimeEnv: RuntimeEnv): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({error: "Sign in to set up payouts."}, 401);
  const providerSession = await getProviderSession(request, runtimeEnv);

  let body: {providerId?: string} = {};
  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      body = (await request.json()) as typeof body;
    }
  } catch {
    body = {};
  }

  try {
    const result = await startConnectOnboarding({
      member,
      providerId: body.providerId || providerSession?.provider.practiceId,
      practiceName: providerSession?.provider.practiceName,
      origin: new URL(request.url).origin,
      env,
    });
    if (result.demo) {
      return json({
        demo: true,
        url: null,
        provider: result.provider,
        status: result.status,
        statusLabel: connectStatusLabel(result.status),
        message: "Stripe Connect is not connected yet. This local preview still uses labeled demo payouts.",
      }, 503);
    }
    return json({
      url: result.url,
      provider: result.provider,
      status: result.status,
      statusLabel: connectStatusLabel(result.status),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function handleLogin(request: Request, env: StripeEnv): Promise<Response> {
  const member = await requireMember(request);
  if (!member) return json({error: "Sign in to open payouts."}, 401);
  try {
    const result = await startConnectDashboard({member, env});
    if (result.demo) {
      return json({
        demo: true,
        url: null,
        provider: result.provider,
        message: "Stripe Connect is not connected yet.",
      }, 503);
    }
    return json({url: result.url, provider: result.provider});
  } catch (error) {
    return errorResponse(error);
  }
}

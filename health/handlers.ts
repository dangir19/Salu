import {getMemberSession, getMePayload} from "../auth/session";
import {rememberMember} from "../payments/ledger";
import {isStravaReady, readStravaEnv, stravaConfigReport, type StravaEnv} from "./env";
import {
  buildStravaAuthorize,
  completeStravaCallback,
  disconnectProvider,
  getHealthStatus,
  getWeeklySummary,
  HealthError,
  ingestAppleMetrics,
  memberIdForBearerToken,
  mintDeviceToken,
  recommendRecovery,
  syncStravaForMember,
  validateApplePayload,
} from "./service";

type RuntimeEnv = Record<string, string | undefined>;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {status});
}

function stravaEnvFrom(runtimeEnv: RuntimeEnv): StravaEnv {
  return readStravaEnv({...runtimeEnv, ...asProcessEnv()});
}

function asProcessEnv(): Record<string, string | undefined> {
  try {
    return process.env as Record<string, string | undefined>;
  } catch {
    return {};
  }
}

async function requireMember(request: Request) {
  const session = await getMemberSession(request);
  if (!session) return null;
  return rememberMember(session.member);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof HealthError) {
    return json({source: "server", error: error.message}, error.status);
  }
  const message = error instanceof Error ? error.message : "That health request could not be completed.";
  return json({source: "server", error: message}, 400);
}

function originFrom(request: Request): string {
  return new URL(request.url).origin;
}

export async function handleHealthFetch(request: Request, runtimeEnv: RuntimeEnv = {}): Promise<Response> {
  const url = new URL(request.url);
  const env = stravaEnvFrom(runtimeEnv);
  const path = url.pathname;

  if (path === "/api/health/status" && request.method === "GET") {
    const member = await requireMember(request);
    if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
    try {
      return json({source: "server", ...(await getHealthStatus(member.id, env))});
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (path === "/api/health/summary" && request.method === "GET") {
    const member = await requireMember(request);
    if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
    try {
      const summary = await getWeeklySummary(member.id);
      return json({source: "server", summary, recommendation: recommendRecovery(summary)});
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (path === "/api/health/strava/authorize" && request.method === "GET") {
    const member = await requireMember(request);
    if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
    if (!isStravaReady(env)) {
      return json({
        source: "server",
        notConfigured: true,
        missing: ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET"],
        message: "Strava is not connected yet. An admin needs to add the Strava API keys first.",
      }, 503);
    }
    try {
      const {url: authorizeUrl} = await buildStravaAuthorize(member, originFrom(request), env);
      return json({source: "server", url: authorizeUrl});
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (path === "/api/health/strava/callback" && request.method === "GET") {
    const member = await requireMember(request);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const stravaError = url.searchParams.get("error");
    const fail = (reason: string) =>
      Response.redirect(`${originFrom(request)}/apps?health=error&reason=${encodeURIComponent(reason)}`, 302);
    if (stravaError) return fail("strava_declined");
    if (!member) return fail("signin_required");
    try {
      await completeStravaCallback({code, state, member}, originFrom(request), env);
      return Response.redirect(`${originFrom(request)}/apps?health=strava_connected`, 302);
    } catch {
      return fail("exchange_failed");
    }
  }

  if (path === "/api/health/strava/sync" && request.method === "POST") {
    const member = await requireMember(request);
    if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
    try {
      const syncedDays = await syncStravaForMember(member.id, env);
      return json({source: "server", syncedDays});
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (path === "/api/health/disconnect" && request.method === "POST") {
    const member = await requireMember(request);
    if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
    const body = await readBody(request);
    try {
      await disconnectProvider(member.id, typeof body.provider === "string" ? body.provider : "");
      return json({source: "server", disconnected: true});
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (path === "/api/health/device-token" && request.method === "POST") {
    const member = await requireMember(request);
    if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
    const body = await readBody(request);
    try {
      const token = await mintDeviceToken(
        member.id,
        typeof body.deviceName === "string" ? body.deviceName.slice(0, 80) : undefined,
      );
      // Returned once: the native app stores it in the keychain. We never return it again.
      return json({source: "server", token});
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (path === "/api/health/apple/ingest" && request.method === "POST") {
    // Bearer (native app device token) or the member's web session.
    const bearerMemberId = await memberIdForBearerToken(request.headers.get("authorization"));
    const member = bearerMemberId ? {id: bearerMemberId} : await requireMember(request);
    if (!member) return json({source: "server", error: "Sign in to continue."}, 401);
    const body = await readBody(request);
    const validated = validateApplePayload(body);
    if (!validated.ok) return json({source: "server", error: validated.error}, 400);
    try {
      const metric = await ingestAppleMetrics(member.id, validated.value);
      return json({source: "server", saved: true, date: metric.date});
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (path === "/api/health/config" && request.method === "GET") {
    const me = await getMePayload(request, undefined, runtimeEnv);
    if (!me.member) return json({source: "server", error: "Sign in to continue."}, 401);
    if (!me.admin) return json({source: "server", error: "Admin access required."}, 403);
    // Presence only: secret values are never returned.
    return json({source: "server", ...stravaConfigReport(env), redirectUri: `${originFrom(request)}/api/health/strava/callback`});
  }

  return new Response("Not found", {status: 404});
}

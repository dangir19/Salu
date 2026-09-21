import {
  deleteHealthAccount,
  getHealthAccount,
  listHealthAccounts,
  listHealthMetrics,
  memberIdForDeviceToken,
  storeDeviceToken,
  upsertHealthAccount,
  upsertHealthMetric,
  type HealthMetric,
  type HealthProvider,
} from "../db/health";
import {isStravaReady, type StravaEnv} from "./env";
import {
  exchangeStravaCode,
  fetchStravaActivities,
  refreshStravaToken,
  stravaAuthorizeUrl,
  type StravaActivity,
} from "./strava";

type MemberLike = {id: string; email?: string; displayName?: string};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// OAuth state (single-use, 10-minute TTL). Per-isolate memory; fine for v1.
// ---------------------------------------------------------------------------
const oauthStates = new Map<string, {memberId: string; expiresAt: number}>();

function rememberOAuthState(memberId: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const state = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  oauthStates.set(state, {memberId, expiresAt: Date.now() + 10 * 60 * 1000});
  return state;
}

function consumeOAuthState(state: string): string | null {
  const entry = oauthStates.get(state);
  oauthStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.memberId;
}

export function stravaRedirectUri(origin: string): string {
  return `${origin}/api/health/strava/callback`;
}

export class HealthError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function buildStravaAuthorize(
  member: MemberLike,
  origin: string,
  env: StravaEnv,
): Promise<{url: string; state: string}> {
  if (!isStravaReady(env)) {
    throw new HealthError("Strava is not connected yet. Ask an admin to add the Strava API keys.", 503);
  }
  const state = rememberOAuthState(member.id);
  return {
    url: stravaAuthorizeUrl({
      clientId: env.STRAVA_CLIENT_ID!,
      redirectUri: stravaRedirectUri(origin),
      state,
    }),
    state,
  };
}

export async function completeStravaCallback(
  args: {code: string; state: string; member: MemberLike},
  origin: string,
  env: StravaEnv,
  fetchFn: typeof fetch = fetch,
): Promise<{syncedDays: number}> {
  if (!isStravaReady(env)) throw new HealthError("Strava is not connected yet.", 503);
  const memberId = consumeOAuthState(args.state);
  if (!memberId || memberId !== args.member.id) {
    throw new HealthError("That Strava authorization expired or does not match your session. Try again.", 400);
  }
  if (!args.code) throw new HealthError("Strava did not return an authorization code.", 400);
  const tokens = await exchangeStravaCode(
    {
      clientId: env.STRAVA_CLIENT_ID!,
      clientSecret: env.STRAVA_CLIENT_SECRET!,
      code: args.code,
      redirectUri: stravaRedirectUri(origin),
    },
    fetchFn,
  );
  await upsertHealthAccount(args.member.id, "strava", {
    providerUserId: tokens.athleteId || null,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes || "read,activity:read_all",
  });
  const syncedDays = await syncStravaForMember(args.member.id, env, fetchFn);
  return {syncedDays};
}

async function freshStravaAccessToken(
  memberId: string,
  env: StravaEnv,
  fetchFn: typeof fetch,
): Promise<string> {
  const account = await getHealthAccount(memberId, "strava");
  if (!account?.accessToken) throw new HealthError("Connect Strava first.", 400);
  const expired = !account.tokenExpiresAt || new Date(account.tokenExpiresAt).getTime() < Date.now() + 60_000;
  if (!expired) return account.accessToken;
  if (!account.refreshToken || !isStravaReady(env)) {
    throw new HealthError("Your Strava session expired. Reconnect Strava.", 401);
  }
  const tokens = await refreshStravaToken(
    {
      clientId: env.STRAVA_CLIENT_ID!,
      clientSecret: env.STRAVA_CLIENT_SECRET!,
      refreshToken: account.refreshToken,
    },
    fetchFn,
  );
  await upsertHealthAccount(memberId, "strava", {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiresAt: tokens.expiresAt,
  });
  return tokens.accessToken;
}

export type DayWorkout = {type: string; distanceMi: number; durationMin: number; name: string};

/** Pure: fold activities into per-day workout lists. */
export function aggregateActivitiesToDays(activities: StravaActivity[]): Map<string, DayWorkout[]> {
  const days = new Map<string, DayWorkout[]>();
  for (const activity of activities) {
    const date = activity.startDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const list = days.get(date) ?? [];
    list.push({
      type: activity.type,
      distanceMi: activity.distanceMi,
      durationMin: activity.durationMin,
      name: activity.name,
    });
    days.set(date, list);
  }
  return days;
}

function simpleTrainingLoad(workouts: DayWorkout[]): number {
  // Rule-of-thumb load: distance miles weighted by duration. v1, not clinical.
  return Math.round(workouts.reduce((sum, w) => sum + w.distanceMi * (1 + w.durationMin / 60), 0) * 10) / 10;
}

export async function syncStravaForMember(
  memberId: string,
  env: StravaEnv,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const accessToken = await freshStravaAccessToken(memberId, env, fetchFn);
  const activities = await fetchStravaActivities(accessToken, fetchFn);
  const days = aggregateActivitiesToDays(activities);
  let synced = 0;
  for (const [date, workouts] of days) {
    const metric = await upsertHealthMetric(memberId, date, "strava", {
      workoutsJson: JSON.stringify(workouts),
      trainingLoad: simpleTrainingLoad(workouts),
    });
    if (metric) synced += 1;
  }
  await upsertHealthAccount(memberId, "strava", {lastSyncAt: new Date().toISOString()});
  return synced;
}

// ---------------------------------------------------------------------------
// Disconnect: account + all metrics from that source, in one call.
// ---------------------------------------------------------------------------
export async function disconnectProvider(memberId: string, provider: string): Promise<void> {
  if (provider !== "strava" && provider !== "apple_health" && provider !== "google_health") {
    throw new HealthError("Unknown provider.", 400);
  }
  await deleteHealthAccount(memberId, provider as HealthProvider);
}

// ---------------------------------------------------------------------------
// Apple Health ingest (native app posts here; web cannot sync HealthKit).
// ---------------------------------------------------------------------------
export type AppleIngestPayload = {
  date: string;
  workouts?: Array<{type: string; distanceMi?: number; durationMin?: number; name?: string}>;
  steps?: number;
  sleepHours?: number;
  restingHr?: number;
  hrvMs?: number;
};

export function validateApplePayload(body: unknown): {ok: true; value: AppleIngestPayload} | {ok: false; error: string} {
  if (!body || typeof body !== "object") return {ok: false, error: "Send a JSON body."};
  const b = body as Record<string, unknown>;
  if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
    return {ok: false, error: "date must be YYYY-MM-DD."};
  }
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
  const workouts = Array.isArray(b.workouts)
    ? b.workouts.slice(0, 50).map((w) => {
        const workout = (w ?? {}) as Record<string, unknown>;
        return {
          type: typeof workout.type === "string" ? workout.type.slice(0, 40) : "Workout",
          distanceMi: num(workout.distanceMi) ?? 0,
          durationMin: num(workout.durationMin) ?? 0,
          name: typeof workout.name === "string" ? workout.name.slice(0, 120) : "Workout",
        };
      })
    : undefined;
  const steps = num(b.steps);
  const sleepHours = b.sleepHours === undefined ? undefined : num(b.sleepHours);
  if (b.sleepHours !== undefined && sleepHours === undefined) return {ok: false, error: "sleepHours must be a non-negative number."};
  return {
    ok: true,
    value: {
      date: b.date,
      workouts,
      steps: steps === undefined ? undefined : Math.round(steps),
      sleepHours,
      restingHr: num(b.restingHr),
      hrvMs: num(b.hrvMs),
    },
  };
}

export async function ingestAppleMetrics(memberId: string, payload: AppleIngestPayload): Promise<HealthMetric> {
  const workouts: DayWorkout[] = (payload.workouts ?? []).map((w) => ({
    type: w.type,
    distanceMi: w.distanceMi ?? 0,
    durationMin: w.durationMin ?? 0,
    name: w.name ?? "Workout",
  }));
  const metric = await upsertHealthMetric(memberId, payload.date, "apple_health", {
    workoutsJson: workouts.length ? JSON.stringify(workouts) : undefined,
    steps: payload.steps,
    sleepHours: payload.sleepHours,
    restingHr: payload.restingHr,
    hrvMs: payload.hrvMs,
    trainingLoad: workouts.length ? simpleTrainingLoad(workouts) : undefined,
  });
  if (!metric) throw new HealthError("Health data could not be saved right now.", 503);
  await upsertHealthAccount(memberId, "apple_health", {lastSyncAt: new Date().toISOString()});
  return metric;
}

// ---------------------------------------------------------------------------
// Device tokens for the future native app (bearer auth for ingest).
// ---------------------------------------------------------------------------
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mintDeviceToken(memberId: string, deviceName?: string): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const ok = await storeDeviceToken(memberId, await sha256Hex(token), deviceName);
  if (!ok) throw new HealthError("Could not issue a device token right now.", 503);
  return token;
}

export async function memberIdForBearerToken(header: string | null): Promise<string | null> {
  if (!header) return null;
  const match = /^Bearer\s+([A-Za-z0-9]+)$/.exec(header.trim());
  if (!match) return null;
  return memberIdForDeviceToken(await sha256Hex(match[1]));
}

// ---------------------------------------------------------------------------
// Weekly summary + rule-based recovery recommendations (v1, no ML).
// ---------------------------------------------------------------------------
export type WeeklyHealthSummary = {
  hasData: boolean;
  weekMiles: number;
  longRunMiles: number;
  workoutCount: number;
  sources: string[];
  avgRestingHr: number | null;
  avgSleepHours: number | null;
};

function parseWorkouts(metric: HealthMetric): DayWorkout[] {
  if (!metric.workoutsJson) return [];
  try {
    const parsed = JSON.parse(metric.workoutsJson) as DayWorkout[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Pure: summarize a list of metrics into the weekly view. */
export function summarizeMetrics(metrics: HealthMetric[]): WeeklyHealthSummary {
  const sources = [...new Set(metrics.map((m) => m.source))];
  let weekMiles = 0;
  let longRunMiles = 0;
  let workoutCount = 0;
  const resting: number[] = [];
  const sleep: number[] = [];
  for (const metric of metrics) {
    for (const workout of parseWorkouts(metric)) {
      workoutCount += 1;
      weekMiles += workout.distanceMi;
      if (workout.distanceMi > longRunMiles) longRunMiles = workout.distanceMi;
    }
    if (typeof metric.restingHr === "number") resting.push(metric.restingHr);
    if (typeof metric.sleepHours === "number") sleep.push(metric.sleepHours);
  }
  const avg = (xs: number[]): number | null =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null;
  return {
    hasData: workoutCount > 0 || metrics.length > 0,
    weekMiles: Math.round(weekMiles * 10) / 10,
    longRunMiles: Math.round(longRunMiles * 10) / 10,
    workoutCount,
    sources,
    avgRestingHr: avg(resting),
    avgSleepHours: avg(sleep),
  };
}

export async function getWeeklySummary(memberId: string): Promise<WeeklyHealthSummary> {
  const metrics = (await listHealthMetrics(memberId, daysAgoISO(6), todayISO())) ?? [];
  return summarizeMetrics(metrics);
}

export type RecoveryRecommendation = {
  level: "high" | "moderate";
  services: string[];
  note: string;
};

/** Pure rule-based v1: heavy training weeks earn recovery nudges. */
export function recommendRecovery(summary: WeeklyHealthSummary): RecoveryRecommendation | null {
  if (!summary.hasData) return null;
  if (summary.weekMiles >= 20 || summary.longRunMiles >= 8) {
    return {
      level: "high",
      services: ["Sports Massage", "Assisted Stretching"],
      note: `Big week — ${summary.weekMiles} miles${summary.longRunMiles >= 8 ? ` with a ${summary.longRunMiles}-mile long run` : ""}. A sports massage and an assisted stretch session would be a smart recovery move.`,
    };
  }
  if (summary.weekMiles >= 10 || summary.workoutCount >= 4) {
    return {
      level: "moderate",
      services: ["Assisted Stretching"],
      note: `Solid training week (${summary.weekMiles} miles, ${summary.workoutCount} workouts). An assisted stretch session keeps things loose.`,
    };
  }
  return null;
}

export type HealthStatus = {
  strava: {connected: boolean; connectedAt: string | null; lastSyncAt: string | null};
  appleHealth: {connected: boolean; connectedAt: string | null; lastSyncAt: string | null};
  stravaReady: boolean;
};

export async function getHealthStatus(memberId: string, env: StravaEnv): Promise<HealthStatus> {
  const accounts = (await listHealthAccounts(memberId)) ?? [];
  const find = (provider: HealthProvider) => accounts.find((a) => a.provider === provider);
  const strava = find("strava");
  const apple = find("apple_health");
  return {
    strava: {
      connected: Boolean(strava),
      connectedAt: strava?.connectedAt ?? null,
      lastSyncAt: strava?.lastSyncAt ?? null,
    },
    appleHealth: {
      connected: Boolean(apple),
      connectedAt: apple?.connectedAt ?? null,
      lastSyncAt: apple?.lastSyncAt ?? null,
    },
    stravaReady: isStravaReady(env),
  };
}

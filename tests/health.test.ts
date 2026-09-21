import {after, before, describe, it} from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {drizzle, type SqliteRemoteDatabase} from "drizzle-orm/sqlite-proxy";
import {sql} from "drizzle-orm";
import type {getDb as getDbType} from "../db/index";
import {
  aggregateActivitiesToDays,
  buildStravaAuthorize,
  completeStravaCallback,
  HealthError,
  recommendRecovery,
  summarizeMetrics,
  validateApplePayload,
} from "../health/service";
import {
  exchangeStravaCode,
  fetchStravaActivities,
  refreshStravaToken,
  stravaAuthorizeUrl,
} from "../health/strava";
import {isStravaReady, stravaConfigReport} from "../health/env";
import type {HealthMetric} from "../db/health";
import {
  __injectHealthDbForTests,
  consumeStravaOAuthState,
  getHealthAccount,
  storeStravaOAuthState,
} from "../db/health";

type Db = ReturnType<typeof getDbType>;

function metric(partial: Partial<HealthMetric> & {date: string}): HealthMetric {
  return {
    id: `m_${partial.date}`,
    memberId: "member_1",
    source: "strava",
    workoutsJson: null,
    steps: null,
    sleepHours: null,
    restingHr: null,
    hrvMs: null,
    trainingLoad: null,
    ...partial,
  };
}

describe("strava authorize url", () => {
  it("builds a valid Strava OAuth URL", () => {
    const url = stravaAuthorizeUrl({
      clientId: "123",
      redirectUri: "https://x.com/api/health/strava/callback",
      state: "abc",
    });
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://www.strava.com/oauth/authorize");
    assert.equal(parsed.searchParams.get("client_id"), "123");
    assert.equal(parsed.searchParams.get("response_type"), "code");
    assert.equal(parsed.searchParams.get("state"), "abc");
    assert.ok(parsed.searchParams.get("scope")!.includes("activity:read_all"));
  });
});

describe("strava token exchange", () => {
  const tokenJson = {
    access_token: "at_1",
    refresh_token: "rt_1",
    expires_at: 1900000000,
    athlete: {id: 42},
    scope: "read,activity:read_all",
  };
  const okFetch = (async () =>
    new Response(JSON.stringify(tokenJson), {status: 200})) as unknown as typeof fetch;

  it("exchanges a code for tokens", async () => {
    const tokens = await exchangeStravaCode(
      {clientId: "c", clientSecret: "s", code: "code", redirectUri: "https://x/cb"},
      okFetch,
    );
    assert.equal(tokens.accessToken, "at_1");
    assert.equal(tokens.refreshToken, "rt_1");
    assert.equal(tokens.athleteId, "42");
  });

  it("refreshes an expired token", async () => {
    const tokens = await refreshStravaToken(
      {clientId: "c", clientSecret: "s", refreshToken: "rt_1"},
      okFetch,
    );
    assert.equal(tokens.accessToken, "at_1");
  });

  it("throws on a failed exchange", async () => {
    const bad = (async () => new Response("no", {status: 400})) as unknown as typeof fetch;
    await assert.rejects(() =>
      exchangeStravaCode({clientId: "c", clientSecret: "s", code: "x", redirectUri: "https://x/cb"}, bad),
    );
  });
});

describe("strava activities", () => {
  it("keeps only minimal fields", async () => {
    const payload = [
      {
        id: 99,
        name: "Morning Run",
        type: "Run",
        distance: 16093.44,
        moving_time: 3600,
        start_date_local: "2026-09-20T07:00:00Z",
        secret_extra_field: "must not survive",
      },
    ];
    const fetchFn = (async () =>
      new Response(JSON.stringify(payload), {status: 200})) as unknown as typeof fetch;
    const activities = await fetchStravaActivities("tok", fetchFn);
    assert.equal(activities.length, 1);
    assert.equal(activities[0]!.distanceMi, 10);
    assert.equal(activities[0]!.durationMin, 60);
    assert.ok(!("secret_extra_field" in activities[0]!));
  });
});

describe("activity aggregation", () => {
  it("folds activities into per-day lists", () => {
    const days = aggregateActivitiesToDays([
      {id: "1", name: "Run", type: "Run", distanceMi: 10, durationMin: 70, startDate: "2026-09-20T07:00:00Z"},
      {id: "2", name: "Ride", type: "Ride", distanceMi: 20, durationMin: 60, startDate: "2026-09-20T18:00:00Z"},
      {id: "3", name: "Bad", type: "Run", distanceMi: 5, durationMin: 30, startDate: "not-a-date"},
    ]);
    assert.equal(days.size, 1);
    assert.equal(days.get("2026-09-20")!.length, 2);
  });
});

describe("weekly summary", () => {
  it("sums miles, finds the long run, counts workouts", () => {
    const summary = summarizeMetrics([
      metric({
        date: "2026-09-20",
        workoutsJson: JSON.stringify([
          {type: "Run", distanceMi: 10, durationMin: 70, name: "Long run"},
          {type: "Run", distanceMi: 5, durationMin: 35, name: "Easy"},
        ]),
        restingHr: 48,
      }),
      metric({date: "2026-09-18", workoutsJson: JSON.stringify([{type: "Ride", distanceMi: 12, durationMin: 40, name: "Ride"}])}),
    ]);
    assert.equal(summary.hasData, true);
    assert.equal(summary.weekMiles, 27);
    assert.equal(summary.longRunMiles, 12);
    assert.equal(summary.workoutCount, 3);
    assert.equal(summary.avgRestingHr, 48);
  });

  it("reports no data when empty", () => {
    const summary = summarizeMetrics([]);
    assert.equal(summary.hasData, false);
    assert.equal(summary.weekMiles, 0);
  });
});

describe("recovery recommendations (rule-based v1)", () => {
  it("recommends massage + stretch on a big week", () => {
    const rec = recommendRecovery({
      hasData: true, weekMiles: 32, longRunMiles: 12, workoutCount: 5,
      sources: ["strava"], avgRestingHr: null, avgSleepHours: null,
    });
    assert.ok(rec);
    assert.equal(rec!.level, "high");
    assert.ok(rec!.services.includes("Sports Massage"));
    assert.ok(rec!.services.includes("Assisted Stretching"));
  });

  it("recommends stretch on a moderate week", () => {
    const rec = recommendRecovery({
      hasData: true, weekMiles: 12, longRunMiles: 5, workoutCount: 4,
      sources: ["strava"], avgRestingHr: null, avgSleepHours: null,
    });
    assert.ok(rec);
    assert.equal(rec!.level, "moderate");
    assert.deepEqual(rec!.services, ["Assisted Stretching"]);
  });

  it("stays quiet on a light week or no data", () => {
    assert.equal(
      recommendRecovery({hasData: true, weekMiles: 6, longRunMiles: 3, workoutCount: 2, sources: ["strava"], avgRestingHr: null, avgSleepHours: null}),
      null,
    );
    assert.equal(
      recommendRecovery({hasData: false, weekMiles: 0, longRunMiles: 0, workoutCount: 0, sources: [], avgRestingHr: null, avgSleepHours: null}),
      null,
    );
  });
});

describe("apple ingest validation", () => {
  it("accepts a well-formed payload", () => {
    const result = validateApplePayload({
      date: "2026-09-20",
      workouts: [{type: "Run", distanceMi: 6, durationMin: 45}],
      steps: 10234,
      sleepHours: 7.5,
      restingHr: 47,
      hrvMs: 62,
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.steps, 10234);
  });

  it("rejects a bad date", () => {
    const result = validateApplePayload({date: "yesterday"});
    assert.equal(result.ok, false);
  });

  it("rejects negative numbers", () => {
    const result = validateApplePayload({date: "2026-09-20", sleepHours: -2});
    assert.equal(result.ok, false);
  });

  it("caps workout count", () => {
    const workouts = Array.from({length: 100}, (_, i) => ({type: "Run", name: `w${i}`}));
    const result = validateApplePayload({date: "2026-09-20", workouts});
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.workouts!.length, 50);
  });
});

describe("strava env", () => {
  it("reports not-ready without keys", () => {
    assert.equal(isStravaReady({}), false);
    const report = stravaConfigReport({});
    assert.equal(report.ready, false);
    assert.deepEqual(report.missingRequired, ["STRAVA_CLIENT_ID", "STRAVA_CLIENT_SECRET"]);
  });

  it("reports ready with keys", () => {
    const env = {STRAVA_CLIENT_ID: "1", STRAVA_CLIENT_SECRET: "s"};
    assert.equal(isStravaReady(env), true);
    assert.equal(stravaConfigReport(env).ready, true);
  });
});

describe("strava oauth state persistence (D1-backed)", () => {
  const stravaEnv = {STRAVA_CLIENT_ID: "1", STRAVA_CLIENT_SECRET: "s"};
  const tokenJson = {
    access_token: "at_9",
    refresh_token: "rt_9",
    expires_at: 1900000000,
    athlete: {id: 4242},
    scope: "read,activity:read_all",
  };
  const okFetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/oauth/token")) return new Response(JSON.stringify(tokenJson), {status: 200});
    return new Response("[]", {status: 200});
  }) as unknown as typeof fetch;

  let proxyDb: SqliteRemoteDatabase<Record<string, never>>;

  before(() => {
    // In-memory SQLite behind drizzle's sqlite-proxy, standing in for D1.
    const sqlite = new DatabaseSync(":memory:");
    proxyDb = drizzle(async (sqlText: string, params: unknown[], method: "run" | "all" | "values" | "get") => {
      const stmt = sqlite.prepare(sqlText);
      if (method === "run") {
        stmt.run(...(params as unknown[]));
        return {rows: []};
      }
      return {rows: stmt.all(...(params as unknown[])) as unknown[]};
    });
    __injectHealthDbForTests(proxyDb as unknown as Db);
  });

  after(() => {
    __injectHealthDbForTests(null);
  });

  const future = () => new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const past = () => new Date(Date.now() - 60 * 1000).toISOString();

  it("round-trips state through the DB", async () => {
    const {state, url} = await buildStravaAuthorize({id: "member_1"}, "https://x.com", stravaEnv);
    assert.ok(state.length >= 32, "state should be a random token");
    assert.equal(new URL(url).searchParams.get("state"), state);
    const consumed = await consumeStravaOAuthState(state);
    assert.equal(consumed?.memberId, "member_1");
    assert.equal(consumed?.redirectUri, "https://x.com/api/health/strava/callback");
  });

  it("rejects expired states", async () => {
    const ok = await storeStravaOAuthState({state: "oauth_expired_1", memberId: "member_1", expiresAt: past()});
    assert.equal(ok, true);
    assert.equal(await consumeStravaOAuthState("oauth_expired_1"), null);
  });

  it("rejects replay of a consumed state", async () => {
    const ok = await storeStravaOAuthState({state: "oauth_replay_1", memberId: "member_1", expiresAt: future()});
    assert.equal(ok, true);
    assert.equal((await consumeStravaOAuthState("oauth_replay_1"))?.memberId, "member_1");
    assert.equal(await consumeStravaOAuthState("oauth_replay_1"), null);
  });

  it("rejects a state issued for a different member", async () => {
    const {state} = await buildStravaAuthorize({id: "member_1"}, "https://x.com", stravaEnv);
    await assert.rejects(
      () => completeStravaCallback({code: "c", state, member: {id: "member_2"}}, "https://x.com", stravaEnv, okFetch),
      (err: unknown) => err instanceof HealthError && err.status === 400,
    );
  });

  it("missing state fails with a clean 400, not a 500", async () => {
    await assert.rejects(
      () => completeStravaCallback({code: "c", state: "no_such_state"}, "https://x.com", stravaEnv, okFetch),
      (err: unknown) => {
        assert.ok(err instanceof HealthError, `expected HealthError, got ${err}`);
        assert.equal((err as HealthError).status, 400);
        return true;
      },
    );
    await assert.rejects(
      () => completeStravaCallback({code: "c", state: ""}, "https://x.com", stravaEnv, okFetch),
      (err: unknown) => err instanceof HealthError && (err as HealthError).status === 400,
    );
  });

  it("completes the full authorize → callback round trip and blocks replay", async () => {
    const {state} = await buildStravaAuthorize({id: "member_9"}, "https://x.com", stravaEnv);
    const result = await completeStravaCallback(
      {code: "authcode", state, member: {id: "member_9"}},
      "https://x.com",
      stravaEnv,
      okFetch,
    );
    assert.equal(result.syncedDays, 0);
    const account = await getHealthAccount("member_9", "strava");
    assert.equal(account?.accessToken, "at_9");
    assert.equal(account?.refreshToken, "rt_9");
    // The state was consumed: replaying it must fail with 400, not silently re-exchange.
    await assert.rejects(
      () => completeStravaCallback({code: "authcode", state, member: {id: "member_9"}}, "https://x.com", stravaEnv, okFetch),
      (err: unknown) => err instanceof HealthError && (err as HealthError).status === 400,
    );
  });

  it("prunes expired rows on write so the table does not grow unboundedly", async () => {
    await proxyDb.run(sql.raw(
      `INSERT INTO strava_oauth_states (state, member_id, created_at, expires_at)
       VALUES ('prune_me', 'member_1', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
    ));
    const ok = await storeStravaOAuthState({state: "prune_trigger", memberId: "member_1", expiresAt: future()});
    assert.equal(ok, true);
    const rows = await proxyDb.all<{state: string}>(sql.raw(
      `SELECT state FROM strava_oauth_states WHERE state IN ('prune_me', 'prune_trigger')`,
    ));
    assert.deepEqual(rows.map((r) => r.state), ["prune_trigger"]);
  });
});

import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {
  aggregateActivitiesToDays,
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

/**
 * Minimal Strava OAuth + activity client.
 * Privacy: only activity id/name/type/distance/duration/start are kept.
 * Tokens and raw payloads are never logged.
 */

export type StravaTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  athleteId: string;
  scopes: string;
};

export type StravaActivity = {
  id: string;
  name: string;
  type: string;
  distanceMi: number;
  durationMin: number;
  startDate: string;
};

type FetchFn = typeof fetch;

const AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const TOKEN_URL = "https://www.strava.com/oauth/token";
const ACTIVITIES_URL = "https://www.strava.com/api/v3/athlete/activities";

export function stravaAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    approval_prompt: "auto",
    scope: args.scopes ?? "read,activity:read_all",
    state: args.state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function postToken(body: Record<string, string>, fetchFn: FetchFn): Promise<StravaTokens> {
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Strava token request failed (${res.status}).`);
  }
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    athlete?: {id?: number | string};
    scope?: string;
  };
  if (!data.access_token || !data.refresh_token) {
    throw new Error("Strava did not return tokens.");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date((data.expires_at ?? 0) * 1000).toISOString(),
    athleteId: String(data.athlete?.id ?? ""),
    scopes: data.scope ?? "",
  };
}

export function exchangeStravaCode(
  args: {clientId: string; clientSecret: string; code: string; redirectUri: string},
  fetchFn: FetchFn = fetch,
): Promise<StravaTokens> {
  return postToken(
    {
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      grant_type: "authorization_code",
    },
    fetchFn,
  );
}

export function refreshStravaToken(
  args: {clientId: string; clientSecret: string; refreshToken: string},
  fetchFn: FetchFn = fetch,
): Promise<StravaTokens> {
  return postToken(
    {
      client_id: args.clientId,
      client_secret: args.clientSecret,
      refresh_token: args.refreshToken,
      grant_type: "refresh_token",
    },
    fetchFn,
  );
}

export async function fetchStravaActivities(
  accessToken: string,
  fetchFn: FetchFn = fetch,
  perPage = 30,
): Promise<StravaActivity[]> {
  const res = await fetchFn(`${ACTIVITIES_URL}?per_page=${perPage}`, {
    headers: {Authorization: `Bearer ${accessToken}`},
  });
  if (!res.ok) {
    throw new Error(`Strava activities request failed (${res.status}).`);
  }
  const data = (await res.json()) as Array<{
    id?: number | string;
    name?: string;
    type?: string;
    distance?: number;
    moving_time?: number;
    start_date_local?: string;
  }>;
  if (!Array.isArray(data)) return [];
  return data.map((activity) => ({
    id: String(activity.id ?? ""),
    name: typeof activity.name === "string" ? activity.name.slice(0, 120) : "Workout",
    type: typeof activity.type === "string" ? activity.type : "Workout",
    distanceMi: Math.round(((activity.distance ?? 0) / 1609.344) * 100) / 100,
    durationMin: Math.round((activity.moving_time ?? 0) / 60),
    startDate: typeof activity.start_date_local === "string" ? activity.start_date_local : "",
  }));
}

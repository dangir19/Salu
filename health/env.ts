export type StravaEnv = {
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
};

export function readStravaEnv(source: Record<string, string | undefined>): StravaEnv {
  return {
    STRAVA_CLIENT_ID: source.STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET: source.STRAVA_CLIENT_SECRET,
  };
}

export function isStravaReady(env: StravaEnv): boolean {
  return Boolean(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET);
}

export type StravaConfigItem = {
  key: string;
  label: string;
  required: boolean;
  configured: boolean;
  where: string;
  example: string;
};

export function stravaConfigReport(env: StravaEnv): {
  ready: boolean;
  missingRequired: string[];
  items: StravaConfigItem[];
} {
  const items: StravaConfigItem[] = [
    {
      key: "STRAVA_CLIENT_ID",
      label: "Strava API application client ID",
      required: true,
      configured: Boolean(env.STRAVA_CLIENT_ID),
      where: "strava.com/settings/api (your application's Client ID)",
      example: "123456",
    },
    {
      key: "STRAVA_CLIENT_SECRET",
      label: "Strava API client secret",
      required: true,
      configured: Boolean(env.STRAVA_CLIENT_SECRET),
      where: "strava.com/settings/api (click show next to Client Secret)",
      example: "abc123… (hex string)",
    },
  ];
  const missingRequired = items.filter((item) => item.required && !item.configured).map((item) => item.key);
  return {ready: missingRequired.length === 0, missingRequired, items};
}

export const STRAVA_ENV_TEMPLATE = [
  "STRAVA_CLIENT_ID=paste_client_id_here",
  "STRAVA_CLIENT_SECRET=paste_client_secret_here",
].join("\n");

export const DEV_AUTH_SECRET = "salu-dev-auth-secret-not-for-production-32b";

export type AuthProviderId = "google" | "apple" | "chatgpt" | "development";

export type AuthEnv = {
  AUTH_SECRET: string;
  AUTH_URL: string;
  AUTH_GOOGLE_ID: string;
  AUTH_GOOGLE_SECRET: string;
  AUTH_APPLE_ID: string;
  AUTH_APPLE_SECRET: string;
  AUTH_APPLE_TEAM_ID: string;
  AUTH_APPLE_KEY_ID: string;
  AUTH_APPLE_PRIVATE_KEY: string;
  nodeEnv: string;
  allowDevBypass: boolean;
};

export type AuthSurface = {
  google: boolean;
  apple: boolean;
  development: boolean;
  secretIsStub: boolean;
};

type EnvRecord = Record<string, string | undefined>;

function readValue(sources: EnvRecord[], key: string): string {
  for (const source of sources) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function tryCloudflareEnv(): EnvRecord {
  const fromGlobal = (globalThis as { process?: { env?: EnvRecord } }).process?.env;
  return fromGlobal ?? {};
}

export function isProductionEnv(nodeEnv?: string): boolean {
  return nodeEnv === "production";
}

export function isDevBypassAllowed(env: Pick<AuthEnv, "nodeEnv">): boolean {
  return !isProductionEnv(env.nodeEnv);
}

export function readAuthEnv(overrides: EnvRecord = {}): AuthEnv {
  const sources = [overrides, tryCloudflareEnv()];
  const nodeEnv = readValue(sources, "NODE_ENV") || process.env.NODE_ENV || "development";
  const appleKey = readValue(sources, "AUTH_APPLE_PRIVATE_KEY").replace(/\\n/g, "\n");

  return {
    AUTH_SECRET: readValue(sources, "AUTH_SECRET") || DEV_AUTH_SECRET,
    AUTH_URL: readValue(sources, "AUTH_URL") || readValue(sources, "AUTH_TRUST_HOST_URL"),
    AUTH_GOOGLE_ID:
      readValue(sources, "AUTH_GOOGLE_ID") || readValue(sources, "GOOGLE_CLIENT_ID"),
    AUTH_GOOGLE_SECRET:
      readValue(sources, "AUTH_GOOGLE_SECRET") || readValue(sources, "GOOGLE_CLIENT_SECRET"),
    AUTH_APPLE_ID:
      readValue(sources, "AUTH_APPLE_ID") || readValue(sources, "APPLE_CLIENT_ID"),
    AUTH_APPLE_SECRET:
      readValue(sources, "AUTH_APPLE_SECRET") || readValue(sources, "APPLE_CLIENT_SECRET"),
    AUTH_APPLE_TEAM_ID: readValue(sources, "AUTH_APPLE_TEAM_ID"),
    AUTH_APPLE_KEY_ID: readValue(sources, "AUTH_APPLE_KEY_ID"),
    AUTH_APPLE_PRIVATE_KEY: appleKey,
    nodeEnv,
    allowDevBypass: isDevBypassAllowed({ nodeEnv }),
  };
}

export function authSurface(env: AuthEnv = readAuthEnv()): AuthSurface {
  const appleSecretReady = Boolean(
    env.AUTH_APPLE_SECRET ||
      (env.AUTH_APPLE_TEAM_ID && env.AUTH_APPLE_KEY_ID && env.AUTH_APPLE_PRIVATE_KEY),
  );

  return {
    google: Boolean(env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET),
    apple: Boolean(env.AUTH_APPLE_ID && appleSecretReady),
    development: env.allowDevBypass,
    secretIsStub: env.AUTH_SECRET === DEV_AUTH_SECRET,
  };
}

export function applyAuthEnvToProcess(env: AuthEnv): void {
  process.env.AUTH_SECRET = env.AUTH_SECRET;
  process.env.AUTH_URL = env.AUTH_URL || process.env.AUTH_URL || "";
  process.env.AUTH_GOOGLE_ID = env.AUTH_GOOGLE_ID;
  process.env.AUTH_GOOGLE_SECRET = env.AUTH_GOOGLE_SECRET;
  process.env.AUTH_APPLE_ID = env.AUTH_APPLE_ID;
  process.env.AUTH_APPLE_SECRET = env.AUTH_APPLE_SECRET;
  process.env.AUTH_TRUST_HOST = "true";
}

export function usesSecureCookies(env: AuthEnv, requestUrl?: string): boolean {
  const url = env.AUTH_URL || requestUrl || "";
  return url.startsWith("https://");
}

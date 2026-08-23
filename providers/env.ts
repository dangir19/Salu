import {isProductionEnv} from "../auth/env";
import {normalizeEmail, parseProviderEmails} from "../provider/catalog";

type EnvRecord = Record<string, string | undefined>;

/** Labeled local review only. Production never treats this as staff. */
export const DEMO_ADMIN_EMAIL = "admin@localhost";

function readValue(sources: EnvRecord[], key: string): string {
  for (const source of sources) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function tryProcessEnv(): EnvRecord {
  return (globalThis as {process?: {env?: EnvRecord}}).process?.env ?? {};
}

function nodeEnv(overrides: EnvRecord = {}): string {
  return readValue([overrides, tryProcessEnv()], "NODE_ENV") || tryProcessEnv().NODE_ENV || "development";
}

export function readOpsSecret(overrides: EnvRecord = {}): string {
  return readValue([overrides, tryProcessEnv()], "SALU_OPS_SECRET");
}

export function readAdminEmails(overrides: EnvRecord = {}): string[] {
  return parseProviderEmails(readValue([overrides, tryProcessEnv()], "SALU_ADMIN_EMAILS"));
}

export function isDemoAdminEmail(email: string, overrides: EnvRecord = {}): boolean {
  if (isProductionEnv(nodeEnv(overrides))) return false;
  return normalizeEmail(email) === DEMO_ADMIN_EMAIL;
}

export function isAdminEmail(email: string, overrides: EnvRecord = {}): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  if (readAdminEmails(overrides).includes(normalized)) return true;
  return isDemoAdminEmail(normalized, overrides);
}

export function opsAuthorized(request: Request, overrides: EnvRecord = {}): {ok: boolean; open: boolean} {
  const secret = readOpsSecret(overrides);
  if (!secret) return {ok: true, open: true};
  const header = request.headers.get("x-salu-ops")?.trim() ?? "";
  return {ok: header === secret, open: false};
}

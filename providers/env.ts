type EnvRecord = Record<string, string | undefined>;

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

export function readOpsSecret(overrides: EnvRecord = {}): string {
  return readValue([overrides, tryProcessEnv()], "SALU_OPS_SECRET");
}

export function opsAuthorized(request: Request, overrides: EnvRecord = {}): {ok: boolean; open: boolean} {
  const secret = readOpsSecret(overrides);
  if (!secret) return {ok: true, open: true};
  const header = request.headers.get("x-salu-ops")?.trim() ?? "";
  return {ok: header === secret, open: false};
}

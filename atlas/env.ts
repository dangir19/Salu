type EnvRecord = Record<string, string | undefined>;

function tryProcessEnv(): EnvRecord {
  return (globalThis as {process?: {env?: EnvRecord}}).process?.env ?? {};
}

function readValue(sources: EnvRecord[], key: string): string {
  for (const source of sources) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export type AtlasEnv = {
  OPENAI_API_KEY: string;
  OPENAI_MODEL: string;
};

export function readAtlasEnv(overrides: EnvRecord = {}): AtlasEnv {
  const sources = [overrides, tryProcessEnv()];
  return {
    OPENAI_API_KEY: readValue(sources, "OPENAI_API_KEY"),
    OPENAI_MODEL: readValue(sources, "OPENAI_MODEL") || "gpt-4o-mini",
  };
}

export function isOpenAIReady(env: AtlasEnv = readAtlasEnv()): boolean {
  return Boolean(env.OPENAI_API_KEY);
}

export function applyAtlasEnvToProcess(env: AtlasEnv): void {
  process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;
  process.env.OPENAI_MODEL = env.OPENAI_MODEL;
}

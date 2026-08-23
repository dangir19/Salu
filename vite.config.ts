import vinext from "vinext";
import { readFile } from "node:fs/promises";
import { defineConfig, type PluginOption } from "vite";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const isCi = process.env.CI === "true";
const useSitesPlugin =
  process.env.SALU_ENABLE_SITES === "1" ||
  (!isCi && process.env.SALU_ENABLE_SITES !== "0");

function stripJsonc(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function localAuthVars() {
  return {
    AUTH_SECRET:
      process.env.AUTH_SECRET ?? "salu-dev-auth-secret-not-for-production-32b",
    AUTH_URL: process.env.AUTH_URL ?? "",
    AUTH_GOOGLE_ID:
      process.env.AUTH_GOOGLE_ID ?? process.env.GOOGLE_CLIENT_ID ?? "",
    AUTH_GOOGLE_SECRET:
      process.env.AUTH_GOOGLE_SECRET ?? process.env.GOOGLE_CLIENT_SECRET ?? "",
    AUTH_APPLE_ID:
      process.env.AUTH_APPLE_ID ?? process.env.APPLE_CLIENT_ID ?? "",
    AUTH_APPLE_SECRET:
      process.env.AUTH_APPLE_SECRET ?? process.env.APPLE_CLIENT_SECRET ?? "",
    AUTH_APPLE_TEAM_ID: process.env.AUTH_APPLE_TEAM_ID ?? "",
    AUTH_APPLE_KEY_ID: process.env.AUTH_APPLE_KEY_ID ?? "",
    AUTH_APPLE_PRIVATE_KEY: process.env.AUTH_APPLE_PRIVATE_KEY ?? "",
  };
}

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  const plugins: PluginOption[] = [vinext()];

  if (useSitesPlugin) {
    const { sites } = await import("./build/sites-vite-plugin");
    plugins.push(sites());
  }

  // CI/production reads wrangler.jsonc as-is (no Sites credentials, no stub
  // AUTH_SECRET baked into the deployed Worker). Local / Codex merge auth
  // stubs and optional Sites D1/R2 placeholders on top of the same file.
  let pluginConfig: Record<string, unknown> | undefined;
  if (!isCi) {
    const raw = await readFile(new URL("./wrangler.jsonc", import.meta.url), "utf8");
    const base = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
    let d1: string | null = null;
    let r2: string | null = null;
    if (useSitesPlugin) {
      const hostingConfig = (await import("./.openai/hosting.json")).default;
      d1 = hostingConfig.d1;
      r2 = hostingConfig.r2;
    }
    pluginConfig = {
      ...base,
      vars: {
        ...((base.vars as Record<string, string> | undefined) ?? {}),
        ...localAuthVars(),
      },
      d1_databases: d1
        ? [
            {
              binding: d1,
              database_name: "site-creator-d1",
              database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
            },
          ]
        : ((base.d1_databases as unknown[] | undefined) ?? []),
      r2_buckets: r2
        ? [
            {
              binding: r2,
              bucket_name: "site-creator-r2",
            },
          ]
        : ((base.r2_buckets as unknown[] | undefined) ?? []),
    };
  }

  plugins.push(
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      ...(pluginConfig ? { config: pluginConfig } : {}),
    }),
  );

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins,
  };
});

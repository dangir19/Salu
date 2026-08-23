import {importPKCS8, SignJWT} from "jose";
import type {AuthEnv} from "./env";

export async function appleClientSecret(env: AuthEnv): Promise<string | undefined> {
  if (env.AUTH_APPLE_SECRET) return env.AUTH_APPLE_SECRET;
  if (!env.AUTH_APPLE_ID || !env.AUTH_APPLE_TEAM_ID || !env.AUTH_APPLE_KEY_ID || !env.AUTH_APPLE_PRIVATE_KEY) {
    return undefined;
  }

  const key = await importPKCS8(env.AUTH_APPLE_PRIVATE_KEY, "ES256");
  return new SignJWT({})
    .setAudience("https://appleid.apple.com")
    .setIssuer(env.AUTH_APPLE_TEAM_ID)
    .setIssuedAt()
    .setExpirationTime("180d")
    .setSubject(env.AUTH_APPLE_ID)
    .setProtectedHeader({alg: "ES256", kid: env.AUTH_APPLE_KEY_ID})
    .sign(key);
}

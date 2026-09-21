import test from "node:test";
import assert from "node:assert/strict";
import {createAuthConfig} from "../auth/config.ts";
import {
  registerNativeAccount,
  resetCredentialMemory,
  verifyNativeLogin,
} from "../auth/credentials.ts";
import {DEV_AUTH_SECRET, readAuthEnv} from "../auth/env.ts";
import {handleAuthFetch} from "../auth/handlers.ts";
import {memberFromIdentity} from "../auth/identity.ts";
import {resetMemberMemory, upsertMemberRecord} from "../auth/members.ts";
import {hashPassword, normalizeEmail, validatePassword, verifyPassword} from "../auth/password.ts";
import {resetRateLimits} from "../auth/rate-limit.ts";

function resetNativeAuth() {
  resetCredentialMemory();
  resetMemberMemory();
  resetRateLimits();
}

test("hashes passwords with WebCrypto PBKDF2 and verifies them", async () => {
  const encoded = await hashPassword("harbor-light-22");
  assert.match(encoded, /^pbkdf2-sha256\$100000\$/);
  assert.equal(await verifyPassword("harbor-light-22", encoded), true);
  assert.equal(await verifyPassword("wrong-password", encoded), false);
  assert.equal(normalizeEmail("  Ava@JoinSalu.com "), "ava@joinsalu.com");
  assert.match(validatePassword("short") ?? "", /at least 8/);
  assert.equal(validatePassword("long-enough"), null);
});

test("registers and signs in a native member without Google or Apple", async () => {
  resetNativeAuth();
  const created = await registerNativeAccount({
    email: "Ava@joinsalu.com",
    password: "harbor-light-22",
    displayName: "Ava Ruiz",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.member.email, "ava@joinsalu.com");
  assert.equal(created.member.displayName, "Ava Ruiz");
  assert.equal(created.member.authProvider, "credentials");

  const signedIn = await verifyNativeLogin("AVA@joinsalu.com", "harbor-light-22");
  assert.ok(signedIn);
  assert.equal(signedIn?.id, created.member.id);
  assert.equal(await verifyNativeLogin("ava@joinsalu.com", "wrong-password"), null);
  assert.equal(await verifyNativeLogin("missing@joinsalu.com", "harbor-light-22"), null);
});

test("keeps register errors from confirming that an email exists", async () => {
  resetNativeAuth();
  const first = await registerNativeAccount({
    email: "ava@joinsalu.com",
    password: "harbor-light-22",
    displayName: "Ava Ruiz",
  });
  assert.equal(first.ok, true);

  const again = await registerNativeAccount({
    email: "ava@joinsalu.com",
    password: "another-pass-99",
    displayName: "Ava Two",
  });
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.status, 409);
  assert.doesNotMatch(again.error, /already|exists|taken/i);

  await upsertMemberRecord(
    memberFromIdentity({
      email: "google-only@joinsalu.com",
      name: "Google Only",
      provider: "google",
    }),
  );
  const oauth = await registerNativeAccount({
    email: "google-only@joinsalu.com",
    password: "harbor-light-22",
    displayName: "Google Only",
  });
  assert.equal(oauth.ok, false);
  if (oauth.ok) return;
  assert.equal(oauth.error, again.error);
});

test("keeps the credentials provider in production and hides the local preview", async () => {
  const env = readAuthEnv({NODE_ENV: "production", AUTH_SECRET: DEV_AUTH_SECRET});
  const config = await createAuthConfig(env);
  const ids = config.providers.map((provider) => {
    if (typeof provider === "function") return provider({}).id;
    return provider.id;
  });
  assert.ok(ids.includes("credentials"));
  assert.ok(!ids.includes("development"));
  assert.ok(!ids.includes("provider-development"));
  assert.ok(!ids.includes("admin-development"));
});

test("register, login, and /api/me share the Auth.js JWT session", async () => {
  resetNativeAuth();
  const origin = "http://localhost:5173";
  const runtime = {NODE_ENV: "test", AUTH_SECRET: DEV_AUTH_SECRET, AUTH_URL: origin};

  const register = await handleAuthFetch(
    new Request(`${origin}/api/auth/register`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        email: "Ava@joinsalu.com",
        password: "harbor-light-22",
        displayName: "Ava Ruiz",
      }),
    }),
    runtime,
  );
  assert.equal(register.status, 200);
  assert.deepEqual(await register.json(), {ok: true});

  const csrfRes = await handleAuthFetch(new Request(`${origin}/api/auth/csrf`), runtime);
  assert.equal(csrfRes.status, 200);
  const {csrfToken} = (await csrfRes.json()) as {csrfToken?: string};
  assert.ok(csrfToken);
  const jar = collectCookies(csrfRes);

  const login = await handleAuthFetch(
    new Request(`${origin}/api/auth/callback/credentials`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader(jar),
      },
      body: new URLSearchParams({
        csrfToken,
        email: "ava@joinsalu.com",
        password: "harbor-light-22",
        callbackUrl: `${origin}/`,
      }),
      redirect: "manual",
    }),
    runtime,
  );
  collectCookies(login, jar);
  assert.ok(
    [...jar.keys()].some((name) => name.includes("session-token")),
    `expected a session cookie, got ${[...jar.keys()].join(", ")} status=${login.status}`,
  );

  const me = await handleAuthFetch(
    new Request(`${origin}/api/me`, {headers: {cookie: cookieHeader(jar)}}),
    runtime,
  );
  const payload = (await me.json()) as {
    member: {member: {email: string; displayName: string}; source: string} | null;
  };
  assert.equal(payload.member?.member.email, "ava@joinsalu.com");
  assert.equal(payload.member?.member.displayName, "Ava Ruiz");
  assert.equal(payload.member?.source, "credentials");
});

function collectCookies(response: Response, jar = new Map<string, string>()) {
  const lines = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const line of lines) {
    const pair = line.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  return jar;
}

function cookieHeader(jar: Map<string, string>) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

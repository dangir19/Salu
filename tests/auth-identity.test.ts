import test from "node:test";
import assert from "node:assert/strict";
import {authSurface, DEV_AUTH_SECRET, isDevBypassAllowed, readAuthEnv} from "../auth/env.ts";
import {
  displayNameFromProfile,
  memberFromIdentity,
  memberInitials,
  membershipSinceLabel,
} from "../auth/identity.ts";

test("reads stub secrets and hides Google/Apple until env is set", () => {
  const env = readAuthEnv({
    NODE_ENV: "test",
    AUTH_SECRET: DEV_AUTH_SECRET,
  });
  const surface = authSurface(env);
  assert.equal(env.AUTH_SECRET, DEV_AUTH_SECRET);
  assert.equal(surface.google, false);
  assert.equal(surface.apple, false);
  assert.equal(surface.development, true);
  assert.equal(surface.secretIsStub, true);
});

test("treats configured provider env as ready without calling OAuth", () => {
  const env = readAuthEnv({
    NODE_ENV: "test",
    AUTH_GOOGLE_ID: "google-client.apps.googleusercontent.com",
    AUTH_GOOGLE_SECRET: "google-secret",
    AUTH_APPLE_ID: "com.joinsalu.web",
    AUTH_APPLE_SECRET: "apple-jwt-secret",
  });
  const surface = authSurface(env);
  assert.equal(surface.google, true);
  assert.equal(surface.apple, true);
});

test("hides the development bypass in production builds", () => {
  const env = readAuthEnv({NODE_ENV: "production", AUTH_SECRET: DEV_AUTH_SECRET});
  assert.equal(isDevBypassAllowed(env), false);
  assert.equal(authSurface(env).development, false);
});

test("maps provider profiles onto Member initials and names", () => {
  assert.equal(memberInitials("Daniel Giron"), "DG");
  assert.equal(memberInitials("Local Preview"), "LP");
  assert.equal(memberInitials("Salu"), "SA");
  assert.equal(displayNameFromProfile({email: "ava@joinsalu.com"}), "ava");
  const member = memberFromIdentity({
    email: "ava@joinsalu.com",
    name: "Ava Ruiz",
    provider: "google",
  });
  assert.equal(member.displayName, "Ava Ruiz");
  assert.equal(member.planId, "member");
  assert.equal(member.authProvider, "google");
  assert.ok(member.householdId?.startsWith("hh_"));
  assert.equal(membershipSinceLabel("2026-08-23T12:00:00.000Z"), "August 2026");
});

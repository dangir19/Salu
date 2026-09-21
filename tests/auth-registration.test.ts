import test from "node:test";
import assert from "node:assert/strict";
import {
  registerNativeAccount,
  resetCredentialMemory,
  verifyNativeLogin,
} from "../auth/credentials.ts";
import {memberFromIdentity} from "../auth/identity.ts";
import {findMemberRecord, resetMemberMemory, upsertMemberRecord} from "../auth/members.ts";
import {verifyPassword} from "../auth/password.ts";
import {resetRateLimits} from "../auth/rate-limit.ts";

function resetNativeAuth() {
  resetCredentialMemory();
  resetMemberMemory();
  resetRateLimits();
}

// Simulates WebCrypto rejecting the KDF (e.g. the Workers 100k PBKDF2
// iteration cap) by swapping crypto.subtle for one whose deriveBits throws.
// Restores the real implementation afterwards.
async function withBrokenKdf(fn: () => Promise<void>): Promise<void> {
  const realCrypto = globalThis.crypto;
  const realSubtle = realCrypto.subtle;
  const broken = {
    importKey: realSubtle.importKey.bind(realSubtle),
    deriveBits: async (): Promise<ArrayBuffer> => {
      throw new Error("simulated WebCrypto rejection");
    },
  };
  Object.defineProperty(realCrypto, "subtle", {value: broken, configurable: true});
  try {
    await fn();
  } finally {
    delete (realCrypto as {subtle?: unknown}).subtle;
  }
}

test("hashing failure leaves no partial member row and retry is not a dead end", async () => {
  resetNativeAuth();
  const email = "kdf-fail@joinsalu.com";

  await withBrokenKdf(async () => {
    await assert.rejects(
      () =>
        registerNativeAccount({
          email,
          password: "harbor-light-22",
          displayName: "Kdf Fail",
        }),
      /simulated WebCrypto rejection/,
    );
  });

  // No member row may exist: the old hash-after-insert ordering left an orphan
  // that 409'd forever on retry.
  assert.equal(await findMemberRecord({email}), null);

  // Retry with a working KDF succeeds instead of hitting the duplicate guard.
  const retry = await registerNativeAccount({
    email,
    password: "harbor-light-22",
    displayName: "Kdf Fail",
  });
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.member.authProvider, "credentials");
  assert.ok(await verifyNativeLogin(email, "harbor-light-22"));
});

test("re-registering an orphaned credentials member repairs it instead of 409", async () => {
  resetNativeAuth();
  const email = "orphan@joinsalu.com";

  // Orphan: member row exists (e.g. from this morning's incident) but the
  // credential row never landed.
  const orphan = await upsertMemberRecord(
    memberFromIdentity({email, name: "Orphan Old", provider: "credentials"}),
  );
  assert.equal(orphan.authProvider, "credentials");
  assert.equal(await verifyNativeLogin(email, "harbor-light-22"), null);

  const repaired = await registerNativeAccount({
    email,
    password: "harbor-light-22",
    displayName: "Orphan New",
  });
  assert.equal(repaired.ok, true);
  if (!repaired.ok) return;

  // Same member row, not a duplicate; display name refreshes; provider stays.
  assert.equal(repaired.member.id, orphan.id);
  assert.equal(repaired.member.authProvider, "credentials");
  assert.equal(repaired.member.displayName, "Orphan New");
  assert.equal(await findMemberRecord({email}), repaired.member);

  const signedIn = await verifyNativeLogin(email, "harbor-light-22");
  assert.ok(signedIn);
  assert.equal(signedIn?.id, orphan.id);
  assert.equal(await verifyNativeLogin(email, "wrong-password"), null);
});

test("credentials registration cannot claim an OAuth-only account", async () => {
  resetNativeAuth();

  for (const provider of ["google", "apple"] as const) {
    const email = `${provider}-only@joinsalu.com`;
    const oauthMember = await upsertMemberRecord(
      memberFromIdentity({email, name: "OAuth Only", provider}),
    );
    assert.equal(oauthMember.authProvider, provider);

    const attempt = await registerNativeAccount({
      email,
      password: "harbor-light-22",
      displayName: "OAuth Only",
    });
    assert.equal(attempt.ok, false);
    if (attempt.ok) continue;
    assert.equal(attempt.status, 409);
    assert.doesNotMatch(attempt.error, /already|exists|taken/i);

    // The OAuth member is untouched and still has no password credential.
    const untouched = await findMemberRecord({email});
    assert.equal(untouched?.authProvider, provider);
    assert.equal(await verifyNativeLogin(email, "harbor-light-22"), null);
  }
});

test("normal register then verify still passes", async () => {
  resetNativeAuth();
  const created = await registerNativeAccount({
    email: "normal@joinsalu.com",
    password: "harbor-light-22",
    displayName: "Normal Flow",
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.member.authProvider, "credentials");

  const signedIn = await verifyNativeLogin("normal@joinsalu.com", "harbor-light-22");
  assert.ok(signedIn);
  assert.equal(signedIn?.id, created.member.id);

  const duplicate = await registerNativeAccount({
    email: "normal@joinsalu.com",
    password: "another-pass-99",
    displayName: "Normal Again",
  });
  assert.equal(duplicate.ok, false);
  if (duplicate.ok) return;
  assert.equal(duplicate.status, 409);
});

test("password verification fails closed when WebCrypto rejects a stored hash", async () => {
  // Malformed encodings never verify and never throw.
  assert.equal(await verifyPassword("harbor-light-22", "not-a-hash"), false);
  assert.equal(await verifyPassword("harbor-light-22", "pbkdf2-sha256$abc$AAAA$BBBB"), false);

  // A well-formed hash the KDF rejects (the stored 210k-iteration shape from
  // the incident would do this on Workers) also fails closed, not open.
  await withBrokenKdf(async () => {
    assert.equal(
      await verifyPassword(
        "harbor-light-22",
        "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      ),
      false,
    );
  });
});

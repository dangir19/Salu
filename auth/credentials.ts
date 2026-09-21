import type {Member} from "../domain/types";
import {memberFromIdentity} from "./identity";
import {findMemberRecord, upsertMemberRecord} from "./members";
import {
  hashPassword,
  normalizeEmail,
  validateDisplayName,
  validateEmail,
  validatePassword,
  verifyPassword,
} from "./password";
import {consumeRateLimit} from "./rate-limit";

export type StoredCredential = {
  email: string;
  memberId: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
};

export type NativeAccountError = {
  ok: false;
  error: string;
  status: number;
};

export type NativeAccountSuccess = {
  ok: true;
  member: Member;
};

const memory = new Map<string, StoredCredential>();
let dummyHashPromise: Promise<string> | null = null;

export function resetCredentialMemory(): void {
  memory.clear();
}

export async function registerNativeAccount(input: {
  email?: string | null;
  password?: string | null;
  displayName?: string | null;
  ip?: string | null;
}): Promise<NativeAccountSuccess | NativeAccountError> {
  const email = normalizeEmail(input.email ?? "");
  const password = input.password ?? "";
  const displayName = (input.displayName ?? "").trim();

  const emailError = validateEmail(email);
  if (emailError) return {ok: false, error: emailError, status: 400};
  const nameError = validateDisplayName(displayName);
  if (nameError) return {ok: false, error: nameError, status: 400};
  const passwordError = validatePassword(password);
  if (passwordError) return {ok: false, error: passwordError, status: 400};

  if (!consumeRateLimit(rateLimitKey("register", input.ip, email), 6)) {
    return {ok: false, error: "Please wait a few minutes and try again.", status: 429};
  }

  // Registration guard. A stored credential row means a password account already
  // exists, so registering again is a duplicate -> 409 (sign in instead).
  //
  // A member row with NO credential row is one of two things:
  //   (a) an orphan left by the old hash-after-insert ordering (or an interrupted
  //       retry): the member row landed but the credential row never did, because
  //       password hashing threw first. It is safe to repair — keep the member
  //       row and attach the new credential below.
  //   (b) an account that signed up through another provider (google / apple /
  //       chatgpt / development). Letting credentials registration claim it would
  //       hand the account to anyone who knows the email, so keep the 409 and
  //       never overwrite its authProvider.
  const stored = await getStoredCredential(email);
  const existingMember = await findMemberRecord({email});
  if (stored) {
    return {
      ok: false,
      error: "We couldn’t create this account. Try signing in, or use a different email.",
      status: 409,
    };
  }
  if (existingMember && isClaimedByAnotherProvider(existingMember)) {
    return {
      ok: false,
      error: "We couldn’t create this account. Try signing in, or use a different email.",
      status: 409,
    };
  }

  // Hash FIRST, before any write. If WebCrypto rejects (e.g. a platform
  // iteration cap), this throws while no row exists yet, so a retry is not
  // stuck behind the duplicate guard above. The old code upserted the member
  // before hashing, which left orphan members that 409'd forever on retry.
  //
  // A single atomic D1 transaction across both tables would be stronger, but
  // persistence here is dual-path (D1 when bound, in-process memory otherwise),
  // so writes cannot be transactional in every environment. Hash-first ordering
  // plus the repair path above closes the dead end instead.
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  const member = await upsertMemberRecord(
    existingMember
      ? memberFromIdentity({
          id: existingMember.id,
          email,
          name: displayName,
          provider: "credentials",
          createdAt: existingMember.createdAt,
        })
      : memberFromIdentity({
          email,
          name: displayName,
          provider: "credentials",
        }),
  );
  await persistCredential({
    email,
    memberId: member.id,
    passwordHash,
    createdAt: now,
    updatedAt: now,
  });
  return {ok: true, member};
}

function isClaimedByAnotherProvider(member: Member): boolean {
  const provider = member.authProvider ?? null;
  // null/undefined predates provider tracking and behaves like an orphaned
  // credentials row — repairable, not claimable-by-OAuth.
  return provider !== null && provider !== "credentials";
}

export async function verifyNativeLogin(
  emailRaw: string,
  password: string,
  ip?: string | null,
): Promise<Member | null> {
  const email = normalizeEmail(emailRaw);
  if (!consumeRateLimit(rateLimitKey("login", ip, email || "unknown"), 8)) {
    await verifyAgainstDummy(password);
    return null;
  }

  const stored = await getStoredCredential(email);
  if (!stored) {
    await verifyAgainstDummy(password);
    return null;
  }
  if (!(await verifyPassword(password, stored.passwordHash))) return null;
  return (
    (await findMemberRecord({id: stored.memberId, email: stored.email})) ??
    memberFromIdentity({
      id: stored.memberId,
      email: stored.email,
      provider: "credentials",
    })
  );
}

async function getStoredCredential(email: string): Promise<StoredCredential | null> {
  try {
    const persisted = await (await import("../db/credentials")).getCredentialByEmail(email);
    if (persisted) return persisted;
  } catch {
    // D1 is optional until hosting.json binds DB and migrations apply.
  }
  return memory.get(email) ?? null;
}

async function persistCredential(row: StoredCredential): Promise<StoredCredential> {
  try {
    const persisted = await (await import("../db/credentials")).insertCredential(row);
    if (persisted) return persisted;
  } catch {
    // Fall through to memory so local/demo still works.
  }
  memory.set(row.email, row);
  return row;
}

function rateLimitKey(action: string, ip: string | null | undefined, email: string): string {
  const address = (ip ?? "local").split(",")[0]?.trim() || "local";
  return `${action}:${address}:${email}`;
}

async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHashPromise ??= hashPassword("salu-timing-dummy-not-a-password");
  await verifyPassword(password, await dummyHashPromise);
}

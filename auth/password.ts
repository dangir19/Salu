const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 80;
// Cloudflare Workers caps PBKDF2 at 100,000 iterations; stay at the platform max.
const PBKDF2_ITERATIONS = 100_000;
const HASH_BITS = 256;
const SALT_BYTES = 16;

export const PASSWORD_MIN_LENGTH = MIN_PASSWORD_LENGTH;

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validateEmail(email: string): string | null {
  if (!email) return "Enter the email you will use to come back.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "That email doesn’t look quite right.";
  }
  if (email.length > 254) return "That email is too long.";
  return null;
}

export function validateDisplayName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < MIN_NAME_LENGTH) return "Tell us the name we should greet you by.";
  if (trimmed.length > MAX_NAME_LENGTH) return "That name is a little too long.";
  return null;
}

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) return "That password is too long.";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseHash(encoded);
  if (!parsed) {
    await deriveBits(password, crypto.getRandomValues(new Uint8Array(SALT_BYTES)), PBKDF2_ITERATIONS);
    return false;
  }
  let actual: Uint8Array;
  try {
    actual = await deriveBits(password, parsed.salt, parsed.iterations);
  } catch {
    return false;
  }
  return timingSafeEqual(actual, parsed.hash);
}

function parseHash(encoded: string): {iterations: number; salt: Uint8Array; hash: Uint8Array} | null {
  const [scheme, iterationsRaw, salt, hash] = encoded.split("$");
  const iterations = Number(iterationsRaw);
  if (scheme !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 1 || !salt || !hash) {
    return null;
  }
  try {
    return {iterations, salt: b64ToBytes(salt), hash: b64ToBytes(hash)};
  } catch {
    return null;
  }
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {name: "PBKDF2", hash: "SHA-256", salt: Uint8Array.from(salt), iterations},
    key,
    HASH_BITS,
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

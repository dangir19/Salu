const DEFAULT_TOLERANCE_SECONDS = 300;

function hexFromBuffer(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {name: "HMAC", hash: "SHA-256"},
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return hexFromBuffer(signature);
}

export function parseStripeSignatureHeader(header: string): {timestamp: number; signatures: string[]} {
  const parts = header.split(",").map((part) => part.trim());
  let timestamp = 0;
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split("=");
    if (key === "t" && value) timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  return {timestamp, signatures};
}

export async function verifyStripeSignature(input: {
  payload: string;
  header: string;
  secret: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): Promise<boolean> {
  const {payload, header, secret} = input;
  if (!payload || !header || !secret) return false;

  const {timestamp, signatures} = parseStripeSignatureHeader(header);
  if (!timestamp || signatures.length === 0) return false;

  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const expected = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return signatures.some((signature) => timingSafeEqual(signature, expected));
}

export async function signedStripeHeader(secret: string, payload: string, timestamp = Math.floor(Date.now() / 1000)): Promise<string> {
  const signature = await hmacSha256Hex(secret, `${timestamp}.${payload}`);
  return `t=${timestamp},v1=${signature}`;
}

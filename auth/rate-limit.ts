type Bucket = {count: number; resetAt: number};

const buckets = new Map<string, Bucket>();

export function consumeRateLimit(key: string, limit = 8, windowMs = 15 * 60 * 1000): boolean {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, {count: 1, resetAt: now + windowMs});
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

export function resetRateLimits(): void {
  buckets.clear();
}

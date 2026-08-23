declare module "cloudflare:workers" {
  export const env: {
    DB?: D1Database;
    AUTH_SECRET?: string;
    AUTH_URL?: string;
    AUTH_GOOGLE_ID?: string;
    AUTH_GOOGLE_SECRET?: string;
    AUTH_APPLE_ID?: string;
    AUTH_APPLE_SECRET?: string;
    AUTH_APPLE_TEAM_ID?: string;
    AUTH_APPLE_KEY_ID?: string;
    AUTH_APPLE_PRIVATE_KEY?: string;
    SALU_ALLOW_DEV_BYPASS?: string;
    SALU_OPS_SECRET?: string;
    SALU_PROVIDER_EMAILS?: string;
    STRIPE_SECRET_KEY?: string;
    STRIPE_PUBLISHABLE_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    STRIPE_GOLD_PRICE_ID?: string;
    STRIPE_PLATINUM_PRICE_ID?: string;
    OPENAI_API_KEY?: string;
    OPENAI_MODEL?: string;
    [key: string]: unknown;
  };
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  dump(): Promise<ArrayBuffer>;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run<T = unknown>(): Promise<D1Result<T>>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw<T = unknown>(): Promise<T[]>;
}

interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

interface D1ExecResult {
  count: number;
  duration: number;
}

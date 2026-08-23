import type {PaymentMethod} from "../domain/types";

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2024-06-20";

export type StripeObject = {
  id: string;
  object: string;
  [key: string]: unknown;
};

export type StripeCustomer = StripeObject & {
  email?: string | null;
  invoice_settings?: {default_payment_method?: string | PaymentMethodObject | null};
  metadata?: Record<string, string>;
};

export type PaymentMethodObject = StripeObject & {
  card?: {brand?: string; last4?: string; exp_month?: number; exp_year?: number};
};

export type StripeCheckoutSession = StripeObject & {
  mode?: string;
  status?: string;
  customer?: string | StripeCustomer | null;
  subscription?: string | StripeSubscription | null;
  payment_intent?: string | null;
  amount_total?: number | null;
  payment_status?: string;
  client_reference_id?: string | null;
  metadata?: Record<string, string>;
  url?: string | null;
};

export type StripeSubscription = StripeObject & {
  status?: string;
  customer?: string | StripeCustomer;
  items?: {data?: Array<{id?: string; price?: {id?: string; unit_amount?: number | null}}>};
  metadata?: Record<string, string>;
  cancel_at_period_end?: boolean;
};

export type StripeInvoice = StripeObject & {
  customer?: string | StripeCustomer | null;
  subscription?: string | StripeSubscription | null;
  amount_paid?: number;
  billing_reason?: string | null;
  status?: string;
  parent?: {subscription_details?: {subscription?: string | null}} | null;
};

export type StripeCharge = StripeObject & {
  customer?: string | null;
  refunded?: boolean;
  amount_refunded?: number;
  payment_intent?: string | null;
  invoice?: string | null;
  metadata?: Record<string, string>;
};

export type StripeAccount = StripeObject & {
  type?: string;
  email?: string | null;
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  metadata?: Record<string, string>;
  requirements?: {currently_due?: string[]; disabled_reason?: string | null};
};

export type StripeAccountLink = {
  object: string;
  url: string;
  expires_at?: number;
};

export type StripeLoginLink = {
  object: string;
  url: string;
};

export type StripeTransfer = StripeObject & {
  amount?: number;
  currency?: string;
  destination?: string;
  reversed?: boolean;
  metadata?: Record<string, string>;
};

export type StripeEvent = {
  id: string;
  type: string;
  account?: string;
  data: {object: StripeObject};
};

export class StripeApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "StripeApiError";
    this.status = status;
    this.code = code;
  }
}

function encodeStripeParams(value: unknown, prefix = ""): Array<[string, string]> {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => encodeStripeParams(item, `${prefix}[${index}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
      encodeStripeParams(nested, prefix ? `${prefix}[${key}]` : key),
    );
  }
  if (typeof value === "boolean") return [[prefix, value ? "true" : "false"]];
  return [[prefix, String(value)]];
}

export type StripeRequestOptions = {
  idempotencyKey?: string;
  stripeAccount?: string;
};

export async function stripeRequest<T>(
  secret: string,
  method: "GET" | "POST",
  path: string,
  params?: Record<string, unknown>,
  options?: StripeRequestOptions,
): Promise<T> {
  const url = new URL(`${STRIPE_API}${path}`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    "Stripe-Version": STRIPE_VERSION,
  };
  if (options?.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
  if (options?.stripeAccount) headers["Stripe-Account"] = options.stripeAccount;

  let body: string | undefined;
  if (method === "GET" && params) {
    for (const [key, value] of encodeStripeParams(params)) {
      url.searchParams.append(key, value);
    }
  } else if (method === "POST" && params) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(encodeStripeParams(params)).toString();
  }

  const response = await fetch(url, {method, headers, body});
  const payload = (await response.json()) as StripeObject & {
    error?: {message?: string; code?: string};
  };
  if (!response.ok) {
    throw new StripeApiError(
      payload.error?.message || `Stripe ${method} ${path} failed`,
      response.status,
      payload.error?.code,
    );
  }
  return payload as T;
}

export function idFromExpandable(value: unknown): string {
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return "";
}

export function cardFromPaymentMethod(method: PaymentMethodObject | null | undefined): PaymentMethod | null {
  const card = method?.card;
  if (!card?.last4) return null;
  return {
    brand: (card.brand || "card").replace(/^\w/, (letter) => letter.toUpperCase()),
    last4: card.last4,
    expMonth: card.exp_month ?? 0,
    expYear: card.exp_year ?? 0,
  };
}

export async function createCustomer(
  secret: string,
  input: {email: string; name?: string; memberId: string},
): Promise<StripeCustomer> {
  return stripeRequest<StripeCustomer>(secret, "POST", "/customers", {
    email: input.email,
    name: input.name,
    metadata: {memberId: input.memberId},
  });
}

export async function retrieveCustomer(secret: string, customerId: string): Promise<StripeCustomer> {
  return stripeRequest<StripeCustomer>(secret, "GET", `/customers/${customerId}`);
}

export async function listCardPaymentMethods(
  secret: string,
  customerId: string,
): Promise<PaymentMethodObject[]> {
  const result = await stripeRequest<{data?: PaymentMethodObject[]}>(
    secret,
    "GET",
    "/payment_methods",
    {customer: customerId, type: "card", limit: 1},
  );
  return result.data ?? [];
}

export async function retrievePaymentMethod(
  secret: string,
  paymentMethodId: string,
): Promise<PaymentMethodObject> {
  return stripeRequest<PaymentMethodObject>(secret, "GET", `/payment_methods/${paymentMethodId}`);
}

export async function createCheckoutSession(
  secret: string,
  params: Record<string, unknown>,
): Promise<StripeCheckoutSession> {
  return stripeRequest<StripeCheckoutSession>(secret, "POST", "/checkout/sessions", params);
}

export async function retrieveCheckoutSession(
  secret: string,
  sessionId: string,
): Promise<StripeCheckoutSession> {
  return stripeRequest<StripeCheckoutSession>(secret, "GET", `/checkout/sessions/${sessionId}`);
}

export async function retrieveSubscription(secret: string, subscriptionId: string): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(secret, "GET", `/subscriptions/${subscriptionId}`);
}

export async function updateSubscription(
  secret: string,
  subscriptionId: string,
  params: Record<string, unknown>,
): Promise<StripeSubscription> {
  return stripeRequest<StripeSubscription>(secret, "POST", `/subscriptions/${subscriptionId}`, params);
}

export async function createPortalSession(
  secret: string,
  input: {customer: string; returnUrl: string},
): Promise<{url: string}> {
  return stripeRequest<{url: string}>(secret, "POST", "/billing_portal/sessions", {
    customer: input.customer,
    return_url: input.returnUrl,
  });
}

export function subscriptionPriceId(subscription: StripeSubscription | null | undefined): string {
  return subscription?.items?.data?.[0]?.price?.id ?? "";
}

export function subscriptionItemId(subscription: StripeSubscription | null | undefined): string {
  return subscription?.items?.data?.[0]?.id ?? "";
}

export function invoiceSubscriptionId(invoice: StripeInvoice): string {
  return idFromExpandable(invoice.subscription) || idFromExpandable(invoice.parent?.subscription_details?.subscription);
}

export async function createConnectAccount(
  secret: string,
  input: {email: string; name: string; providerId: string; memberId?: string},
): Promise<StripeAccount> {
  return stripeRequest<StripeAccount>(secret, "POST", "/accounts", {
    type: "express",
    country: "US",
    email: input.email,
    business_profile: {
      name: input.name,
      product_description: "Independent Salu marketplace services",
      url: "https://joinsalu.com",
    },
    capabilities: {transfers: {requested: true}},
    metadata: {
      providerId: input.providerId,
      memberId: input.memberId ?? "",
      platform: "salu",
    },
  });
}

export async function retrieveConnectAccount(secret: string, accountId: string): Promise<StripeAccount> {
  return stripeRequest<StripeAccount>(secret, "GET", `/accounts/${accountId}`);
}

export async function createAccountLink(
  secret: string,
  input: {account: string; refreshUrl: string; returnUrl: string},
): Promise<StripeAccountLink> {
  return stripeRequest<StripeAccountLink>(secret, "POST", "/account_links", {
    account: input.account,
    refresh_url: input.refreshUrl,
    return_url: input.returnUrl,
    type: "account_onboarding",
  });
}

export async function createAccountLoginLink(secret: string, accountId: string): Promise<StripeLoginLink> {
  return stripeRequest<StripeLoginLink>(secret, "POST", `/accounts/${accountId}/login_links`);
}

export async function createTransfer(
  secret: string,
  input: {
    amountCents: number;
    destination: string;
    bookingId: string;
    providerId: string;
    commissionAmount: number;
  },
): Promise<StripeTransfer> {
  return stripeRequest<StripeTransfer>(
    secret,
    "POST",
    "/transfers",
    {
      amount: input.amountCents,
      currency: "usd",
      destination: input.destination,
      transfer_group: input.bookingId,
      metadata: {
        bookingId: input.bookingId,
        providerId: input.providerId,
        commissionAmount: String(input.commissionAmount),
        kind: "provider_payout",
      },
    },
    {idempotencyKey: `salu_payout_${input.bookingId}`},
  );
}

import type {StripeEnv} from "./env";

export type PaymentsConfigItem = {
  key: string;
  label: string;
  required: boolean;
  /** Presence only. Values are never returned. */
  configured: boolean;
  /** Where Daniel finds the value. */
  where: string;
  /** Redacted-looking example of the value shape. */
  example: string;
};

export type PaymentsConfigReport = {
  ready: boolean;
  missingRequired: string[];
  items: PaymentsConfigItem[];
};

const WORKER_NAME = "salu";

export function paymentsConfigChecklist(env: StripeEnv): PaymentsConfigReport {
  const items: PaymentsConfigItem[] = [
    {
      key: "STRIPE_SECRET_KEY",
      label: "Secret key",
      required: true,
      configured: Boolean(env.STRIPE_SECRET_KEY),
      where: "Stripe Dashboard → Developers → API keys → Secret key",
      example: "sk_live_…",
    },
    {
      key: "STRIPE_PUBLISHABLE_KEY",
      label: "Publishable key",
      required: true,
      configured: Boolean(env.STRIPE_PUBLISHABLE_KEY),
      where: "Stripe Dashboard → Developers → API keys → Publishable key",
      example: "pk_live_…",
    },
    {
      key: "STRIPE_WEBHOOK_SECRET",
      label: "Webhook signing secret",
      required: true,
      configured: Boolean(env.STRIPE_WEBHOOK_SECRET),
      where: "Stripe Dashboard → Developers → Webhooks → add endpoint → Signing secret",
      example: "whsec_…",
    },
    {
      key: "STRIPE_GOLD_PRICE_ID",
      label: "Salu Gold price ($200/mo)",
      required: true,
      configured: Boolean(env.STRIPE_GOLD_PRICE_ID),
      where: "Stripe Dashboard → Product catalog → Salu Gold → price ID",
      example: "price_…",
    },
    {
      key: "STRIPE_PLATINUM_PRICE_ID",
      label: "Salu Platinum price ($500/mo)",
      required: true,
      configured: Boolean(env.STRIPE_PLATINUM_PRICE_ID),
      where: "Stripe Dashboard → Product catalog → Salu Platinum → price ID",
      example: "price_…",
    },
    {
      key: "STRIPE_CONNECT_CLIENT_ID",
      label: "Connect client ID (provider payouts)",
      required: false,
      configured: Boolean(env.STRIPE_CONNECT_CLIENT_ID),
      where: "Stripe Dashboard → Settings → Connect settings → Client ID",
      example: "ca_…",
    },
  ];
  const missingRequired = items.filter((item) => item.required && !item.configured).map((item) => item.key);
  return {ready: missingRequired.length === 0, missingRequired, items};
}

/** Single copy-paste block for Daniel: key names with placeholders, never real values. */
export function paymentsEnvTemplate(): string {
  return [
    "STRIPE_SECRET_KEY=sk_live_paste_here",
    "STRIPE_PUBLISHABLE_KEY=pk_live_paste_here",
    "STRIPE_WEBHOOK_SECRET=whsec_paste_here",
    "STRIPE_GOLD_PRICE_ID=price_paste_here",
    "STRIPE_PLATINUM_PRICE_ID=price_paste_here",
    "STRIPE_CONNECT_CLIENT_ID=ca_paste_here",
  ].join("\n");
}

export function paymentsSecretsDestination(): string {
  return `Cloudflare Dashboard → Workers & Pages → ${WORKER_NAME} → Settings → Variables → add each as an encrypted secret`;
}

export function stripeWebhookEndpoint(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/stripe/webhook`;
}

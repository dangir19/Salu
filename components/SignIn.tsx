"use client";
/* eslint-disable jsx-a11y/no-autofocus -- modal close control receives initial focus */

import Link from "next/link";
import {useEffect, useState, type FormEvent} from "react";
import type {AuthSurface} from "../auth/env";

type OAuthId = "google" | "apple" | "development" | "provider-development" | "admin-development";
type BusyId = OAuthId | "credentials";
type AccountMode = "signin" | "create";

export type AuthIntent =
  | {kind: "browse"}
  | {kind: "book"; serviceId: string; date: string; mode: string}
  | {kind: "credits"}
  | {kind: "package"; name: string}
  | {kind: "join"; plan: string; name?: string; home?: string}
  | {kind: "profile"}
  | {kind: "admin"};

export const PENDING_AUTH_KEY = "salu-pending-auth";

export function storePendingAuth(intent: AuthIntent, returnTo: string) {
  try {
    sessionStorage.setItem(PENDING_AUTH_KEY, JSON.stringify({intent, returnTo}));
  } catch {
    /* Private browsing. */
  }
}

export function takePendingAuth(): {intent: AuthIntent; returnTo: string} | null {
  try {
    const raw = sessionStorage.getItem(PENDING_AUTH_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_AUTH_KEY);
    return JSON.parse(raw) as {intent: AuthIntent; returnTo: string};
  } catch {
    return null;
  }
}

export default function SignIn({
  returnTo = "/",
  surface,
}: {
  returnTo?: string;
  surface: AuthSurface;
}) {
  const safeReturn = safePath(returnTo, "/", "/signin");
  const staffGate = isStaffReturn(safeReturn);

  return (
    <div className="salu-app signin-page">
      <a className="skip-link" href="#signin-card">Skip to sign in</a>
      <div className="signin-brand">
        <span className="wordmark">salu<span>°</span></span>
        <p>Your health concierge.</p>
        <small>Miami · in-home wellness, beautifully handled.</small>
      </div>
      <SignInCard
        surface={surface}
        returnTo={safeReturn}
        staffGate={staffGate}
        title={staffGate ? "Staff sign-in." : "Come in. We’ll take it from here."}
        switchHref="/provider/signin"
        switchLabel="Provider sign-in"
      />
    </div>
  );
}

export function ProviderSignIn({
  returnTo = "/provider",
  surface,
}: {
  returnTo?: string;
  surface: AuthSurface;
}) {
  const safeReturn = safePath(returnTo, "/provider", "/provider/signin");

  return (
    <div className="salu-app signin-page">
      <a className="skip-link" href="#signin-card">Skip to provider sign in</a>
      <div className="signin-brand">
        <span className="wordmark">salu<span>°</span></span>
        <p>Your health concierge.</p>
        <small>Miami · independent providers, filling live requests.</small>
      </div>
      <SignInCard
        kind="provider"
        surface={surface}
        returnTo={safeReturn}
        title="Come in. The request queue is waiting."
        signInCopy="Use the email on your Salu application. Once we've welcomed you, this same account opens the workspace with role=provider."
        createCopy="Create the account you’ll use once we’ve said hello. Role still comes from your application, SALU_PROVIDER_EMAILS, or the labeled demo."
        switchHref="/signin"
        switchLabel="Member sign-in"
      />
    </div>
  );
}

export function SignInModal({
  returnTo = "/",
  surface,
  intent,
  onClose,
}: {
  returnTo?: string;
  surface: AuthSurface;
  intent?: AuthIntent;
  onClose: () => void;
}) {
  const safeReturn = safePath(returnTo, "/", "/signin");
  const staffGate = intent?.kind === "admin" || isStaffReturn(safeReturn);
  const copy = modalCopy(intent, staffGate);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop signin-modal-backdrop">
      <button type="button" className="modal-dismiss" aria-label="Close sign in" onClick={onClose} />
      <section className="signin-modal" role="dialog" aria-modal="true" aria-labelledby="signin-title">
        <button type="button" className="modal-close" autoFocus aria-label="Close sign in" onClick={onClose}>
          ×
        </button>
        <SignInCard
          surface={surface}
          returnTo={safeReturn}
          staffGate={staffGate}
          title={copy.title}
          signInCopy={copy.signInCopy}
          createCopy={copy.createCopy}
          compact
          switchHref="/provider/signin"
          switchLabel="Provider sign-in"
        />
      </section>
    </div>
  );
}

function SignInCard({
  kind = "member",
  surface,
  returnTo,
  staffGate = false,
  title,
  signInCopy,
  createCopy,
  compact = false,
  switchHref,
  switchLabel,
}: {
  kind?: "member" | "provider";
  surface: AuthSurface;
  returnTo: string;
  staffGate?: boolean;
  title: string;
  signInCopy?: string;
  createCopy?: string;
  compact?: boolean;
  switchHref: string;
  switchLabel: string;
}) {
  const [busy, setBusy] = useState<BusyId | null>(null);
  const [notice, setNotice] = useState(credentialsErrorFromSearch);
  const [nativeReady, setNativeReady] = useState<boolean | null>(null);
  const defaultSignIn = staffGate
    ? "For allowlisted Salu staff only. Sign in with the email on SALU_ADMIN_EMAILS. Applicant details never appear on this page."
    : kind === "provider"
      ? "Use the email on your Salu application. Once we've welcomed you, this same account opens the workspace with role=provider."
      : "Create an account with email, or sign back in. Atlas, your Credits and Miami bookings stay with your membership.";
  const defaultCreate = staffGate
    ? "Create the staff email you’ll use on SALU_ADMIN_EMAILS. Applicant details never appear on this page."
    : kind === "provider"
      ? "Create the account you’ll use once we’ve said hello. Role still comes from your application, SALU_PROVIDER_EMAILS, or the labeled demo."
      : "A few details and you’re in. Atlas, Credits and Miami bookings will stay with this membership.";

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/providers")
      .then((res) => (res.ok ? res.json() : {}))
      .then((providers: Record<string, unknown>) => {
        if (!cancelled) setNativeReady(Boolean(providers.credentials));
      })
      .catch(() => {
        if (!cancelled) setNativeReady(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className={`signin-card${compact ? " signin-card-compact" : ""}`} id="signin-card">
      <span className="eyebrow">{staffGate ? "SALU STAFF" : kind === "provider" ? "PROVIDERS" : "MEMBERS"}</span>
      <h1 id="signin-title">{title}</h1>
      <NativeAccountForm
        kind={kind}
        busy={busy}
        setBusy={setBusy}
        setNotice={setNotice}
        returnTo={returnTo}
        nativeReady={nativeReady}
        signInCopy={signInCopy ?? defaultSignIn}
        createCopy={createCopy ?? defaultCreate}
      />
      <OAuthButtons
        kind={kind}
        staffGate={staffGate}
        surface={surface}
        busy={busy}
        start={(provider, configured, missing) =>
          startOAuth({provider, configured, missing, returnTo, setBusy, setNotice})
        }
      />
      {notice && <p className="signin-notice" role="status">{notice}</p>}
      <p className="signin-footnote">
        {kind === "provider"
          ? "Payouts are not live yet. Accepting a request assigns the visit in-app. See PROVIDER.md."
          : "Independent providers deliver every service. Atlas does not diagnose or prescribe. For emergencies, call 911."}
      </p>
      <p className="signin-switch">
        <Link href={switchHref}>{switchLabel}</Link>
      </p>
    </section>
  );
}

function NativeAccountForm({
  kind,
  busy,
  setBusy,
  setNotice,
  returnTo,
  nativeReady,
  signInCopy,
  createCopy,
}: {
  kind: "member" | "provider";
  busy: BusyId | null;
  setBusy: (value: BusyId | null) => void;
  setNotice: (value: string) => void;
  returnTo: string;
  nativeReady: boolean | null;
  signInCopy: string;
  createCopy: string;
}) {
  const [mode, setMode] = useState<AccountMode>(accountModeFromSearch);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy("credentials");
    setNotice("");
    try {
      const ready = nativeReady ?? (await credentialsProviderReady());
      if (!ready) {
        setNotice("Email and password will be here shortly. Continue with Google, Apple, or a local preview.");
        setBusy(null);
        return;
      }
      if (mode === "create") {
        const res = await fetch("/api/auth/register", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({email, password, displayName}),
        });
        const data = (await res.json()) as {error?: string};
        if (!res.ok) {
          setNotice(data.error || "We couldn’t create this account just now.");
          setBusy(null);
          return;
        }
      }
      await postCredentials({email, password, returnTo});
    } catch {
      setBusy(null);
      setNotice(
        kind === "provider"
          ? "We couldn’t start provider sign-in just now. Please try again in a moment."
          : "We couldn’t start sign-in just now. Please try again in a moment.",
      );
    }
  };

  return (
    <>
      <p className="signin-copy">{mode === "create" ? createCopy : signInCopy}</p>
      <form className="signin-form" onSubmit={(event) => void submit(event)}>
        {mode === "create" && (
          <label>
            How should we greet you?
            <input
              type="text"
              name="displayName"
              autoComplete="name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </label>
        )}
        <label>
          Email
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            name="password"
            autoComplete={mode === "create" ? "new-password" : "current-password"}
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button type="submit" className="signin-primary" disabled={busy !== null}>
          {busy === "credentials"
            ? mode === "create" ? "Creating your account…" : "Signing you in…"
            : mode === "create" ? "Create account" : "Sign in with email"}
        </button>
        <button
          type="button"
          className="signin-text-link"
          disabled={busy !== null}
          onClick={() => {
            setMode(mode === "create" ? "signin" : "create");
            setNotice("");
          }}
        >
          {mode === "create" ? "Already have an account? Sign in" : "New here? Create an account"}
        </button>
        {mode === "signin" && (
          <p className="signin-reset">
            Forgot your password? Reset isn’t available yet — try Google or Apple if you have them, or create a new account.
          </p>
        )}
      </form>
    </>
  );
}

function OAuthButtons({
  kind,
  staffGate = false,
  surface,
  busy,
  start,
}: {
  kind: "member" | "provider";
  staffGate?: boolean;
  surface: AuthSurface;
  busy: BusyId | null;
  start: (provider: OAuthId, configured: boolean, missing: string) => void;
}) {
  return (
    <>
      <p className="signin-divider" role="separator">or continue with</p>
      <button
        type="button"
        className={`signin-google${surface.google ? "" : " signin-soon"}`}
        disabled={busy !== null || !surface.google}
        aria-disabled={!surface.google}
        onClick={() =>
          start(
            "google",
            surface.google,
            "Google is coming soon on this deployment. Use email for now, or a local preview.",
          )
        }
      >
        <GoogleMark />
        {busy === "google" ? "Opening Google…" : surface.google ? "Continue with Google" : "Continue with Google · coming soon"}
      </button>
      <button
        type="button"
        className={`signin-apple${surface.apple ? "" : " signin-soon"}`}
        disabled={busy !== null || !surface.apple}
        aria-disabled={!surface.apple}
        onClick={() =>
          start(
            "apple",
            surface.apple,
            "Apple is coming soon on this deployment. Use email for now, or a local preview.",
          )
        }
      >
        <AppleMark />
        {busy === "apple" ? "Opening Apple…" : surface.apple ? "Continue with Apple" : "Continue with Apple · coming soon"}
      </button>
      {surface.development && kind === "member" && !staffGate && (
        <button
          type="button"
          className="signin-dev"
          disabled={busy !== null}
          onClick={() => start("development", true, "")}
        >
          {busy === "development" ? "Opening preview…" : "Continue with a local preview"}
          <small>Development only · labeled bypass · not a live membership</small>
        </button>
      )}
      {surface.development && kind === "member" && staffGate && (
        <button
          type="button"
          className="signin-dev"
          disabled={busy !== null}
          onClick={() => start("admin-development", true, "")}
        >
          {busy === "admin-development" ? "Opening admin preview…" : "Continue as Salu admin"}
          <small>Development only · labeled local review · production never exposes the live queue</small>
        </button>
      )}
      {surface.development && kind === "provider" && (
        <button
          type="button"
          className="signin-dev"
          disabled={busy !== null}
          onClick={() => start("provider-development", true, "")}
        >
          {busy === "provider-development" ? "Opening Tide & Tone…" : "Continue as Tide & Tone"}
          <small>Development only · labeled demo provider · not Stripe Connect</small>
        </button>
      )}
    </>
  );
}

async function startOAuth({
  provider,
  configured,
  missing,
  returnTo,
  setBusy,
  setNotice,
}: {
  provider: OAuthId;
  configured: boolean;
  missing: string;
  returnTo: string;
  setBusy: (value: BusyId | null) => void;
  setNotice: (value: string) => void;
}) {
  if (!configured) {
    setNotice(missing);
    return;
  }
  setBusy(provider);
  setNotice("");
  try {
    await postAuthForm(`/api/auth/signin/${provider}`, {callbackUrl: returnTo});
  } catch {
    setBusy(null);
    setNotice(
      provider === "provider-development"
        ? "We couldn’t start provider sign-in just now. Please try again in a moment."
        : "We couldn’t start sign-in just now. Please try again in a moment.",
    );
  }
}

async function credentialsProviderReady() {
  try {
    const res = await fetch("/api/auth/providers");
    if (!res.ok) return false;
    const providers = (await res.json()) as Record<string, unknown>;
    return Boolean(providers.credentials);
  } catch {
    return false;
  }
}

export async function postCredentials({
  email,
  password,
  returnTo,
}: {
  email: string;
  password: string;
  returnTo: string;
}) {
  await postAuthForm("/api/auth/callback/credentials", {
    email,
    password,
    callbackUrl: returnTo,
  });
}

async function postAuthForm(action: string, fields: Record<string, string>) {
  const csrfRes = await fetch("/api/auth/csrf");
  if (!csrfRes.ok) throw new Error("csrf");
  const {csrfToken} = (await csrfRes.json()) as {csrfToken?: string};
  if (!csrfToken) throw new Error("csrf");
  const form = document.createElement("form");
  form.method = "POST";
  form.action = action;
  form.append(hidden("csrfToken", csrfToken));
  for (const [name, value] of Object.entries(fields)) {
    form.append(hidden(name, value));
  }
  document.body.append(form);
  form.submit();
}

function modalCopy(intent: AuthIntent | undefined, staffGate: boolean) {
  if (staffGate) {
    return {
      title: "Staff sign-in.",
      signInCopy: "For allowlisted Salu staff only. Sign in with the email on SALU_ADMIN_EMAILS. Applicant details never appear on this page.",
      createCopy: "Create the staff email you’ll use on SALU_ADMIN_EMAILS. Applicant details never appear on this page.",
    };
  }
  switch (intent?.kind) {
    case "book":
      return {
        title: "Sign in to confirm this reservation.",
        signInCopy: "We’ll hold the details and continue once you’re in.",
        createCopy: "Create an account and we’ll confirm this visit on your membership.",
      };
    case "credits":
      return {
        title: "Sign in to fund Credits.",
        signInCopy: "Credits stay with your membership — come in to add them.",
        createCopy: "Create an account to keep Credits with you.",
      };
    case "package":
      return {
        title: "Sign in to add this to your membership.",
        signInCopy: "Packages live on your account, not in the browser.",
        createCopy: "Create an account and this package will wait for you.",
      };
    case "join":
      return {
        title: "Sign in to start your membership.",
        signInCopy: "Gold and Platinum need an account so Stripe can find you.",
        createCopy: "A few details and we’ll take you into membership.",
      };
    case "profile":
      return {
        title: "Sign in to open your profile.",
        signInCopy: "Preferences, billing and sign-out live with your membership.",
        createCopy: "Create an account to keep a Salu snapshot of your own.",
      };
    default:
      return {
        title: "Come in. We’ll take it from here.",
        signInCopy: "Create an account with email, or sign back in. You can keep browsing Salu either way.",
        createCopy: "A few details and you’re in. Atlas, Credits and Miami bookings will stay with this membership.",
      };
  }
}

function accountModeFromSearch(): AccountMode {
  if (typeof window === "undefined") return "signin";
  return new URLSearchParams(window.location.search).get("mode") === "create" ? "create" : "signin";
}

function credentialsErrorFromSearch() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("error") === "CredentialsSignin"
    ? "We couldn’t sign you in with those details."
    : "";
}

function isStaffReturn(returnTo: string) {
  return returnTo === "/admin" || returnTo.startsWith("/admin/");
}

function safePath(returnTo: string, fallback: string, blocked: string) {
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return fallback;
  return returnTo === blocked ? fallback : returnTo;
}

function hidden(name: string, value: string) {
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = name;
  input.value = value;
  return input;
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5c-.3 1.5-1.2 2.8-2.5 3.7v3h4c2.3-2.1 3.5-5.2 3.5-8.8z"/>
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1 7.9-2.9l-4-3c-1.1.7-2.5 1.2-3.9 1.2-3 0-5.6-2-6.5-4.8H1.4v3.1C3.4 21.4 7.4 24 12 24z"/>
      <path fill="#FBBC05" d="M5.5 14.5c-.2-.7-.4-1.4-.4-2.1s.1-1.4.4-2.1V7.2H1.4C.5 9 .1 10.5.1 12.4s.4 3.4 1.3 5.2l4.1-3.1z"/>
      <path fill="#EA4335" d="M12 4.8c1.7 0 3.3.6 4.5 1.8l3.4-3.4C17.9 1.1 15.2 0 12 0 7.4 0 3.4 2.6 1.4 6.4l4.1 3.1C6.4 6.8 9 4.8 12 4.8z"/>
    </svg>
  );
}

function AppleMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
      <path d="M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.1-2.8.9-3.5.9s-1.8-.8-3-.8c-1.5 0-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.8 1.1 1.7 2.3 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.8-2.2c.9-1.3 1.3-2.5 1.3-2.6-.1 0-2.5-1-2.5-3.9zM14.7 5.8c.6-.8 1.1-1.9.9-3-1 .1-2.1.7-2.8 1.5-.6.7-1.1 1.8-.9 2.9 1.1.1 2.2-.5 2.8-1.4z"/>
    </svg>
  );
}

export function AuthLoading() {
  return (
    <div className="salu-app signin-page signin-loading">
      <span className="wordmark">salu<span>°</span></span>
      <p>Preparing your membership…</p>
    </div>
  );
}

export function AdminForbidden({
  go,
  signOut,
}: {
  go: (page: "home") => void;
  signOut: () => void | Promise<void>;
}) {
  return (
    <div className="salu-app signin-page">
      <a className="skip-link" href="#signin-card">Skip to notice</a>
      <div className="signin-brand">
        <span className="wordmark">salu<span>°</span></span>
        <p>Your health concierge.</p>
        <small>Miami · staff review is allowlisted.</small>
      </div>
      <section className="signin-card" id="signin-card">
        <span className="eyebrow">SALU STAFF</span>
        <h1>Not authorized.</h1>
        <p className="signin-copy">
          This area is only for authorized Salu staff. Your signed-in account cannot see or change applications.
        </p>
        <button type="button" className="signin-google" onClick={() => go("home")}>
          Back to Salu
        </button>
        <button type="button" className="signin-apple" onClick={signOut}>
          Sign out
        </button>
      </section>
    </div>
  );
}

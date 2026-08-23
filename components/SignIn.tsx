"use client";

import Link from "next/link";
import {useState, type FormEvent} from "react";
import type {AuthSurface} from "../auth/env";

type OAuthId = "google" | "apple" | "development" | "provider-development";
type BusyId = OAuthId | "credentials";
type AccountMode = "signin" | "create";

export default function SignIn({
  returnTo = "/",
  surface,
}: {
  returnTo?: string;
  surface: AuthSurface;
}) {
  const [busy, setBusy] = useState<BusyId | null>(null);
  const [notice, setNotice] = useState(credentialsErrorFromSearch);
  const safeReturn = safePath(returnTo, "/", "/signin");

  return (
    <div className="salu-app signin-page">
      <a className="skip-link" href="#signin-card">Skip to sign in</a>
      <div className="signin-brand">
        <span className="wordmark">salu<span>°</span></span>
        <p>Your health concierge.</p>
        <small>Miami · in-home wellness, beautifully handled.</small>
      </div>
      <section className="signin-card" id="signin-card">
        <span className="eyebrow">MEMBERS</span>
        <h1>Come in. We’ll take it from here.</h1>
        <NativeAccountForm
          kind="member"
          busy={busy}
          setBusy={setBusy}
          setNotice={setNotice}
          returnTo={safeReturn}
          signInCopy="Create an account with email, or sign back in. Atlas, your Credits and Miami bookings stay with your membership."
          createCopy="A few details and you’re in. Atlas, Credits and Miami bookings will stay with this membership."
        />
        <OAuthButtons
          kind="member"
          surface={surface}
          busy={busy}
          start={(provider, configured, missing) =>
            startOAuth({provider, configured, missing, returnTo: safeReturn, setBusy, setNotice})
          }
        />
        {notice && <p className="signin-notice" role="status">{notice}</p>}
        <p className="signin-footnote">
          Independent providers deliver every service. Atlas does not diagnose or prescribe. For emergencies, call 911.
        </p>
        <p className="signin-switch">
          <Link href="/provider/signin">Provider sign-in</Link>
        </p>
      </section>
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
  const [busy, setBusy] = useState<BusyId | null>(null);
  const [notice, setNotice] = useState(credentialsErrorFromSearch);
  const safeReturn = safePath(returnTo, "/provider", "/provider/signin");

  return (
    <div className="salu-app signin-page">
      <a className="skip-link" href="#signin-card">Skip to provider sign in</a>
      <div className="signin-brand">
        <span className="wordmark">salu<span>°</span></span>
        <p>Your health concierge.</p>
        <small>Miami · independent providers, filling live requests.</small>
      </div>
      <section className="signin-card" id="signin-card">
        <span className="eyebrow">PROVIDERS</span>
        <h1>Come in. The request queue is waiting.</h1>
        <NativeAccountForm
          kind="provider"
          busy={busy}
          setBusy={setBusy}
          setNotice={setNotice}
          returnTo={safeReturn}
          signInCopy="Use the email on your approved Apply. After approval, this same account opens the workspace with role=provider."
          createCopy="Create the account you’ll use after approval. Role still comes from Apply, SALU_PROVIDER_EMAILS, or the labeled demo."
        />
        <OAuthButtons
          kind="provider"
          surface={surface}
          busy={busy}
          start={(provider, configured, missing) =>
            startOAuth({provider, configured, missing, returnTo: safeReturn, setBusy, setNotice})
          }
        />
        {notice && <p className="signin-notice" role="status">{notice}</p>}
        <p className="signin-footnote">
          Payouts are not live yet. Accepting a request assigns the visit in-app. See PROVIDER.md.
        </p>
        <p className="signin-switch">
          <Link href="/signin">Member sign-in</Link>
        </p>
      </section>
    </div>
  );
}

function NativeAccountForm({
  kind,
  busy,
  setBusy,
  setNotice,
  returnTo,
  signInCopy,
  createCopy,
}: {
  kind: "member" | "provider";
  busy: BusyId | null;
  setBusy: (value: BusyId | null) => void;
  setNotice: (value: string) => void;
  returnTo: string;
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
  surface,
  busy,
  start,
}: {
  kind: "member" | "provider";
  surface: AuthSurface;
  busy: BusyId | null;
  start: (provider: OAuthId, configured: boolean, missing: string) => void;
}) {
  return (
    <>
      <p className="signin-divider" role="separator">or continue with</p>
      <button
        type="button"
        className="signin-google"
        disabled={busy !== null}
        onClick={() =>
          start(
            "google",
            surface.google,
            "Google is coming soon on this deployment. Use email for now — AUTH.md has the optional OAuth keys when you want the shortcut.",
          )
        }
      >
        <GoogleMark />
        {busy === "google" ? "Opening Google…" : surface.google ? "Continue with Google" : "Continue with Google · coming soon"}
      </button>
      <button
        type="button"
        className="signin-apple"
        disabled={busy !== null}
        onClick={() =>
          start(
            "apple",
            surface.apple,
            "Apple is coming soon on this deployment. Use email for now — AUTH.md has the optional Services ID steps when you want the shortcut.",
          )
        }
      >
        <AppleMark />
        {busy === "apple" ? "Opening Apple…" : surface.apple ? "Continue with Apple" : "Continue with Apple · coming soon"}
      </button>
      {surface.development && kind === "member" && (
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

async function postCredentials({
  email,
  password,
  returnTo,
}: {
  email: string;
  password: string;
  returnTo: string;
}) {
  await postAuthForm("/api/auth/signin/credentials", {
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

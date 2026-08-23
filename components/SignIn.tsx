"use client";

import {useState} from "react";
import type {AuthSurface} from "../auth/env";

type ProviderId = "google" | "apple" | "development";

export default function SignIn({
  returnTo = "/",
  surface,
}: {
  returnTo?: string;
  surface: AuthSurface;
}) {
  const [busy, setBusy] = useState<ProviderId | null>(null);
  const [notice, setNotice] = useState("");
  const safeReturn = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/";

  const start = async (provider: ProviderId, configured: boolean, missing: string) => {
    if (!configured) {
      setNotice(missing);
      return;
    }
    setBusy(provider);
    setNotice("");
    try {
      const csrfRes = await fetch("/api/auth/csrf");
      if (!csrfRes.ok) throw new Error("csrf");
      const {csrfToken} = (await csrfRes.json()) as {csrfToken?: string};
      if (!csrfToken) throw new Error("csrf");
      const form = document.createElement("form");
      form.method = "POST";
      form.action = `/api/auth/signin/${provider}`;
      form.append(hidden("csrfToken", csrfToken));
      form.append(hidden("callbackUrl", safeReturn === "/signin" ? "/" : safeReturn));
      document.body.append(form);
      form.submit();
    } catch {
      setBusy(null);
      setNotice("We couldn’t start sign-in just now. Please try again in a moment.");
    }
  };

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
        <p className="signin-copy">
          Continue with the account you already use. Atlas, your Credits and Miami bookings stay with your membership.
        </p>
        <button
          type="button"
          className="signin-google"
          disabled={busy !== null}
          onClick={() =>
            start(
              "google",
              surface.google,
              "Google sign-in is not configured on this deployment. Add AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET — see AUTH.md.",
            )
          }
        >
          <GoogleMark />
          {busy === "google" ? "Opening Google…" : "Continue with Google"}
        </button>
        <button
          type="button"
          className="signin-apple"
          disabled={busy !== null}
          onClick={() =>
            start(
              "apple",
              surface.apple,
              "Apple sign-in is not configured on this deployment. Add your Services ID and key — see AUTH.md.",
            )
          }
        >
          <AppleMark />
          {busy === "apple" ? "Opening Apple…" : "Continue with Apple"}
        </button>
        {surface.development && (
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
        {notice && <p className="signin-notice" role="status">{notice}</p>}
        <p className="signin-footnote">
          Independent providers deliver every service. Atlas does not diagnose or prescribe. For emergencies, call 911.
        </p>
      </section>
    </div>
  );
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

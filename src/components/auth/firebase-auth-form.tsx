"use client";

import { useState, type FormEvent } from "react";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  USERNAME_INPUT_PATTERN,
  USERNAME_REQUIREMENTS,
} from "@/lib/auth/username";
import { getFirebaseAuth } from "@/lib/auth/firebase-client";
import { PasswordField } from "./password-field";

async function exchangeFirebaseToken(token: string): Promise<boolean> {
  const response = await fetch("/api/auth/firebase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return response.ok;
}

function reportFirebaseAuthFailure(stage: string, error: unknown) {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("auth/")
      ? error.code
      : "unknown";
  console.error("Firebase authentication failed.", { stage, code });
}

export function FirebaseGoogleButton() {
  const [pending, setPending] = useState(false);

  return (
    <>
      <div className="auth-alternative"><span>or</span></div>
      <div className="auth-oauth">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setPending(true);
            beginFirebaseGoogleSignIn();
          }}
        >
          {pending ? "Signing in…" : "Continue with Google"}
        </button>
      </div>
    </>
  );
}

export function beginFirebaseGoogleSignIn(
  navigate: (url: string) => void = (url) => window.location.assign(url),
) {
  sessionStorage.setItem("flight-map.firebase.redirect-state", "start");
  sessionStorage.setItem("flight-map.firebase.return-to", "/map");
  navigate("/auth/firebase/callback");
}

export function FirebaseCredentialsSignInForm() {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.checkValidity()) return;
    setPending(true);
    setFailed(false);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");
    try {
      const credential = await signInWithEmailAndPassword(
        getFirebaseAuth(),
        email,
        password,
      );
      if (!(await exchangeFirebaseToken(await credential.user.getIdToken(true)))) {
        throw new Error("exchange rejected");
      }
      window.location.assign("/map");
      return;
    } catch (error) {
      reportFirebaseAuthFailure("credentials-sign-in", error);
      const response = await fetch("/api/auth/credentials", {
        method: "POST",
        body: form,
      });
      if (response.url.endsWith("/map")) {
        window.location.assign("/map");
        return;
      }
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit} aria-busy={pending}>
      {failed && <p className="auth-message auth-message-error" role="alert">We couldn&apos;t sign you in. Check your credentials and verification status.</p>}
      <div className="auth-field">
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" inputMode="email" aria-describedby="email-hint" required />
        <small id="email-hint">Use the email address you registered with.</small>
      </div>
      <PasswordField id="password" name="password" label="Password" autoComplete="current-password" hint="Passwords are case-sensitive." />
      <button className="auth-submit" type="submit" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function FirebaseRegistrationForm() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.checkValidity()) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    const email = String(form.get("email") ?? "");
    const username = String(form.get("username") ?? "");
    if (password !== String(form.get("confirmPassword") ?? "")) {
      setFailed(true);
      return;
    }
    setPending(true);
    setFailed(false);
    try {
      const screening = await fetch("/api/auth/firebase/register-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, username, password }),
      });
      if (!screening.ok) throw new Error("registration rejected");
      const credential = await createUserWithEmailAndPassword(
        getFirebaseAuth(),
        email,
        password,
      );
      await updateProfile(credential.user, {
        displayName: username,
      });
      await sendEmailVerification(credential.user, {
        url: `${window.location.origin}/auth/sign-in?verified=true`,
      });
      await signOut(getFirebaseAuth());
      setSent(true);
    } catch (error) {
      reportFirebaseAuthFailure("registration", error);
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  if (sent) {
    return <p className="auth-message auth-message-success" role="status">Check your inbox and verify your email before signing in.</p>;
  }
  return (
    <form className="auth-form" onSubmit={submit} aria-busy={pending}>
      {failed && <p className="auth-message auth-message-error" role="alert">Account creation is temporarily unavailable or the account already exists.</p>}
      <div className="auth-field">
        <label htmlFor="email">Email address</label>
        <input id="email" name="email" type="email" autoComplete="email" inputMode="email" aria-describedby="email-hint" required />
        <small id="email-hint">We use this to verify and secure your account.</small>
      </div>
      <div className="auth-field">
        <label htmlFor="username">Username</label>
        <input id="username" name="username" autoComplete="username" pattern={USERNAME_INPUT_PATTERN} aria-describedby="username-hint" required />
        <small id="username-hint">{USERNAME_REQUIREMENTS}</small>
      </div>
      <PasswordField id="password" name="password" label="Password" autoComplete="new-password" minLength={12} maxLength={128} hint="Use at least 12 characters." />
      <PasswordField id="confirm-password" name="confirmPassword" label="Confirm password" autoComplete="new-password" minLength={12} maxLength={128} hint="Re-enter the same password." />
      <button className="auth-submit" type="submit" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}

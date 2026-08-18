import Link from "next/link";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { PasswordField } from "@/components/auth/password-field";
import { FirebaseRegistrationForm } from "@/components/auth/firebase-auth-form";
import { firebasePublicConfig } from "@/lib/auth/firebase-config";
import {
  USERNAME_INPUT_PATTERN,
  USERNAME_REQUIREMENTS,
} from "@/lib/auth/username";

const errors: Record<string, string> = {
  "invalid-email": "Enter a valid email address.",
  "invalid-username": USERNAME_REQUIREMENTS,
  "invalid-password":
    "Passwords must match and contain between 12 and 128 characters.",
  "registration-unavailable": "Registration is temporarily unavailable.",
};

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const error = typeof params.error === "string" ? errors[params.error] : null;
  const configured = Boolean(process.env.DATABASE_URL);
  const firebaseConfigured = configured && Boolean(firebasePublicConfig());

  return (
    <AuthShell
      eyebrow="Your private flight archive"
      title="Create your Waypointer account"
      description="Start a personal map you can build from your own flight history."
      footer={
        <p>
          Already have an account? <Link href="/auth/sign-in">Sign in</Link>
        </p>
      }
    >
        {!configured && (
          <p className="auth-message auth-message-info" id="auth-unavailable" role="status">
            Account creation is unavailable in this preview environment.
          </p>
        )}
        {error && <p className="auth-message auth-message-error" role="alert">{error}</p>}
        {firebaseConfigured ? (
          <FirebaseRegistrationForm />
        ) : (
        <AuthForm
          action="/api/auth/register"
          submitLabel="Create account"
          pendingLabel="Creating account…"
          disabled={!configured}
        >
          <div className="auth-field">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              aria-describedby="email-hint"
              required
            />
            <small id="email-hint">
              We use this to verify and secure your account.
            </small>
          </div>
          <div className="auth-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              pattern={USERNAME_INPUT_PATTERN}
              aria-describedby="username-hint"
              required
            />
            <small id="username-hint">
              {USERNAME_REQUIREMENTS}
            </small>
          </div>
          <PasswordField
            id="password"
            name="password"
            label="Password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            hint="Use at least 12 characters. A passphrase is easiest to remember."
          />
          <PasswordField
            id="confirm-password"
            name="confirmPassword"
            label="Confirm password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            hint="Re-enter the same password."
          />
        </AuthForm>
        )}
    </AuthShell>
  );
}

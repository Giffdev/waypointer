import Link from "next/link";
import { redirect } from "next/navigation";
import { getOptionalAuthenticatedUser } from "@/lib/auth/guards";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { PasswordField } from "@/components/auth/password-field";
import { configuredOAuthProviderIds } from "@/lib/auth/oauth-providers";
import { OAuthSignInButtons } from "@/components/auth/oauth-buttons";
import {
  FirebaseCredentialsSignInForm,
  FirebaseGoogleButton,
} from "@/components/auth/firebase-auth-form";
import { firebasePublicConfig } from "@/lib/auth/firebase-config";

const errors: Record<string, string> = {
  "invalid-credentials":
    "We couldn't sign you in. Check your email and password, and make sure you've verified your email.",
  "sign-in-unavailable":
    "Sign-in is temporarily unavailable. Please wait a moment and try again.",
  "firebase-sign-in-incomplete":
    "Google sign-in could not be completed. Please try again.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await getOptionalAuthenticatedUser()) redirect("/map");
  const params = await searchParams;
  const error = typeof params.error === "string" ? errors[params.error] : null;
  const verified = params.verified === "true";
  const authConfigured = Boolean(process.env.DATABASE_URL);
  const firebaseConfigured =
    authConfigured && Boolean(firebasePublicConfig());
  const oauthProviders = configuredOAuthProviderIds().filter(
    (provider) => !firebaseConfigured || provider !== "google",
  );

  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Sign in to Waypointer"
      description="Open your private map, flight history, and imports."
      footer={
        <p>
          New to Waypointer?{" "}
          <Link href="/auth/register">Create an account</Link>
        </p>
      }
    >
        {!authConfigured && (
          <p className="auth-message auth-message-info" id="auth-unavailable" role="status">
            Sign-in is unavailable in this preview environment.
          </p>
        )}
        {error && <p className="auth-message auth-message-error" role="alert">{error}</p>}
        {verified && (
          <p className="auth-message auth-message-success" role="status">
            Email verified. Sign in to continue.
          </p>
        )}
        {firebaseConfigured ? (
          <FirebaseCredentialsSignInForm />
        ) : (
          <AuthForm
            action="/api/auth/credentials"
            submitLabel="Sign in"
            pendingLabel="Signing in…"
            disabled={!authConfigured}
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
                Use the email address you registered with.
              </small>
            </div>
            <PasswordField
              id="password"
              name="password"
              label="Password"
              autoComplete="current-password"
              hint="Passwords are case-sensitive."
            />
          </AuthForm>
        )}
        {firebaseConfigured && <FirebaseGoogleButton />}
        <OAuthSignInButtons providerIds={oauthProviders} />
    </AuthShell>
  );
}

import Link from "next/link";
import { cookies } from "next/headers";
import {
  BREACHED_PASSWORD_WARNING_COOKIE,
  isBreachedPasswordWarning,
} from "@/lib/auth/registration-warning";
import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const email = typeof params.email === "string" ? params.email : "";
  const token = typeof params.token === "string" ? params.token : "";
  const canVerify = Boolean(email && token);
  const cookieStore = await cookies();
  const showBreachedPasswordWarning = isBreachedPasswordWarning(
    cookieStore.get(BREACHED_PASSWORD_WARNING_COOKIE)?.value,
  );

  return (
    <AuthShell
      eyebrow="One last step"
      title={canVerify ? "Verify your email" : "Check your inbox"}
      description={
        canVerify
          ? "Confirm your email to protect access to your private flight history."
          : "We sent a verification link to the email address you registered."
      }
      footer={
        <p>
          Already verified? <Link href="/auth/sign-in">Return to sign in</Link>
        </p>
      }
    >
        {showBreachedPasswordWarning && (
          <p className="auth-message auth-message-warning" role="alert">
            This password appeared in a known data breach. Verify your email,
            then change it before adding flight history.
          </p>
        )}
        {params.error && (
          <div className="auth-message auth-message-error" role="alert">
            <strong>This verification link is invalid or expired.</strong>
            <span>Open the newest link in your inbox, or return to sign in.</span>
          </div>
        )}
        {params.sent === "true" && (
          <div className="auth-message auth-message-success" role="status">
            <strong>Verification email sent.</strong>
            <span>
              {email ? <>We sent it to <b>{email}</b>. </> : null}
              The link expires in 24 hours. Check spam if it does not arrive.
            </span>
          </div>
        )}
        {canVerify && (
          <AuthForm
            action="/api/auth/verify"
            submitLabel="Verify email"
            pendingLabel="Verifying…"
          >
            <input type="hidden" name="email" value={email} />
            <input type="hidden" name="token" value={token} />
          </AuthForm>
        )}
    </AuthShell>
  );
}

import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { FirebaseRedirectHandler } from "@/components/auth/firebase-redirect-handler";

export default function FirebaseCallbackPage() {
  return (
    <AuthShell
      eyebrow="Secure sign-in"
      title="Completing your account sign-in"
      description="Waypointer is verifying your identity and opening your private map."
      footer={<p><Link href="/auth/sign-in">Return to sign in</Link></p>}
    >
      <FirebaseRedirectHandler />
    </AuthShell>
  );
}

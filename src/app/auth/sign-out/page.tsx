import { SessionSignOutButton } from "@/components/auth/session-sign-out-button";

export const dynamic = "force-dynamic";

export default function SignOutPage() {
  return (
    <main className="app-shell" id="main-content" tabIndex={-1}>
      <section className="content-section route-page">
        <h1>Sign out of Waypointer?</h1>
        <SessionSignOutButton />
      </section>
    </main>
  );
}

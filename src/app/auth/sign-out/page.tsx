import { signOut } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default function SignOutPage() {
  return (
    <main className="app-shell" id="main-content">
      <section className="content-section route-page">
        <h1>Sign out of Waypointer?</h1>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/auth/sign-in" });
          }}
        >
          <button type="submit">Sign out</button>
        </form>
      </section>
    </main>
  );
}

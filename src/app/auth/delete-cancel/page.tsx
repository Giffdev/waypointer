import Link from "next/link";

export default async function DeleteCancellationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = typeof params.token === "string" ? params.token : "";
  const processed = params.result === "processed";
  return (
    <main className="app-shell" id="main-content">
      <section className="content-section route-page">
        <p className="eyebrow">Private account recovery</p>
        <h1>Cancel account deletion</h1>
        {processed ? (
          <p role="status">
            If the link was valid and still within its grace period, deletion
            was cancelled. Sign in again; old sessions and jobs remain revoked.
          </p>
        ) : (
          <>
            <p>
              This single-use link restores the private account only. It does
              not restore sessions or cancelled background work.
            </p>
            <form action="/api/account/delete/cancel" method="post">
              <input type="hidden" name="token" value={token} />
              <button type="submit" disabled={!token}>
                Cancel account deletion
              </button>
            </form>
          </>
        )}
        <Link href="/auth/sign-in">Return to sign in</Link>
      </section>
    </main>
  );
}

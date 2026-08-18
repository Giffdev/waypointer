import { signIn } from "@/lib/auth";
import {
  OAUTH_PROVIDER_DETAILS,
  type OAuthProviderId,
} from "@/lib/auth/oauth-providers";

export function OAuthSignInButtons({
  providerIds,
}: {
  providerIds: OAuthProviderId[];
}) {
  if (providerIds.length === 0) return null;
  return (
    <>
      <div className="auth-alternative">
        <span>or</span>
      </div>
      {providerIds.map((providerId) => (
        <form
          className="auth-oauth"
          key={providerId}
          action={async () => {
            "use server";
            await signIn(providerId, { redirectTo: "/map" });
          }}
        >
          <button type="submit">
            {OAUTH_PROVIDER_DETAILS[providerId].label}
          </button>
        </form>
      ))}
    </>
  );
}

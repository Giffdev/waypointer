export const OAUTH_PROVIDER_DETAILS = {
  google: {
    id: "google",
    label: "Continue with Google",
  },
  "microsoft-entra-id": {
    id: "microsoft-entra-id",
    label: "Continue with Microsoft",
  },
} as const;

export type OAuthProviderId = keyof typeof OAUTH_PROVIDER_DETAILS;

export function configuredOAuthProviderIds(
  environment: NodeJS.ProcessEnv = process.env,
): OAuthProviderId[] {
  const providers: OAuthProviderId[] = [];
  if (environment.AUTH_GOOGLE_ID && environment.AUTH_GOOGLE_SECRET) {
    providers.push("google");
  }
  if (
    environment.AUTH_MICROSOFT_ENTRA_ID_ID &&
    environment.AUTH_MICROSOFT_ENTRA_ID_SECRET
  ) {
    providers.push("microsoft-entra-id");
  }
  return providers;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function verifiedMicrosoftEmails(profile: Record<string, unknown>): string[] {
  return [
    ...(Array.isArray(profile.verified_primary_email)
      ? profile.verified_primary_email
      : []),
    ...(Array.isArray(profile.verified_secondary_email)
      ? profile.verified_secondary_email
      : []),
  ].map(normalizeEmail);
}

export function isVerifiedOAuthEmail(
  provider: string | undefined,
  profile: Record<string, unknown> | undefined,
  email: string,
): boolean {
  if (!profile || !email) return false;
  if (provider === "google") return profile.email_verified === true;
  if (provider === "microsoft-entra-id") {
    return (
      profile.xms_edov === true ||
      verifiedMicrosoftEmails(profile).includes(normalizeEmail(email))
    );
  }
  return false;
}

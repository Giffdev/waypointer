import { describe, expect, it } from "vitest";
import {
  configuredOAuthProviderIds,
  isVerifiedOAuthEmail,
  OAUTH_PROVIDER_DETAILS,
} from "./oauth-providers";

describe("conditional OAuth providers", () => {
  it("does not expose partially or entirely unconfigured providers", () => {
    expect(configuredOAuthProviderIds({})).toEqual([]);
    expect(
      configuredOAuthProviderIds({ AUTH_GOOGLE_ID: "google-client" }),
    ).toEqual([]);
    expect(
      configuredOAuthProviderIds({
        AUTH_MICROSOFT_ENTRA_ID_SECRET: "entra-secret",
      }),
    ).toEqual([]);
  });

  it("exposes each provider only when its complete credential pair exists", () => {
    expect(
      configuredOAuthProviderIds({
        AUTH_GOOGLE_ID: "google-client",
        AUTH_GOOGLE_SECRET: "google-secret",
        AUTH_MICROSOFT_ENTRA_ID_ID: "entra-client",
        AUTH_MICROSOFT_ENTRA_ID_SECRET: "entra-secret",
      }),
    ).toEqual(["google", "microsoft-entra-id"]);
    expect(OAUTH_PROVIDER_DETAILS["microsoft-entra-id"].label).toBe(
      "Continue with Microsoft",
    );
  });
});

describe("verified OAuth email policy", () => {
  it("requires provider-specific verified-email proof", () => {
    expect(
      isVerifiedOAuthEmail(
        "google",
        { email_verified: true },
        "pilot@example.test",
      ),
    ).toBe(true);
    expect(
      isVerifiedOAuthEmail(
        "microsoft-entra-id",
        { xms_edov: true },
        "pilot@example.test",
      ),
    ).toBe(true);
    expect(
      isVerifiedOAuthEmail(
        "microsoft-entra-id",
        { verified_primary_email: ["Pilot@Example.test"] },
        "pilot@example.test",
      ),
    ).toBe(true);
    expect(
      isVerifiedOAuthEmail(
        "microsoft-entra-id",
        { email: "pilot@example.test" },
        "pilot@example.test",
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  CANONICAL_PRODUCTION_ORIGIN,
  isProductionGoogleReauthRequested,
  requireProductionGoogleReauthConfig,
} from "./production-reauth-gate";

const configuredEnvironment = {
  FLIGHT_MAP_E2E_GOOGLE_REAUTH: "true",
  FLIGHT_MAP_E2E_BASE_URL: CANONICAL_PRODUCTION_ORIGIN,
  FLIGHT_MAP_E2E_GOOGLE_STORAGE_STATE: ".playwright-mcp/google-reauth.json",
  FLIGHT_MAP_E2E_GOOGLE_EMAIL: "approved@example.com",
};

describe("production Google reauthentication gate", () => {
  it("only skips when the opt-in is absent or explicitly false", () => {
    expect(isProductionGoogleReauthRequested({})).toBe(false);
    expect(
      isProductionGoogleReauthRequested({
        FLIGHT_MAP_E2E_GOOGLE_REAUTH: "false",
      }),
    ).toBe(false);
    expect(
      isProductionGoogleReauthRequested({
        FLIGHT_MAP_E2E_GOOGLE_REAUTH: "TRUE",
      }),
    ).toBe(true);
  });

  it("accepts a complete canonical configuration", () => {
    expect(requireProductionGoogleReauthConfig(configuredEnvironment)).toEqual({
      email: "approved@example.com",
      maxMs: 15_000,
    });
  });

  it.each([
    "FLIGHT_MAP_E2E_BASE_URL",
    "FLIGHT_MAP_E2E_GOOGLE_STORAGE_STATE",
    "FLIGHT_MAP_E2E_GOOGLE_EMAIL",
  ])("names a missing or empty %s", (variableName) => {
    expect(() =>
      requireProductionGoogleReauthConfig({
        ...configuredEnvironment,
        [variableName]: "",
      }),
    ).toThrow(variableName);
  });

  it("rejects a non-canonical origin", () => {
    expect(() =>
      requireProductionGoogleReauthConfig({
        ...configuredEnvironment,
        FLIGHT_MAP_E2E_BASE_URL: "https://preview.example.com",
      }),
    ).toThrow(
      `Production Google reauthentication must target ${CANONICAL_PRODUCTION_ORIGIN}.`,
    );
  });

  it("rejects an unrecognized opt-in value instead of silently skipping", () => {
    expect(() =>
      requireProductionGoogleReauthConfig({
        ...configuredEnvironment,
        FLIGHT_MAP_E2E_GOOGLE_REAUTH: "TRUE",
      }),
    ).toThrow("must be exactly true or false");
  });
});

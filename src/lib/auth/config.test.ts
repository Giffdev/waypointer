import { describe, expect, it } from "vitest";
import { authConfig } from "./config";

describe("Auth.js session configuration", () => {
  it("keeps revocable database sessions without an Auth.js Credentials provider", () => {
    expect(authConfig.session?.strategy).toBe("database");
    const providerIds = authConfig.providers.map((provider) => {
      const configured =
        typeof provider === "function" ? provider() : provider;
      return configured.id;
    });
    expect(providerIds).not.toContain("credentials");
  });
});

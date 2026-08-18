import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/pg-core";
import { NextResponse } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accounts, importRows } from "@/lib/db/schema";
import { withoutOAuthBearerTokens } from "./account-persistence";
import {
  applyBreachedPasswordWarning,
  BREACHED_PASSWORD_WARNING_COOKIE,
  BREACHED_PASSWORD_WARNING_MAX_AGE_SECONDS,
  isBreachedPasswordWarning,
} from "./registration-warning";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OAuth account persistence", () => {
  it("strips bearer tokens before calling the Auth.js adapter", () => {
    const sanitized = withoutOAuthBearerTokens({
      userId: "00000000-0000-4000-8000-000000000001",
      provider: "google",
      providerAccountId: "provider-user",
      type: "oauth",
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      id_token: "identity-secret",
      token_type: "bearer",
      scope: "openid profile email",
    });

    expect(sanitized).toMatchObject({
      access_token: undefined,
      refresh_token: undefined,
      id_token: undefined,
      provider: "google",
      providerAccountId: "provider-user",
    });
  });

  it("enforces null OAuth bearer-token columns at the schema and migration layers", () => {
    const accountConfig = getTableConfig(accounts);
    expect(accountConfig.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "accounts_access_token_null",
        "accounts_refresh_token_null",
        "accounts_id_token_null",
      ]),
    );

    const migration = readFileSync(
      fileURLToPath(
        new URL(
          "../../../drizzle/migrations/0001_privacy_retention_hardening.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(migration).toContain('SET "refresh_token" = NULL');
    expect(migration).toContain('CHECK ("access_token" IS NULL)');
    expect(migration).toContain('CHECK ("id_token" IS NULL)');
    expect(migration).toContain(
      'ALTER TABLE "import_rows" DISABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain(
      'ALTER TABLE "import_rows" FORCE ROW LEVEL SECURITY',
    );
  });
});

describe("raw import snapshot schema", () => {
  it("allows snapshots to be scrubbed to null", () => {
    const rawSnapshot = getTableConfig(importRows).columns.find(
      (column) => column.name === "raw_snapshot",
    );
    expect(rawSnapshot?.notNull).toBe(false);
  });
});

describe("breached-password flash warning", () => {
  it("uses a short-lived secure HttpOnly SameSite cookie, not redirect state", () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = applyBreachedPasswordWarning(
      NextResponse.redirect(
        "https://flight-map.example/auth/verify?sent=true",
        303,
      ),
      true,
    );

    expect(response.headers.get("location")).toBe(
      "https://flight-map.example/auth/verify?sent=true",
    );
    expect(response.headers.get("location")).not.toContain("warning");
    expect(response.cookies.get(BREACHED_PASSWORD_WARNING_COOKIE)?.value).toBe(
      "breached-password",
    );
    expect(
      isBreachedPasswordWarning(
        response.cookies.get(BREACHED_PASSWORD_WARNING_COOKIE)?.value,
      ),
    ).toBe(true);

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/auth\/verify/i);
    expect(setCookie).toContain(
      `Max-Age=${BREACHED_PASSWORD_WARNING_MAX_AGE_SECONDS}`,
    );
  });

  it("does not create warning state for a non-breached password", () => {
    const response = applyBreachedPasswordWarning(
      NextResponse.redirect("http://localhost:3000/auth/verify?sent=true", 303),
      false,
    );
    expect(response.cookies.get(BREACHED_PASSWORD_WARNING_COOKIE)).toBeUndefined();
  });
});

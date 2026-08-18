// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RegisterPage from "./page";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("public registration page", () => {
  it("does not restore an access-code or allowlist gate under legacy production variables", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "******db.example.test/flight_map");
    vi.stubEnv("FLIGHT_MAP_HOSTED_PREVIEW", "true");
    vi.stubEnv(
      "AUTH_PREVIEW_ACCESS_SECRET",
      "retired-secret-must-not-affect-registration",
    );
    vi.stubEnv(
      "AUTH_PREVIEW_ALLOWED_EMAILS",
      "different.person@example.test",
    );

    render(
      await RegisterPage({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(
      screen.getByRole("heading", { name: "Create your Waypointer account" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Email address")).toBeRequired();
    const username = screen.getByLabelText("Username");
    expect(username).toBeRequired();
    expect(() => new RegExp(username.getAttribute("pattern")!, "v")).not.toThrow();
    expect(
      screen.getByRole("button", { name: "Create account" }),
    ).toBeEnabled();
    expect(
      screen.queryByLabelText(/access code|invitation code/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/allowlist|approved test account|invitation/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create account" }).closest("form"),
    ).toHaveAttribute("action", "/api/auth/register");
  });

  it("uses Firebase registration only when its complete bridge configuration is present", async () => {
    vi.stubEnv("DATABASE_URL", "******db.example.test/flight_map");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "public-api-key");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "flight-map.example");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "flight-map");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "web-app-id");

    render(
      await RegisterPage({
        searchParams: Promise.resolve({}),
      }),
    );

    const form = screen
      .getByRole("button", { name: "Create account" })
      .closest("form");
    expect(form).not.toHaveAttribute("action");
    expect(screen.getByLabelText("Email address")).toBeRequired();
    expect(screen.getByLabelText("Username")).toBeRequired();
  });
});

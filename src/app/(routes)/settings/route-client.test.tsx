// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import SettingsClient from "./route-client";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const profile = {
  email: "pilot@example.test",
  username: "pilot",
  displayName: "Test Pilot",
  timeZone: "UTC",
  distanceUnit: "miles" as const,
  mapViewMode: "globe" as const,
  hasPassword: true,
};

describe("private settings UI", () => {
  it("exposes only owner settings and explicit destructive confirmation", () => {
    render(
      <SettingsClient
        initialProfile={profile}
        configured
        deletionEnabled
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Private account settings" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("Username")).toBeEnabled();
    expect(screen.getByLabelText("Username")).toHaveAttribute(
      "pattern",
      "[A-Za-z0-9][A-Za-z0-9_\\x2d]{2,29}",
    );
    expect(screen.getByText(/usernames are case-insensitive/i))
      .toBeInTheDocument();
    expect(screen.queryByLabelText("Time zone")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Distance unit")).toHaveValue("miles");
    expect(screen.getByRole("button", { name: "Save profile" }))
      .toHaveClass("primary-button", "profile-save-button", "idle");
    expect(screen.getByLabelText("Current password")).toBeRequired();
    expect(screen.getByLabelText("Type DELETE to confirm")).toHaveAttribute(
      "pattern",
      "DELETE",
    );
    expect(screen.queryByText(/public profile URL/i)).not.toBeInTheDocument();
  });

  it("shows a taken username inline without losing the entered value", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "username-taken",
              message: "That username is already taken. Try another.",
            },
          }),
          {
            status: 409,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    render(
      <SettingsClient
        initialProfile={profile}
        configured
        deletionEnabled
      />,
    );

    const username = screen.getByLabelText("Username");
    await user.clear(username);
    await user.type(username, "TAKEN_PILOT");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(
      await screen.findByText("That username is already taken. Try another."),
    ).toHaveAttribute("role", "alert");
    expect(username).toHaveValue("TAKEN_PILOT");
    expect(username).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save profile" }))
      .toHaveClass("error");
    const request = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({
      username: "taken_pilot",
      timeZone: "UTC",
    });
  });

  it("shows disabled saving and success button states", async () => {
    let resolveSave!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveSave = resolve;
          }),
      ),
    );
    render(
      <SettingsClient
        initialProfile={profile}
        configured
        deletionEnabled
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    const saving = await screen.findByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
    expect(saving).toHaveAttribute("aria-busy", "true");
    expect(saving).toHaveClass("saving");

    resolveSave(
      new Response(JSON.stringify({ profile }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const saved = await screen.findByRole("button", { name: "Saved" });
    expect(saved).toBeEnabled();
    expect(saved).toHaveClass("success");
    expect(screen.getByText("Private profile saved."))
      .toHaveAttribute("role", "status");
  });

  it("hides destructive controls when verified email delivery is unavailable", () => {
    render(
      <SettingsClient
        initialProfile={profile}
        configured
        deletionEnabled={false}
      />,
    );

    expect(
      screen.getByText(/account deletion is temporarily unavailable/i),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Type DELETE to confirm"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete my account" }),
    ).not.toBeInTheDocument();
  });
});

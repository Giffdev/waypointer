/* @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getOptionalAuthenticatedUser, redirect } = vi.hoisted(() => ({
  getOptionalAuthenticatedUser: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({ getOptionalAuthenticatedUser }));
vi.mock("next/navigation", () => ({ redirect }));

import Home from "./page";

describe("signed-out homepage", () => {
  afterEach(cleanup);

  beforeEach(() => {
    getOptionalAuthenticatedUser.mockReset();
    redirect.mockReset();
    getOptionalAuthenticatedUser.mockResolvedValue(null);
  });

  it("renders acquisition content at the root for signed-out visitors", async () => {
    render(await Home());

    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "Turn your flight logs into a map",
    );
    expect(screen.getByRole("main").getAttribute("id")).toBe("main-content");
    expect(screen.getByRole("navigation", { name: "Homepage navigation" })).toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("sends signed-in users to their existing map experience", async () => {
    getOptionalAuthenticatedUser.mockResolvedValue({
      id: "synthetic-user",
      email: "preview@example.invalid",
    });

    await Home();

    expect(redirect).toHaveBeenCalledWith("/map");
  });

  it("provides clear account creation and sign-in destinations", async () => {
    render(await Home());

    const createLinks = screen.getAllByRole("link", { name: /create/i });
    expect(createLinks.some((link) => link.getAttribute("href") === "/auth/register")).toBe(true);
    expect(
      screen.getAllByRole("link", { name: /sign in|already have an account/i })
        .every((link) => link.getAttribute("href") === "/auth/sign-in"),
    ).toBe(true);
  });

  it("describes automatic commit with review only for unresolved exceptions", async () => {
    render(await Home());

    expect(screen.getByText(/Unresolved fields and rows stay available for review/i)).toBeTruthy();
    expect(screen.getByText(/Clean, resolved rows map, deduplicate, and commit automatically/i)).toBeTruthy();
    expect(
      screen.getAllByText(/Only unresolved exceptions wait for review/i).length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: /Private by default/i })).toBeTruthy();
  });

  it("does not advertise unreleased manual entry or sharing capabilities", async () => {
    const { container } = render(await Home());

    expect(container.textContent).not.toMatch(
      /manual entry|add a flight manually|view-only map|sharing is enabled|shared map|revoke.*link|replace.*link/i,
    );
  });

  it("uses explicitly synthetic product previews and a responsive journey structure", async () => {
    const { container } = render(await Home());

    expect(screen.getByText("Synthetic preview")).toBeTruthy();
    expect(container.querySelectorAll('[data-preview="synthetic"]')).toHaveLength(2);
    expect(container.querySelector("ol")?.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByText("ForeFlight")).toBeTruthy();
    expect(screen.getByText("Generic CSV")).toBeTruthy();
    expect(container.textContent).not.toMatch(/@[a-z0-9-]+\.(com|net|org)\b/i);
  });
});

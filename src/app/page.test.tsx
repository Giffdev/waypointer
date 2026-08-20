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

  it("explains automatic map updates in user-centered language", async () => {
    render(await Home());

    const heading = screen.getByRole("heading", {
      name: "See your flights on the map",
    });
    const card = heading.closest("li");
    expect(card?.querySelector("p")?.textContent).toBe(
      "Waypointer checks each uploaded flight, asks for help only when something needs attention, and adds ready flights to your map automatically.",
    );
    expect(card?.textContent).not.toMatch(
      /\b(commit\w*|resolved|unresolved|exceptions?|pipeline|processing state)\b/i,
    );
    expect(screen.getByRole("heading", { name: /Private by default/i })).toBeTruthy();
  });

  it("does not advertise unreleased manual entry or sharing capabilities", async () => {
    const { container } = render(await Home());

    expect(container.textContent).not.toMatch(
      /manual entry|add a flight manually|view-only map|sharing is enabled|shared map|revoke.*link|replace.*link/i,
    );
  });

  it("uses a safe demo map experience and a responsive journey structure", async () => {
    const { container } = render(await Home());

    const mapPreview = screen.getByRole("img", {
      name: /Waypointer map showing demo flight routes across an interactive globe/i,
    });
    expect(mapPreview.getAttribute("data-visual")).toBe("map-experience");
    expect(mapPreview.querySelector("svg")).toBeTruthy();
    expect(
      Array.from(mapPreview.querySelectorAll("text"), (label) => label.textContent),
    ).toEqual(["SEA", "JFK", "HNL", "LHR"]);
    expect(container.querySelectorAll('[data-preview="demo-fixture"]')).toHaveLength(2);
    expect(screen.queryByText("Synthetic preview")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("ol")?.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByText("ForeFlight")).toBeTruthy();
    expect(screen.getByText("Generic CSV")).toBeTruthy();
    expect(container.textContent).not.toMatch(/@[a-z0-9-]+\.(com|net|org)\b/i);
  });
});

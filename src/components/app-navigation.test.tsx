// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/auth/sign-out/actions", () => ({
  signOutToHomepage: vi.fn(),
}));

import AppNavigation from "./app-navigation";

let pathname = "/map";
let query =
  "type=private&period=custom&year=2025&month=7&source=ForeFlight&aircraft=C172&registration=N123EX";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(query),
}));

afterEach(cleanup);

describe("application navigation", () => {
  beforeEach(() => {
    pathname = "/map";
    query =
      "type=private&period=custom&year=2025&month=7&source=ForeFlight&aircraft=C172&registration=N123EX";
    window.history.replaceState(null, "", "/map");
  });

  it("preserves normalized flight filters between Map and Flights only", () => {
    render(<AppNavigation onOpenAuth={() => undefined} />);
    const expected =
      "?type=private&period=custom&year=2025&month=7&source=ForeFlight&aircraft=C172&registration=N123EX";
    expect(screen.getAllByRole("link", { name: "Map" })[0]).toHaveAttribute(
      "href",
      `/map${expected}`,
    );
    expect(screen.getAllByRole("link", { name: "Flights" })[0]).toHaveAttribute(
      "href",
      `/flights${expected}`,
    );
    expect(screen.getAllByRole("link", { name: "Import" })[0]).toHaveAttribute(
      "href",
      "/import",
    );
    expect(screen.getAllByRole("link", { name: "Settings" })[0]).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  it("exposes active desktop and mobile navigation", () => {
    render(<AppNavigation onOpenAuth={() => undefined} />);
    const mapLinks = screen.getAllByRole("link", { name: "Map" });
    expect(mapLinks).toHaveLength(2);
    mapLinks.forEach((link) => expect(link).toHaveAttribute("aria-current", "page"));
    expect(screen.getByRole("navigation", { name: "Primary navigation" })).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Mobile primary navigation" }),
    ).toBeInTheDocument();
  });

  it("moves focus to the main region from the skip link", () => {
    render(
      <>
        <AppNavigation onOpenAuth={() => undefined} />
        <main id="main-content" tabIndex={-1}>Map content</main>
      </>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Skip to main content" }));
    expect(screen.getByRole("main")).toHaveFocus();
  });

  it("provides a single polite route announcement", () => {
    render(<AppNavigation onOpenAuth={() => undefined} />);
    expect(screen.getByRole("status", { name: "Route change" })).toHaveTextContent(
      "Map page loaded",
    );
    expect(screen.getAllByRole("status", { name: "Route change" })).toHaveLength(1);
  });

  it("opens a real account menu with existing actions", async () => {
    const user = userEvent.setup();
    render(
      <AppNavigation
        user={{ name: "Test Pilot", email: "pilot@example.test" }}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Account menu for pilot@example.test",
    });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("menu", { name: "Account actions" }),
    ).not.toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Account actions" }))
      .toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Settings" }))
      .toHaveAttribute("href", "/settings");
    expect(screen.getByRole("menuitem", { name: "Sign out" }))
      .toHaveAttribute("type", "submit");
  });

  it("keeps the sign-out form connected through submission", async () => {
    const user = userEvent.setup();
    render(
      <AppNavigation
        user={{ name: "Test Pilot", email: "pilot@example.test" }}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Account menu for pilot@example.test",
      }),
    );
    const button = screen.getByRole("menuitem", { name: "Sign out" });
    const form = button.closest("form");
    expect(form).not.toBeNull();
    let connectedDuringSubmit = false;
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      connectedDuringSubmit = form.isConnected;
    });

    await user.click(button);

    expect(connectedDuringSubmit).toBe(true);
    expect(
      screen.getByRole("menu", { name: "Account actions" }),
    ).toBeInTheDocument();
  });

  it("supports keyboard navigation, Escape focus restoration, and outside dismissal", async () => {
    const user = userEvent.setup();
    render(
      <AppNavigation
        user={{ name: "Test Pilot", email: "pilot@example.test" }}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Account menu for pilot@example.test",
    });

    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("menu", { name: "Account actions" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(
      screen.queryByRole("menu", { name: "Account actions" }),
    ).not.toBeInTheDocument();
  });
});

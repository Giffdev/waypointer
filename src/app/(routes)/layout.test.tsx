// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOptionalAuthenticatedUser: vi.fn(),
  getFlightMapRuntimeMode: vi.fn(),
}));

vi.mock("@/components/app-navigation", () => ({
  default: () => <nav aria-label="Primary navigation" />,
}));
vi.mock("@/lib/auth/guards", () => ({
  getOptionalAuthenticatedUser: mocks.getOptionalAuthenticatedUser,
}));
vi.mock("@/lib/runtime-mode", () => ({
  getFlightMapRuntimeMode: mocks.getFlightMapRuntimeMode,
}));

import RoutesLayout from "./layout";

describe("routes layout runtime notice", () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it("does not render the routine MVP production banner or status landmark", async () => {
    mocks.getOptionalAuthenticatedUser.mockResolvedValue(null);
    mocks.getFlightMapRuntimeMode.mockReturnValue({
      kind: "mvp-production",
      label: "MVP production",
      detail: "Firebase-backed production mode.",
    });

    render(await RoutesLayout({ children: <main>Page content</main> }));

    expect(screen.queryByText("MVP production")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Page content")).toBeInTheDocument();
  });

  it("retains actionable runtime warnings as status landmarks", async () => {
    mocks.getOptionalAuthenticatedUser.mockResolvedValue(null);
    mocks.getFlightMapRuntimeMode.mockReturnValue({
      kind: "unavailable",
      label: "Runtime unavailable",
      detail: "Configuration is incomplete.",
    });

    render(await RoutesLayout({ children: <main>Page content</main> }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Runtime unavailableConfiguration is incomplete.",
    );
  });
});

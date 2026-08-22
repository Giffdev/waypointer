// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapSharingPanel, resolveShareUrl } from "./map-sharing-panel";

describe("MapSharingPanel", () => {
  let enabled = false;

  beforeEach(() => {
    enabled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") enabled = true;
        if (init?.method === "DELETE") enabled = false;
        return json({
          sharing: {
            enabled,
            publicHandle: "test-pilot",
            sharePath: enabled ? "/test-pilot" : null,
            publishedFlightCount: enabled ? 3 : 0,
          },
        });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("enables the entire public map and returns an absolute username URL", async () => {
    const user = userEvent.setup();
    render(<MapSharingPanel />);
    await screen.findByText("Private - sharing is off");

    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.getByText(/entire map/i)).toBeVisible();
    expect(screen.getByText(/does not cap or truncate/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Share my map" }));

    expect(await screen.findByText("Public sharing is on")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Public map link" })).toHaveValue(
      "https://waypointer-app.vercel.app/test-pilot",
    );
    const write = vi.mocked(fetch).mock.calls.find(
      ([, init]) => init?.method === "POST",
    );
    expect(write?.[1]).toEqual({ method: "POST" });
  });

  it("links to the full public URL in a safe new tab and disables sharing", async () => {
    const user = userEvent.setup();
    enabled = true;
    render(<MapSharingPanel />);
    await screen.findByText("Public sharing is on");

    const absolute = resolveShareUrl("/test-pilot");
    expect(screen.getByRole("link", { name: "Open public map" })).toHaveAttribute(
      "href",
      absolute,
    );
    expect(screen.getByRole("link", { name: "Open public map" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.getByRole("link", { name: "Open public map" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );

    await user.click(screen.getByRole("button", { name: "Disable sharing" }));
    expect(await screen.findByText("Private - sharing is off")).toBeVisible();
    expect(
      vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(true);
  });

  it("loads status with no-store semantics", async () => {
    render(<MapSharingPanel />);
    await screen.findByText("Private - sharing is off");
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
    });
  });
});

function json(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    }),
  );
}

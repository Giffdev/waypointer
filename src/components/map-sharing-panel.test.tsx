// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapSharingPanel } from "./map-sharing-panel";

const sharePath =
  "/shared/00000000-0000-4000-8000-000000000010#key=" + "s".repeat(43);

describe("MapSharingPanel", () => {
  let enabled = false;
  let currentPath = sharePath;
  let currentFlightCount = 0;
  let currentIdentity = false;
  let previewFlightCount = 3;
  let previewError: { code: string; message: string } | null = null;
  let staleEnable = false;
  let statusFailure: "rejected" | "non-ok" | null = null;
  const writeText = vi.fn();

  beforeEach(() => {
    enabled = false;
    currentPath = sharePath;
    currentFlightCount = 0;
    currentIdentity = false;
    previewFlightCount = 3;
    previewError = null;
    staleEnable = false;
    statusFailure = null;
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/account/sharing" && !init?.method) {
          if (statusFailure === "rejected") {
            throw new Error("network unavailable");
          }
          if (statusFailure === "non-ok") {
            return json(
              {
                error: {
                  code: "sharing-unavailable",
                  message: "Sharing status is unavailable.",
                },
              },
              503,
            );
          }
          return json({ sharing: status() });
        }
        if (url.endsWith("/preview")) {
          if (previewError) return json({ error: previewError }, 409);
          const settings = JSON.parse(String(init?.body)) as {
            includeDisplayName: boolean;
          };
          return json({
            preview: makePreview(
              settings.includeDisplayName,
              previewFlightCount,
            ),
          });
        }
        if (url === "/api/account/sharing" && init?.method === "POST") {
          if (staleEnable) {
            return json(
              {
                error: {
                  code: "sharing-preview-stale",
                  message:
                    "The sharing preview changed. Review it again before enabling.",
                },
              },
              409,
            );
          }
          const settings = JSON.parse(String(init.body)) as {
            includeDisplayName: boolean;
          };
          enabled = true;
          currentFlightCount = previewFlightCount;
          currentIdentity = settings.includeDisplayName;
          return json({ sharing: status() });
        }
        if (url.endsWith("/regenerate")) {
          currentPath = currentPath.replace("s".repeat(43), "r".repeat(43));
          return json({ sharing: status() });
        }
        if (url === "/api/account/sharing" && init?.method === "DELETE") {
          enabled = false;
          return json({ sharing: status() });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("does not claim sharing is off while status is loading", () => {
    render(<MapSharingPanel />);

    expect(screen.getByText("Checking sharing status…")).toBeVisible();
    const statusCall = vi.mocked(fetch).mock.calls.find(
      ([url]) => String(url) === "/api/account/sharing",
    );
    expect(statusCall?.[1]).toMatchObject({ cache: "no-store" });
    expect(
      screen.queryByText("Private · sharing is off"),
    ).not.toBeInTheDocument();
  });

  it("shows an unknown state and recovery when the status request rejects", async () => {
    const user = userEvent.setup();
    statusFailure = "rejected";
    render(<MapSharingPanel />);

    expect(await screen.findByText("Sharing status unavailable")).toBeVisible();
    expect(
      screen.queryByText("Private · sharing is off"),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sharing status could not be loaded",
    );

    statusFailure = null;
    await user.click(
      screen.getByRole("button", { name: "Retry sharing status" }),
    );
    expect(await screen.findByText("Private · sharing is off")).toBeVisible();
    const statusCalls = vi.mocked(fetch).mock.calls.filter(
      ([url]) => String(url) === "/api/account/sharing",
    );
    expect(statusCalls).toHaveLength(2);
    expect(statusCalls.every(([, init]) => init?.cache === "no-store")).toBe(
      true,
    );
  });

  it("does not treat a non-OK status response as private", async () => {
    statusFailure = "non-ok";
    render(<MapSharingPanel />);

    expect(await screen.findByText("Sharing status unavailable")).toBeVisible();
    expect(
      screen.queryByText("Private · sharing is off"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Preview shared map" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Retry sharing status" }),
    ).toBeEnabled();
  });

  it("previews the authoritative map even when a flight arrives after render", async () => {
    const user = userEvent.setup();
    render(<MapSharingPanel />);

    expect(await screen.findByText("Private · sharing is off")).toBeVisible();
    expect(
      screen.getByText(/every flight currently on your private map/i),
    ).toBeVisible();

    previewFlightCount = 4;
    await user.click(
      screen.getByRole("button", { name: "Preview shared map" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Preview your shared map" }),
    ).toBeVisible();
    expect(screen.getByText("4")).toBeVisible();
    const previewCall = vi.mocked(fetch).mock.calls.find(([url]) =>
      String(url).endsWith("/preview"),
    );
    expect(JSON.parse(String(previewCall?.[1]?.body))).toEqual({
      includeDisplayName: false,
    });
    expect(String(previewCall?.[1]?.body)).not.toContain("flightIds");
  });

  it("shows only the coarse aggregate projection", async () => {
    const user = userEvent.setup();
    render(<MapSharingPanel />);
    await screen.findByText("Private · sharing is off");

    await user.click(
      screen.getByRole("button", { name: "Preview shared map" }),
    );

    const previewHeading = await screen.findByRole("heading", {
      name: "Preview your shared map",
    });
    const previewSection = previewHeading.closest("section");
    expect(previewSection).not.toBeNull();
    expect(within(previewSection!).getByText("Omitted")).toBeVisible();
    expect(
      within(previewSection!).getByText("1 approximate route groups"),
    ).toBeVisible();
    expect(previewSection).not.toHaveTextContent(
      /SEA|JFK|2026-08|registration|import|flight-id/i,
    );
    expect(
      screen.getByRole("button", { name: "Publish shared map" }),
    ).toBeDisabled();
  });

  it("warns about recognizable route patterns before consent can be given", async () => {
    const user = userEvent.setup();
    render(<MapSharingPanel />);
    await screen.findByText("Private · sharing is off");

    expect(
      screen.getByText(/Direct account identifiers are omitted/),
    ).toBeVisible();
    expect(
      screen.getByText(/Repeated endpoints and route patterns can still reveal/),
    ).toBeVisible();
    expect(screen.queryByText(/identity stays hidden/i)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Preview shared map" }),
    );

    const previewHeading = await screen.findByRole("heading", {
      name: "Preview your shared map",
    });
    const previewSection = previewHeading.closest("section");
    expect(previewSection).not.toBeNull();
    expect(
      within(previewSection!).getByText(
        "Recognizable travel patterns are included in this snapshot.",
      ),
    ).toBeVisible();
    const consent = within(previewSection!).getByRole("checkbox", {
      name: /repeated endpoints and routes may reveal my home region, routines, employer, or identity/i,
    });
    expect(consent).not.toBeChecked();
    expect(
      within(previewSection!).getByRole("button", {
        name: "Publish shared map",
      }),
    ).toBeDisabled();
  });

  it("surfaces the authoritative 500-flight limit without replacing an existing snapshot", async () => {
    const user = userEvent.setup();
    enabled = true;
    currentFlightCount = 500;
    previewError = {
      code: "sharing-flight-limit",
      message:
        "Waypointer supports complete shared maps with up to 500 flights.",
    };
    render(<MapSharingPanel />);
    await screen.findByText("View-only sharing is on");

    await user.click(
      screen.getByRole("button", { name: "Preview map update" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "up to 500 flights",
    );
    expect(
      screen.queryByRole("button", { name: "Publish shared map" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Disable sharing" })).toBeEnabled();
  });

  it("requires explicit consent and enables without submitting flight IDs", async () => {
    const user = userEvent.setup();
    render(<MapSharingPanel />);
    await screen.findByText("Private · sharing is off");

    await user.click(
      screen.getByRole("checkbox", { name: "Include my display name" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Preview shared map" }),
    );
    expect(await screen.findByText("Aviator")).toBeVisible();

    const consent = screen.getByRole("checkbox", {
      name: /I reviewed this shared-map snapshot/,
    });
    expect(consent).not.toBeChecked();
    await user.click(consent);
    await user.click(
      screen.getByRole("button", { name: "Publish shared map" }),
    );

    expect(await screen.findByText("View-only sharing is on")).toBeVisible();
    expect(screen.getByText(/Current shared map:/)).toHaveTextContent(
      "3 flights represented",
    );
    const enableCall = vi.mocked(fetch).mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/account/sharing" && init?.method === "POST",
    );
    expect(JSON.parse(String(enableCall?.[1]?.body))).toEqual({
      includeDisplayName: true,
      previewId: "a".repeat(64),
    });
    expect(String(enableCall?.[1]?.body)).not.toContain("flightIds");
  });

  it("discards consent when the server rejects a stale preview", async () => {
    const user = userEvent.setup();
    render(<MapSharingPanel />);
    await screen.findByText("Private · sharing is off");
    await user.click(
      screen.getByRole("button", { name: "Preview shared map" }),
    );
    await user.click(
      await screen.findByRole("checkbox", { name: /I reviewed/ }),
    );
    staleEnable = true;

    await user.click(
      screen.getByRole("button", { name: "Publish shared map" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Review it again before enabling",
    );
    expect(
      screen.queryByRole("heading", { name: "Preview your shared map" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Publish shared map" }),
    ).not.toBeInTheDocument();
  });

  it("copies, rotates, and revokes the view-only capability", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    enabled = true;
    currentFlightCount = 3;
    render(<MapSharingPanel />);
    await screen.findByText("View-only sharing is on");

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/shared/"));

    await user.click(screen.getByRole("button", { name: "Replace link" }));
    const rotateDialog = screen.getByRole("alertdialog");
    expect(rotateDialog).toHaveTextContent("blocked from future loads");
    expect(rotateDialog).toHaveTextContent(
      "cannot recall content already opened, copied, forwarded, or screenshotted",
    );
    expect(rotateDialog).toHaveTextContent(
      "shared map snapshot will not change",
    );
    await user.click(
      within(rotateDialog).getByRole("button", { name: "Replace link" }),
    );
    expect(await screen.findByText(/Link replaced/)).toHaveTextContent(
      "previous link cannot load the map again",
    );

    await user.click(screen.getByRole("button", { name: "Disable sharing" }));
    const revokeDialog = screen.getByRole("alertdialog");
    expect(revokeDialog).toHaveTextContent("blocked from future loads");
    expect(revokeDialog).toHaveTextContent(
      "cannot recall content already opened, copied, forwarded, or screenshotted",
    );
    await user.click(
      within(revokeDialog).getByRole("button", {
        name: "Disable sharing",
      }),
    );
    expect(await screen.findByText(/Sharing disabled/)).toHaveTextContent(
      "Content already opened, copied, forwarded, or screenshotted cannot be recalled",
    );
    expect(screen.getByText("Private · sharing is off")).toBeVisible();
  });

  it("shows the server-authoritative empty-map response", async () => {
    const user = userEvent.setup();
    previewError = {
      code: "sharing-map-empty",
      message: "Your map does not have any flights to share yet.",
    };
    render(<MapSharingPanel />);
    await screen.findByText("Private · sharing is off");

    await user.click(
      screen.getByRole("button", { name: "Preview shared map" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "does not have any flights to share yet",
    );
    expect(
      screen.queryByRole("button", { name: "Publish shared map" }),
    ).not.toBeInTheDocument();
  });

  function status() {
    return {
      enabled,
      sharePath: enabled ? currentPath : null,
      includeDisplayName: currentIdentity,
      publishedFlightCount: currentFlightCount,
    };
  }
});

function makePreview(includeDisplayName: boolean, flightCount: number) {
  return {
    previewId: "a".repeat(64),
    includeDisplayName,
    projection: {
      owner: { displayName: includeDisplayName ? "Aviator" : null },
      summary: { flightCount, routeCount: 1 },
      routes: [
        {
          id: "coarse-route",
          kind: "private",
          flightCount,
          origin: { lat: 47.4, lon: -122.3, country: "US" },
          destination: { lat: 40.6, lon: -73.8, country: "US" },
        },
      ],
    },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

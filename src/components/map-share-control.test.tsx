// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapShareControl } from "./map-share-control";

describe("MapShareControl", () => {
  let enabled = false;
  let fetchCalls: Array<{ url: string; method?: string }>;

  beforeEach(() => {
    enabled = false;
    fetchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), method: init?.method });
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

  it("does not fetch sharing status until opened", () => {
    render(<MapShareControl />);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("opens with an accessible trigger, moves initial focus, and lazily fetches status", async () => {
    const user = userEvent.setup();
    render(<MapShareControl />);
    const trigger = screen.getByRole("button", { name: "Share map" });
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const dialog = screen.getByRole("dialog", { name: "Share your map" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveFocus();
    expect(fetchCalls).toEqual([
      { url: "/api/account/sharing", method: undefined },
    ]);
    await screen.findByText("Not shared");
  });

  it("dismisses on outside pointerdown and restores focus on Escape", async () => {
    const user = userEvent.setup();
    render(<MapShareControl />);
    const trigger = screen.getByRole("button", { name: "Share map" });

    await user.click(trigger);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(trigger);
    await screen.findByText("Not shared");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("moves from not-shared to shared and shows the copy/open/manage actions", async () => {
    const user = userEvent.setup();
    render(<MapShareControl />);
    await user.click(screen.getByRole("button", { name: "Share map" }));
    await screen.findByText("Not shared");
    expect(screen.getByText(/entire map/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Share my map" }));

    expect(await screen.findByText("Public sharing is on")).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Public map link" }),
    ).toHaveValue("https://waypointer-app.vercel.app/test-pilot");

    const openLink = screen.getByRole("link", { name: "Open public map" });
    expect(openLink).toHaveAttribute(
      "href",
      "https://waypointer-app.vercel.app/test-pilot",
    );
    expect(openLink).toHaveAttribute("target", "_blank");
    expect(openLink).toHaveAttribute("rel", "noopener noreferrer");

    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWrite },
      configurable: true,
    });
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(clipboardWrite).toHaveBeenCalledWith(
      "https://waypointer-app.vercel.app/test-pilot",
    );
    expect(await screen.findByText("Public map link copied.")).toBeVisible();

    const manageLink = screen.getByRole("link", {
      name: "Manage sharing settings",
    });
    expect(manageLink).toHaveAttribute("href", "/settings#sharing-title");

    expect(
      screen.queryByRole("button", { name: "Disable sharing" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Republish map" }),
    ).not.toBeInTheDocument();
  });

  it("gives Copy link its own visible chrome so it isn't squeezed by the icon-row's 44x44 button styling", async () => {
    // Regression test: `.icon-controls button` previously matched this
    // button too (a plain descendant selector), forcing it into a fixed
    // 44x44 icon-tile box and wrapping "Copy link" onto two lines. The fix
    // scopes that rule to direct children and gives this button its own
    // `.secondary-button` class (matching "Open public map") so its sizing
    // no longer depends on which ancestor row it happens to render inside.
    const user = userEvent.setup();
    render(<MapShareControl />);
    await user.click(screen.getByRole("button", { name: "Share map" }));
    await screen.findByText("Not shared");
    await user.click(screen.getByRole("button", { name: "Share my map" }));
    await screen.findByText("Public sharing is on");

    const copyButton = screen.getByRole("button", { name: "Copy link" });
    expect(copyButton).toHaveClass("secondary-button");
    const openLink = screen.getByRole("link", { name: "Open public map" });
    expect(openLink).toHaveClass("secondary-button");
  });

  it("gives the Retry sharing status button its own visible chrome, matching Copy link/Open public map", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const user = userEvent.setup();
    render(<MapShareControl />);
    await user.click(screen.getByRole("button", { name: "Share map" }));
    await screen.findByText("Sharing status unavailable");

    const retry = screen.getByRole("button", { name: "Retry sharing status" });
    expect(retry).toHaveClass("secondary-button");
  });

  it("keeps the public map link input inside a `<label>` so it can shrink/ellipsize without breaking its accessible name", async () => {
    // Regression guard for the popup-overflow fix: the input must remain
    // a proper shrinkable flex/grid child (min-width:0 handled in CSS)
    // while still being reachable by its accessible name and holding the
    // full, untruncated URL value (copy/select still operate on the real
    // value even though the CSS visually ellipsizes long text).
    const user = userEvent.setup();
    render(<MapShareControl />);
    await user.click(screen.getByRole("button", { name: "Share map" }));
    await screen.findByText("Not shared");
    await user.click(screen.getByRole("button", { name: "Share my map" }));

    const input = await screen.findByRole("textbox", {
      name: "Public map link",
    });
    expect(input).toHaveValue("https://waypointer-app.vercel.app/test-pilot");
    expect(input).toHaveAttribute("readonly");
  });

  it("shows an error state with retry when sharing status fails to load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const user = userEvent.setup();
    render(<MapShareControl />);
    await user.click(screen.getByRole("button", { name: "Share map" }));

    expect(
      await screen.findByText("Sharing status unavailable"),
    ).toBeVisible();
    const retry = screen.getByRole("button", { name: "Retry sharing status" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          sharing: {
            enabled: false,
            publicHandle: "test-pilot",
            sharePath: null,
            publishedFlightCount: 0,
          },
        }),
      ),
    );
    await user.click(retry);
    expect(await screen.findByText("Not shared")).toBeVisible();
  });

  it("clears the stale error immediately on retry, before the retry request resolves", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const user = userEvent.setup();
    render(<MapShareControl />);
    await user.click(screen.getByRole("button", { name: "Share map" }));
    expect(
      await screen.findByText("Sharing status unavailable"),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sharing status could not be loaded.",
    );

    const deferred = createDeferred();
    vi.stubGlobal("fetch", vi.fn(() => deferred.promise));
    await user.click(
      screen.getByRole("button", { name: "Retry sharing status" }),
    );

    // Parity with the pre-refactor Settings behavior: retryStatus clears
    // `error` synchronously, so the stale alert must already be gone even
    // though the retry request itself has not resolved yet.
    expect(screen.getByText("Checking sharing status...")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Sharing status could not be loaded."),
    ).not.toBeInTheDocument();

    deferred.resolve(
      new Response(
        JSON.stringify({
          sharing: {
            enabled: false,
            publicHandle: "test-pilot",
            sharePath: null,
            publishedFlightCount: 0,
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    expect(await screen.findByText("Not shared")).toBeVisible();
  });

  it("aborts the in-flight status fetch when the component unmounts", async () => {
    const deferred = createDeferred();
    let capturedSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined;
        return deferred.promise;
      }),
    );
    const user = userEvent.setup();
    const { unmount } = render(<MapShareControl />);
    await user.click(screen.getByRole("button", { name: "Share map" }));

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);

    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });
});

function createDeferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function json(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    }),
  );
}

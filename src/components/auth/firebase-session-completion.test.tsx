// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authStateReady: vi.fn(),
  currentUser: null as null | { getIdToken: ReturnType<typeof vi.fn> },
  getIdToken: vi.fn(),
  getRedirectResult: vi.fn(),
}));

vi.mock("@/lib/auth/firebase-client", () => ({
  getFirebaseAuth: () => ({
    authStateReady: mocks.authStateReady,
    get currentUser() {
      return mocks.currentUser;
    },
  }),
}));
vi.mock("firebase/auth", () => ({
  getRedirectResult: mocks.getRedirectResult,
}));

import { FirebaseSessionCompletion } from "./firebase-session-completion";

describe("global Firebase session completion", () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.authStateReady.mockReset().mockResolvedValue(undefined);
    mocks.currentUser = null;
    mocks.getIdToken.mockReset().mockResolvedValue("firebase-id-token");
    mocks.getRedirectResult.mockReset();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("finishes a return landing outside the callback using persisted Firebase auth state", async () => {
    sessionStorage.setItem("flight-map.firebase.redirect-state", "initiated");
    sessionStorage.setItem("flight-map.firebase.return-to", "/map");
    mocks.getRedirectResult.mockResolvedValue(null);
    mocks.currentUser = { getIdToken: mocks.getIdToken };
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const navigate = vi.fn();

    render(<FirebaseSessionCompletion navigate={navigate} />);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/map"));
    expect(fetch).toHaveBeenCalledWith("/api/auth/firebase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "firebase-id-token" }),
    });
    expect(mocks.getIdToken).toHaveBeenCalledOnce();
    expect(mocks.getIdToken).toHaveBeenCalledWith();
    expect(sessionStorage.getItem("flight-map.firebase.redirect-state")).toBeNull();
  });

  it("does not retry a rejected exchange or force a redundant token refresh", async () => {
    sessionStorage.setItem("flight-map.firebase.redirect-state", "initiated");
    mocks.getRedirectResult.mockResolvedValue({
      user: { getIdToken: mocks.getIdToken },
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), { status: 503 }),
    );
    const navigate = vi.fn();

    render(<FirebaseSessionCompletion navigate={navigate} />);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "/auth/sign-in?error=firebase-sign-in-incomplete",
      ),
    );
    expect(mocks.getIdToken).toHaveBeenCalledOnce();
    expect(mocks.getIdToken).toHaveBeenCalledWith();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("surfaces a safe error instead of silently ignoring a null result and user", async () => {
    sessionStorage.setItem("flight-map.firebase.redirect-state", "initiated");
    mocks.getRedirectResult.mockResolvedValue(null);
    const navigate = vi.fn();

    render(<FirebaseSessionCompletion navigate={navigate} />);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "/auth/sign-in?error=firebase-sign-in-incomplete",
      ),
    );
    expect(console.error).toHaveBeenCalledWith(
      "Firebase authentication failed.",
      { stage: "redirect-completion", code: "unknown" },
    );
  });
});

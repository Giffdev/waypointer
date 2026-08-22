// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFirebaseAuth: vi.fn(() => ({ name: "firebase-auth" })),
  provider: {
    setCustomParameters: vi.fn(),
  },
  signInWithRedirect: vi.fn(),
}));

vi.mock("@/lib/auth/firebase-client", () => ({
  getFirebaseAuth: mocks.getFirebaseAuth,
}));
vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: vi.fn(function GoogleAuthProvider() {
    return mocks.provider;
  }),
  signInWithRedirect: mocks.signInWithRedirect,
}));

import { FirebaseRedirectHandler } from "./firebase-redirect-handler";

describe("Firebase redirect callback", () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.provider.setCustomParameters.mockReset();
    mocks.signInWithRedirect.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("starts Google auth from the stable callback route", async () => {
    sessionStorage.setItem("flight-map.firebase.redirect-state", "start");

    render(<FirebaseRedirectHandler />);

    await waitFor(() =>
      expect(mocks.signInWithRedirect).toHaveBeenCalledOnce(),
    );
    expect(sessionStorage.getItem("flight-map.firebase.redirect-state")).toBe(
      "initiated",
    );
    expect(mocks.provider.setCustomParameters).toHaveBeenCalledWith({
      prompt: "select_account",
    });
    expect(mocks.signInWithRedirect).toHaveBeenCalledWith(
      { name: "firebase-auth" },
      mocks.provider,
    );
  });

  it("waits on the callback route while global completion processes the return", async () => {
    sessionStorage.setItem("flight-map.firebase.redirect-state", "initiated");
    render(<FirebaseRedirectHandler />);
    expect(
      screen.getByText("Completing secure sign-in…"),
    ).toBeInTheDocument();
    expect(mocks.signInWithRedirect).not.toHaveBeenCalled();
  });
});

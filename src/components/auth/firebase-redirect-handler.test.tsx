// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFirebaseAuth: vi.fn(() => ({ name: "firebase-auth" })),
  signInWithRedirect: vi.fn(),
}));

vi.mock("@/lib/auth/firebase-client", () => ({
  getFirebaseAuth: mocks.getFirebaseAuth,
}));
vi.mock("firebase/auth", () => ({
  GoogleAuthProvider: vi.fn(),
  signInWithRedirect: mocks.signInWithRedirect,
}));

import { FirebaseRedirectHandler } from "./firebase-redirect-handler";

describe("Firebase redirect callback", () => {
  beforeEach(() => {
    sessionStorage.clear();
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

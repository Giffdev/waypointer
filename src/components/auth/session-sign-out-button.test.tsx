// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  firebaseAuth: { name: "firebase-auth" },
  firebaseSignOut: vi.fn(),
  serverSignOut: vi.fn(),
}));

vi.mock("firebase/auth", () => ({
  signOut: mocks.firebaseSignOut,
}));
vi.mock("@/lib/auth/firebase-client", () => ({
  getFirebaseAuth: () => mocks.firebaseAuth,
}));
vi.mock("@/app/auth/sign-out/actions", () => ({
  signOutToHomepage: mocks.serverSignOut,
}));

import { SessionSignOutButton } from "./session-sign-out-button";

describe("session sign-out button", () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.firebaseSignOut.mockReset().mockResolvedValue(undefined);
    mocks.serverSignOut.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("clears Firebase redirect and browser identity before server sign-out", async () => {
    sessionStorage.setItem("flight-map.firebase.redirect-state", "initiated");
    sessionStorage.setItem("flight-map.firebase.return-to", "/map");
    const user = userEvent.setup();

    render(<SessionSignOutButton />);
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(mocks.serverSignOut).toHaveBeenCalledOnce());
    expect(sessionStorage.getItem("flight-map.firebase.redirect-state")).toBeNull();
    expect(sessionStorage.getItem("flight-map.firebase.return-to")).toBeNull();
    expect(mocks.firebaseSignOut).toHaveBeenCalledWith(mocks.firebaseAuth);
    expect(mocks.firebaseSignOut.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.serverSignOut.mock.invocationCallOrder[0],
    );
  });

  it("still clears the authoritative server session when Firebase cleanup fails", async () => {
    const failure = Object.assign(new Error("client cleanup failed"), {
      code: "auth/network-request-failed",
    });
    mocks.firebaseSignOut.mockRejectedValue(failure);
    const user = userEvent.setup();

    render(<SessionSignOutButton />);
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(mocks.serverSignOut).toHaveBeenCalledOnce());
    expect(console.error).toHaveBeenCalledWith(
      "Firebase authentication failed.",
      { stage: "sign-out", code: "auth/network-request-failed" },
    );
  });
});

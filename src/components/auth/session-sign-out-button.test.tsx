// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Component, type ReactNode } from "react";

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

class SignOutErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <p role="alert">{this.state.error.message}</p>
    ) : (
      this.props.children
    );
  }
}

describe("session sign-out button", () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.firebaseSignOut.mockReset().mockResolvedValue(undefined);
    mocks.serverSignOut.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
  });

  it("clears Firebase redirect and browser identity before server sign-out", async () => {
    sessionStorage.setItem("flight-map.firebase.redirect-state", "initiated");
    sessionStorage.setItem("flight-map.firebase.return-to", "/map");
    let finishFirebaseSignOut: (() => void) | undefined;
    mocks.firebaseSignOut.mockReturnValue(
      new Promise<void>((resolve) => {
        finishFirebaseSignOut = resolve;
      }),
    );
    const user = userEvent.setup();

    render(<SessionSignOutButton />);
    const click = user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => expect(mocks.firebaseSignOut).toHaveBeenCalledOnce());
    expect(sessionStorage.getItem("flight-map.firebase.redirect-state")).toBeNull();
    expect(sessionStorage.getItem("flight-map.firebase.return-to")).toBeNull();
    expect(mocks.firebaseSignOut).toHaveBeenCalledWith(mocks.firebaseAuth);
    expect(mocks.serverSignOut).not.toHaveBeenCalled();

    finishFirebaseSignOut?.();
    await click;
    await waitFor(() => expect(mocks.serverSignOut).toHaveBeenCalledOnce());
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

  it("does not let stalled Firebase cleanup block the server sign-out", async () => {
    vi.useFakeTimers();
    mocks.firebaseSignOut.mockReturnValue(new Promise(() => undefined));

    render(<SessionSignOutButton />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(mocks.serverSignOut).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(2_000));

    expect(mocks.serverSignOut).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalledWith(
      "Firebase authentication failed.",
      { stage: "sign-out", code: "auth/client-cleanup-timeout" },
    );
  });

  it("surfaces server sign-out errors instead of masking them", async () => {
    mocks.serverSignOut.mockRejectedValue(new Error("server sign-out failed"));
    const user = userEvent.setup();

    render(
      <SignOutErrorBoundary>
        <SessionSignOutButton />
      </SignOutErrorBoundary>,
    );
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await expect(
      screen.findByRole("alert"),
    ).resolves.toHaveTextContent("server sign-out failed");
  });
});

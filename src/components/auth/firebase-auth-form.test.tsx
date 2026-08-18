// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFirebaseAuth: vi.fn(() => ({ name: "firebase-auth" })),
}));

vi.mock("@/lib/auth/firebase-client", () => ({
  getFirebaseAuth: mocks.getFirebaseAuth,
}));

vi.mock("firebase/auth", () => ({
  createUserWithEmailAndPassword: vi.fn(),
  sendEmailVerification: vi.fn(),
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  updateProfile: vi.fn(),
}));

import { beginFirebaseGoogleSignIn } from "./firebase-auth-form";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Firebase Google authentication", () => {
  it("preserves the destination and moves initiation to the dedicated callback", () => {
    const navigate = vi.fn();

    beginFirebaseGoogleSignIn(navigate);

    expect(sessionStorage.getItem("flight-map.firebase.redirect-state")).toBe(
      "start",
    );
    expect(sessionStorage.getItem("flight-map.firebase.return-to")).toBe("/map");
    expect(navigate).toHaveBeenCalledWith("/auth/firebase/callback");
  });
});

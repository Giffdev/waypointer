"use client";

import { useEffect, useRef, useState } from "react";
import {
  GoogleAuthProvider,
  signInWithRedirect,
} from "firebase/auth";
import { getFirebaseAuth } from "@/lib/auth/firebase-client";

const REDIRECT_STATE_KEY = "flight-map.firebase.redirect-state";

function reportFailure(stage: string, error: unknown) {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("auth/")
      ? error.code
      : "unknown";
  console.error("Firebase authentication failed.", { stage, code });
}

export function FirebaseRedirectHandler() {
  const started = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const auth = getFirebaseAuth();
        const state = sessionStorage.getItem(REDIRECT_STATE_KEY);
        if (state === "start") {
          sessionStorage.setItem(REDIRECT_STATE_KEY, "initiated");
          const provider = new GoogleAuthProvider();
          provider.setCustomParameters({ prompt: "select_account" });
          await signInWithRedirect(auth, provider);
          return;
        }
        if (state !== "initiated") {
          throw new Error("redirect state unavailable");
        }
      } catch (error) {
        reportFailure("redirect-start", error);
        setFailed(true);
      }
    })();
  }, []);

  if (failed) {
    return (
      <p className="auth-message auth-message-error" role="alert">
        Sign-in could not be completed. Return to sign in and try again.
      </p>
    );
  }
  return (
    <p className="auth-message auth-message-info" role="status">
      Completing secure sign-in…
    </p>
  );
}

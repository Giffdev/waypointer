"use client";

import { useEffect, useRef } from "react";
import { getRedirectResult } from "firebase/auth";
import { getFirebaseAuth } from "@/lib/auth/firebase-client";

const REDIRECT_STATE_KEY = "flight-map.firebase.redirect-state";
const RETURN_TO_KEY = "flight-map.firebase.return-to";

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

export function FirebaseSessionCompletion({
  navigate = (url) => window.location.replace(url),
}: {
  navigate?: (url: string) => void;
}) {
  const checked = useRef(false);

  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    if (
      sessionStorage.getItem(REDIRECT_STATE_KEY) !== "initiated"
    ) {
      return;
    }
    void (async () => {
      try {
        const auth = getFirebaseAuth();
        const result = await getRedirectResult(auth);
        await auth.authStateReady();
        const user = result?.user ?? auth.currentUser;
        if (!user) throw new Error("redirect user unavailable");
        const token = await user.getIdToken();
        const response = await fetch("/api/auth/firebase", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
          }),
        });
        if (!response.ok) throw new Error("exchange rejected");
        const returnTo =
          sessionStorage.getItem(RETURN_TO_KEY) === "/map" ? "/map" : "/map";
        sessionStorage.removeItem(REDIRECT_STATE_KEY);
        sessionStorage.removeItem(RETURN_TO_KEY);
        navigate(returnTo);
      } catch (error) {
        reportFailure("redirect-completion", error);
        sessionStorage.removeItem(REDIRECT_STATE_KEY);
        sessionStorage.removeItem(RETURN_TO_KEY);
        navigate("/auth/sign-in?error=firebase-sign-in-incomplete");
      }
    })();
  }, [navigate]);

  return null;
}

"use client";

import { useState, type ReactNode } from "react";
import { signOut as signOutFirebase } from "firebase/auth";
import { signOutToHomepage } from "@/app/auth/sign-out/actions";
import { getFirebaseAuth } from "@/lib/auth/firebase-client";

const FIREBASE_REDIRECT_STATE_KEY = "flight-map.firebase.redirect-state";
const FIREBASE_RETURN_TO_KEY = "flight-map.firebase.return-to";

function reportFirebaseSignOutFailure(error: unknown) {
  const code =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("auth/")
      ? error.code
      : "unknown";
  console.error("Firebase authentication failed.", {
    stage: "sign-out",
    code,
  });
}

async function clearFirebaseBrowserSession() {
  try {
    sessionStorage.removeItem(FIREBASE_REDIRECT_STATE_KEY);
    sessionStorage.removeItem(FIREBASE_RETURN_TO_KEY);
  } catch (error) {
    reportFirebaseSignOutFailure(error);
  }
  try {
    await signOutFirebase(getFirebaseAuth());
  } catch (error) {
    reportFirebaseSignOutFailure(error);
  }
}

export function SessionSignOutButton({
  children = "Sign out",
  className,
  role,
}: {
  children?: ReactNode;
  className?: string;
  role?: "menuitem";
}) {
  const [pending, setPending] = useState(false);

  return (
    <form
      action={async () => {
        setPending(true);
        await clearFirebaseBrowserSession();
        try {
          await signOutToHomepage();
        } finally {
          setPending(false);
        }
      }}
    >
      <button
        aria-busy={pending}
        className={className}
        disabled={pending}
        role={role}
        type="submit"
      >
        {children}
      </button>
    </form>
  );
}

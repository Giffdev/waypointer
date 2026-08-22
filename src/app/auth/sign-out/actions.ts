"use server";

import { signOut } from "@/lib/auth";
import { canonicalPublicUrl } from "@/lib/public-origin";

const SIGN_OUT_REDIRECT_URL = canonicalPublicUrl("/");

export async function signOutToHomepage() {
  await signOut({ redirectTo: SIGN_OUT_REDIRECT_URL });
}

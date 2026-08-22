import { describe, expect, it } from "vitest";
import {
  CANONICAL_PUBLIC_ORIGIN,
  canonicalPublicUrl,
} from "./public-origin";

describe("canonical public origin", () => {
  it("builds public URLs on the Waypointer production host", () => {
    expect(CANONICAL_PUBLIC_ORIGIN).toBe(
      "https://waypointer-app.vercel.app",
    );
    expect(canonicalPublicUrl("/test-pilot")).toBe(
      "https://waypointer-app.vercel.app/test-pilot",
    );
  });
});

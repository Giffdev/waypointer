import { describe, expect, it } from "vitest";
import { isAccountDeletionEnabled } from "./capabilities";

describe("authentication capabilities", () => {
  it("enables account deletion only with complete verified email delivery", () => {
    expect(isAccountDeletionEnabled({})).toBe(false);
    expect(isAccountDeletionEnabled({ AUTH_EMAIL_FROM: "sender" })).toBe(false);
    expect(
      isAccountDeletionEnabled({
        AUTH_EMAIL_FROM: "sender",
        RESEND_API_KEY: "configured",
      }),
    ).toBe(true);
  });
});


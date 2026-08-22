import { beforeEach, describe, expect, it, vi } from "vitest";

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock("@/lib/auth", () => ({ signOut }));

import { signOutToHomepage } from "./actions";

describe("profile sign-out", () => {
  beforeEach(() => {
    signOut.mockReset();
  });

  it("requests sign-out with the canonical homepage redirect target", async () => {
    signOut.mockResolvedValue(undefined);

    await signOutToHomepage();

    expect(signOut).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledWith({
      redirectTo: "https://waypointer-app.vercel.app/",
    });
  });

  it("does not hide a sign-out failure behind a homepage redirect", async () => {
    const failure = new Error("session deletion failed");
    signOut.mockRejectedValue(failure);

    await expect(signOutToHomepage()).rejects.toBe(failure);
  });
});

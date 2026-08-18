import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelAccountDeletion: vi.fn(),
}));

vi.mock("@/lib/auth/account-deletion", () => ({
  cancelAccountDeletion: mocks.cancelAccountDeletion,
}));

import { POST } from "./route";

function cancellationRequest(token: string) {
  const form = new FormData();
  form.set("token", token);
  return new Request("http://localhost:3000/api/account/delete/cancel", {
    method: "POST",
    headers: { origin: "http://localhost:3000" },
    body: form,
  });
}

describe("deletion cancellation endpoint", () => {
  beforeEach(() => {
    mocks.cancelAccountDeletion.mockReset().mockResolvedValue(undefined);
  });

  it("returns one non-enumerating result for valid and invalid tokens", async () => {
    const valid = await POST(cancellationRequest("valid-looking-token"));
    mocks.cancelAccountDeletion.mockRejectedValueOnce(new Error("expired"));
    const expired = await POST(cancellationRequest("expired-looking-token"));

    expect(valid.status).toBe(303);
    expect(expired.status).toBe(303);
    expect(valid.headers.get("location")).toBe(
      "http://localhost:3000/auth/delete-cancel?result=processed",
    );
    expect(expired.headers.get("location")).toBe(
      valid.headers.get("location"),
    );
  });
});

import { describe, expect, it } from "vitest";
import { metadata } from "./page";

describe("shared map preview page metadata", () => {
  it("prevents indexing and referrer leakage", () => {
    expect(metadata.robots).toMatchObject({
      index: false,
      follow: false,
      nocache: true,
    });
    expect(metadata.referrer).toBe("no-referrer");
  });
});

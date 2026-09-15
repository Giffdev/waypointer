import { describe, expect, it } from "vitest";

import { compareCanonicalPaths } from "./canonical-path-order";

describe("canonical path ordering", () => {
  it("rejects a single malformed path", () => {
    expect(() => compareCanonicalPaths("\ud800", "valid")).toThrow(TypeError);
  });

  it("rejects distinct malformed paths instead of collapsing them", () => {
    expect(() => compareCanonicalPaths("\ud800", "\ud801")).toThrow(
      TypeError,
    );
  });
});

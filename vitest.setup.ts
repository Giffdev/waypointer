import { expect } from "vitest";

expect.extend({
  toEndWith(received: unknown, expected: unknown) {
    const pass =
      typeof received === "string" &&
      typeof expected === "string" &&
      received.endsWith(expected);
    return {
      pass,
      message: () =>
        `expected ${JSON.stringify(received)} ${pass ? "not " : ""}to end with ${JSON.stringify(expected)}`,
    };
  },
});

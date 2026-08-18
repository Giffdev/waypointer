import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./worker.ts", import.meta.url)),
  "utf8",
);

describe("durable worker operational contract", () => {
  it("keeps liveness minimal and protects detailed health with a constant-time secret", () => {
    expect(source).toMatch(/request\.url === "\/live"[\s\S]+JSON\.stringify\(\{ ok:/);
    expect(source).toMatch(
      /request\.url !== "\/health" \|\| !authorized\(request\.headers\.authorization\)/,
    );
    expect(source).toMatch(/timingSafeEqual\(actual, expected\)/);
    expect(source).toMatch(/cache-control": "no-store"/);
    expect(source).not.toMatch(/response\.end\([^)]*(payload|objectKey|email|token)/i);
  });

  it("fails health when scanner freshness or queue inspection fails", () => {
    expect(source).toMatch(/await scanner\.assertHealthy\(\)/);
    expect(source).toMatch(/const metrics = await jobs\.metrics\(\)/);
    expect(source).toMatch(
      /catch \{[\s\S]+response\.writeHead\(503[\s\S]+JSON\.stringify\(\{ ok: false \}\)/,
    );
  });

  it("bounds polling and logs only a safe worker-loop error class", () => {
    expect(source).toMatch(/pollIntervalMs < 250/);
    expect(source).toMatch(/pollIntervalMs > 30_000/);
    expect(source).toMatch(
      /durable-import-worker-loop-failed[\s\S]+error instanceof Error \? error\.name : "unknown"/,
    );
    expect(source).not.toMatch(/durable-import-worker-loop-failed[\s\S]{0,200}error\.message/);
  });
});

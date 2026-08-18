import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFlightImport } from "./registry";
import { DEFAULT_MAX_IMPORT_BYTES } from "./worker";

const EICAR_SIGNATURE =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

function fixture(name: string) {
  return readFileSync(
    fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)),
    "utf8",
  );
}

describe("durable import fixtures", () => {
  it("uses a bounded, synthetic clean ForeFlight fixture", () => {
    const clean = fixture("foreflight-v1.csv");

    expect(Buffer.byteLength(clean)).toBeLessThan(DEFAULT_MAX_IMPORT_BYTES);
    expect(parseFlightImport(clean).status).toBe("parsed");
    expect(clean).toContain("SYNTH-A");
    expect(clean).toContain("Example Aviation");
    expect(clean).not.toMatch(
      /devin|giffdev|[\w.+-]+@[\w.-]+\.[a-z]{2,}|flightdiary_2026|logbook_2026/i,
    );
    expect(clean).not.toContain(EICAR_SIGNATURE);
  });

  it("keeps the harmless EICAR scanner fixture parseable and privacy-safe", () => {
    const infected = fixture("durable-eicar-foreflight.csv");

    expect(Buffer.byteLength(infected)).toBeLessThan(DEFAULT_MAX_IMPORT_BYTES);
    expect(infected.split(EICAR_SIGNATURE)).toHaveLength(2);
    expect(parseFlightImport(infected).status).toBe("parsed");
    expect(infected).toContain("SYNTH-EICAR");
    expect(infected).not.toMatch(
      /devin|giffdev|[\w.+-]+@[\w.-]+\.[a-z]{2,}|flightdiary_2026|logbook_2026/i,
    );
  });
});

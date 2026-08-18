import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableJobError } from "@/lib/jobs/errors";
import { ClamAvScanner } from "./clamav";

const fixturePath = fileURLToPath(
  new URL("../import/__fixtures__/durable-eicar-foreflight.csv", import.meta.url),
);
const fixtureBytes = readFileSync(fixturePath);
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function scannerServer(scanResponse: string) {
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const request = Buffer.concat(chunks);
      socket.end(
        request.subarray(0, 6).toString("utf8") === "zPING\0"
          ? "PONG"
          : scanResponse,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("ClamAV test server did not bind.");
  }
  return address.port;
}

function scanner(
  port: number,
  maxSignatureAgeHours = Number.POSITIVE_INFINITY,
) {
  return new ClamAvScanner({
    host: "127.0.0.1",
    port,
    timeoutMs: 250,
    signatureFile: fixturePath,
    maxSignatureAgeHours,
  });
}

describe("ClamAV durable import scanner", () => {
  it("accepts a healthy clean verdict without returning file content", async () => {
    const port = await scannerServer("stream: OK");

    await expect(
      scanner(port).scan(Buffer.from("synthetic clean csv")),
    ).resolves.toEqual({
      verdict: "clean",
      provider: "clamav",
    });
  });

  it("returns only an infected verdict for the harmless EICAR fixture", async () => {
    const port = await scannerServer("stream: Eicar-Test-Signature FOUND");

    const result = await scanner(port).scan(fixtureBytes);

    expect(result).toEqual({ verdict: "infected", provider: "clamav" });
    expect(JSON.stringify(result)).not.toContain("X5O!");
  });

  it("classifies an unavailable daemon as retryable without leaking the upload", async () => {
    const error = await scanner(1)
      .scan(fixtureBytes)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(DurableJobError);
    expect(error).toMatchObject({
      code: "scanner-unavailable",
      retryable: true,
      message: "Malware scanner is unavailable.",
    });
    expect(String(error)).not.toContain("X5O!");
  });

  it("rejects stale signatures before opening a scan connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2035-01-01T00:00:00.000Z"));

    const error = await scanner(1, 48)
      .scan(fixtureBytes)
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(DurableJobError);
    expect(error).toMatchObject({
      code: "scanner-signatures-stale",
      retryable: true,
      message: "Malware signatures are stale.",
    });
  });
});

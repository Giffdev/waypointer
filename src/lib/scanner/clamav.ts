import { stat } from "node:fs/promises";
import { connect } from "node:net";
import { DurableJobError } from "@/lib/jobs/errors";
import type { MalwareScanner, MalwareScanResult } from "./types";

type ClamAvOptions = {
  host: string;
  port: number;
  timeoutMs: number;
  signatureFile: string;
  maxSignatureAgeHours: number;
};

export class ClamAvScanner implements MalwareScanner {
  constructor(private readonly options: ClamAvOptions = clamAvOptions()) {}

  async assertHealthy(): Promise<void> {
    const details =
      (await stat(this.options.signatureFile).catch(() => null)) ??
      (this.options.signatureFile.endsWith("daily.cvd")
        ? await stat(
            this.options.signatureFile.replace(/daily\.cvd$/, "daily.cld"),
          ).catch(() => null)
        : null);
    if (!details) {
      throw new DurableJobError(
        "scanner-unavailable",
        true,
        "Malware signature data is unavailable.",
      );
    }
    const ageHours = (Date.now() - details.mtimeMs) / 3_600_000;
    if (ageHours > this.options.maxSignatureAgeHours) {
      throw new DurableJobError(
        "scanner-signatures-stale",
        true,
        "Malware signatures are stale.",
      );
    }
    const response = await clamCommand(
      this.options,
      Buffer.from("zPING\0"),
    );
    if (!response.includes("PONG")) {
      throw new DurableJobError(
        "scanner-unavailable",
        true,
        "Malware scanner health check failed.",
      );
    }
  }

  async scan(bytes: Uint8Array): Promise<MalwareScanResult> {
    await this.assertHealthy();
    const chunks: Buffer[] = [Buffer.from("zINSTREAM\0")];
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      const data = Buffer.from(bytes.slice(offset, offset + 64 * 1024));
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      chunks.push(length, data);
    }
    chunks.push(Buffer.alloc(4));
    const response = await clamCommand(this.options, Buffer.concat(chunks));
    if (response.includes(" FOUND")) {
      return { verdict: "infected", provider: "clamav" };
    }
    if (!response.includes(" OK")) {
      throw new DurableJobError(
        "scanner-unavailable",
        true,
        "Malware scanner returned an unsafe response.",
      );
    }
    return { verdict: "clean", provider: "clamav" };
  }
}

function clamAvOptions(environment: NodeJS.ProcessEnv = process.env): ClamAvOptions {
  const port = Number(environment.CLAMAV_PORT ?? 3310);
  const maxSignatureAgeHours = Number(
    environment.CLAMAV_MAX_SIGNATURE_AGE_HOURS ?? 48,
  );
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("CLAMAV_PORT is invalid.");
  }
  if (
    !Number.isFinite(maxSignatureAgeHours) ||
    maxSignatureAgeHours < 1 ||
    maxSignatureAgeHours > 168
  ) {
    throw new Error("CLAMAV_MAX_SIGNATURE_AGE_HOURS must be from 1 to 168.");
  }
  return {
    host: environment.CLAMAV_HOST?.trim() || "127.0.0.1",
    port,
    timeoutMs: 30_000,
    signatureFile:
      environment.CLAMAV_SIGNATURE_FILE?.trim() ||
      "/var/lib/clamav/daily.cvd",
    maxSignatureAgeHours,
  };
}

function clamCommand(options: ClamAvOptions, request: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: options.host, port: options.port });
    const response: Buffer[] = [];
    const fail = (code: "scanner-timeout" | "scanner-unavailable") =>
      reject(
        new DurableJobError(
          code,
          true,
          code === "scanner-timeout"
            ? "Malware scanning timed out."
            : "Malware scanner is unavailable.",
        ),
      );
    socket.setTimeout(options.timeoutMs);
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => response.push(chunk));
    socket.on("timeout", () => {
      socket.destroy();
      fail("scanner-timeout");
    });
    socket.on("error", () => fail("scanner-unavailable"));
    socket.on("close", (hadError) => {
      if (!hadError) resolve(Buffer.concat(response).toString("utf8"));
    });
  });
}

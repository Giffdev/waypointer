import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const baseUrl = required("DURABLE_IMPORT_SMOKE_BASE_URL");
const email = required("DURABLE_IMPORT_SMOKE_EMAIL");
const password = required("DURABLE_IMPORT_SMOKE_PASSWORD");
const base = new URL(baseUrl);
if (base.protocol !== "https:") {
  throw new Error("DURABLE_IMPORT_SMOKE_BASE_URL must use HTTPS.");
}
const clean = await readFile(
  fileURLToPath(
    new URL("../src/lib/import/__fixtures__/foreflight-v1.csv", import.meta.url),
  ),
);
const eicar = await readFile(
  fileURLToPath(
    new URL(
      "../src/lib/import/__fixtures__/durable-eicar-foreflight.csv",
      import.meta.url,
    ),
  ),
);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

try {
  await page.goto(new URL("/auth/sign-in", base).toString(), {
    waitUntil: "networkidle",
  });
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/map", { timeout: 30_000 });

  const cleanResult = await uploadAndWait(
    page,
    `durable-clean-${Date.now()}.csv`,
    clean,
  );
  if (!["review", "deduplicated"].includes(cleanResult.status)) {
    throw new Error(`Clean import ended in unsafe status ${cleanResult.status}.`);
  }
  if (cleanResult.error) {
    throw new Error(`Clean import returned error code ${cleanResult.error.code}.`);
  }

  const infectedResult = await uploadAndWait(
    page,
    `durable-eicar-${Date.now()}.csv`,
    eicar,
  );
  if (
    infectedResult.status !== "quarantined" ||
    infectedResult.error?.code !== "malware-detected"
  ) {
    throw new Error(
      `EICAR import was not quarantined safely (${infectedResult.status}, ${
        infectedResult.error?.code ?? "no-error-code"
      }).`,
    );
  }
  if (
    JSON.stringify(infectedResult).includes("X5O!") ||
    infectedResult.rows?.rows?.some((row) => row.rawSnapshot !== null)
  ) {
    throw new Error("The EICAR response exposed retained upload content.");
  }

  console.log(
    "Durable import smoke passed: clean CSV reached review/deduplication and EICAR was quarantined without response data exposure.",
  );
} finally {
  await browser.close();
}

async function uploadAndWait(page, fileName, bytes) {
  const idempotencyKey = `hosted-smoke:${Date.now()}:${fileName.includes("eicar") ? "eicar" : "clean"}`;
  const initiated = await sameOriginJson(page, "/api/import/upload/initiate", {
    fileName,
    contentType: "text/csv",
    sizeBytes: bytes.length,
    idempotencyKey,
  });
  const upload = await page.evaluate(
    async ({ url, headers, base64 }) => {
      const binary = atob(base64);
      const body = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
      const response = await fetch(url, { method: "PUT", headers, body });
      return { ok: response.ok, status: response.status };
    },
    {
      url: initiated.uploadUrl,
      headers: initiated.headers,
      base64: bytes.toString("base64"),
    },
  );
  if (!upload.ok) {
    throw new Error(`Private object upload failed with status ${upload.status}.`);
  }
  await sameOriginJson(page, "/api/import/upload/finalize", {
    batchId: initiated.batchId,
  });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const response = await page.request.get(
      new URL(`/api/import/batches/${initiated.batchId}`, base).toString(),
      { failOnStatusCode: false },
    );
    if (!response.ok()) {
      throw new Error(`Import status failed with status ${response.status()}.`);
    }
    const payload = await response.json();
    const detail = payload.batch ?? payload;
    if (
      [
        "review",
        "deduplicated",
        "quarantined",
        "failed",
        "cancelled",
      ].includes(detail.status)
    ) {
      return detail;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Durable import processing did not reach a terminal review state.");
}

async function sameOriginJson(page, path, body) {
  const response = await page.request.post(new URL(path, base).toString(), {
    data: body,
    headers: { origin: base.origin },
    failOnStatusCode: false,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok()) {
    throw new Error(
      `${path} failed with status ${response.status()} and code ${
        result.error?.code ?? "unknown"
      }.`,
    );
  }
  return result;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

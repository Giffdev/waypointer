import { randomBytes } from "node:crypto";
import process from "node:process";
import { chromium } from "@playwright/test";

const baseUrlValue = process.env.PUBLIC_AUTH_SMOKE_BASE_URL?.trim();
const emailDomain = process.env.PUBLIC_AUTH_SMOKE_EMAIL_DOMAIN?.trim();
const inboxUrlValue = process.env.PUBLIC_AUTH_SMOKE_INBOX_URL?.trim();
const inboxToken = process.env.PUBLIC_AUTH_SMOKE_INBOX_TOKEN?.trim();
const forbiddenInputs = [
  "VERCEL_AUTOMATION_BYPASS_SECRET",
  "VERCEL_PROTECTION_BYPASS",
  "AUTH_PREVIEW_ACCESS_SECRET",
  "AUTH_PREVIEW_ALLOWED_EMAILS",
  "FLIGHT_MAP_E2E_EMAIL",
  "FLIGHT_MAP_E2E_PASSWORD",
];

if (!baseUrlValue || !emailDomain || !inboxUrlValue) {
  throw new Error(
    "PUBLIC_AUTH_SMOKE_BASE_URL, PUBLIC_AUTH_SMOKE_EMAIL_DOMAIN, and PUBLIC_AUTH_SMOKE_INBOX_URL are required.",
  );
}
for (const name of forbiddenInputs) {
  if (process.env[name]?.trim()) {
    throw new Error(
      `${name} must not be supplied to the public authentication smoke.`,
    );
  }
}

const baseUrl = new URL(baseUrlValue);
if (baseUrl.protocol !== "https:") {
  throw new Error("PUBLIC_AUTH_SMOKE_BASE_URL must use HTTPS.");
}
const runId = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
const email = `public-auth-${runId}@${emailDomain}`;
const username = `publicqa${runId}`.toLowerCase().slice(0, 30);
const password = `Public smoke ${randomBytes(12).toString("base64url")}!`;
const challengePattern =
  /vercel authentication|deployment protection|log in to vercel|password required/i;
const retiredGatePattern =
  /preview access code|invitation code|allowlisted|approved test accounts/i;

function assertApplicationResponse(response, page) {
  if (!response) throw new Error("The deployment returned no response.");
  if ([401, 403].includes(response.status())) {
    throw new Error(`The deployment returned external access status ${response.status()}.`);
  }
  const finalUrl = new URL(page.url());
  if (finalUrl.origin !== baseUrl.origin) {
    throw new Error(`The deployment redirected off-origin to ${finalUrl.origin}.`);
  }
}

async function assertNoExternalOrRetiredGate(page) {
  const body = await page.locator("body").innerText();
  if (challengePattern.test(`${await page.title()}\n${body}`)) {
    throw new Error("A Vercel or external deployment challenge is active.");
  }
  if (retiredGatePattern.test(body)) {
    throw new Error("Retired registration gate copy is visible.");
  }
  if (
    (await page
      .locator(
        'input[name="previewAccessCode"], input[name*="accessCode" i]',
      )
      .count()) > 0
  ) {
    throw new Error("A retired registration gate field is present.");
  }
}

async function pollVerificationUrl() {
  if (!inboxUrlValue) return undefined;
  const inboxUrl = new URL(inboxUrlValue);
  inboxUrl.searchParams.set("email", email);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch(inboxUrl, {
      headers: inboxToken
        ? { Authorization: `Bearer ${inboxToken}` }
        : undefined,
    });
    if (response.ok) {
      const payload = await response.json();
      const value = payload.verificationUrl ?? payload.url;
      if (typeof value === "string" && value) return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("The verification email did not arrive within 60 seconds.");
}

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

try {
  const response = await page.goto(new URL("/auth/register", baseUrl).toString());
  assertApplicationResponse(response, page);
  await assertNoExternalOrRetiredGate(page);
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill(password);
  await Promise.all([
    page.waitForURL(
      (url) =>
        url.pathname === "/auth/verify" ||
        (url.pathname === "/auth/register" &&
          url.searchParams.has("error")),
      { timeout: 30_000 },
    ),
    page.getByRole("button", { name: "Create account" }).click(),
  ]);
  const registrationError = new URL(page.url()).searchParams.get("error");
  if (registrationError === "preview-access-denied") {
    throw new Error("The registration API rejected a public arbitrary email.");
  }
  if (registrationError) {
    throw new Error(
      `Public registration failed with application error: ${registrationError}.`,
    );
  }
  await assertNoExternalOrRetiredGate(page);

  let verificationUrl =
    new URL(page.url()).searchParams.has("token") ? page.url() : undefined;
  verificationUrl ??= await pollVerificationUrl();
  const parsedVerificationUrl = new URL(verificationUrl);
  if (
    parsedVerificationUrl.origin !== baseUrl.origin ||
    parsedVerificationUrl.pathname !== "/auth/verify" ||
    parsedVerificationUrl.searchParams.get("email") !== email
  ) {
    throw new Error("The inbox adapter returned an invalid verification URL.");
  }
  await page.goto(parsedVerificationUrl.toString());
  await page.getByRole("button", { name: "Verify email" }).click();
  await page.waitForURL(/\/auth\/sign-in\?verified=true$/, {
    timeout: 30_000,
  });
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/map$/, { timeout: 30_000 });
  await page.goto(new URL("/settings", baseUrl).toString());
  const currentPassword = page.getByLabel("Current password");
  if (await currentPassword.isVisible().catch(() => false)) {
    await currentPassword.fill(password);
  }
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /account disabled/i })
    .waitFor();
  console.log(
    "Public auth smoke passed: register, verify, sign in, map, and delete.",
  );
} finally {
  await context.close();
  await browser.close();
}

import { expect, test } from "@playwright/test";

const persistedEmail = process.env.FLIGHT_MAP_E2E_EMAIL;
const persistedPassword = process.env.FLIGHT_MAP_E2E_PASSWORD;
const persistedCredentialsEnabled =
  process.env.FLIGHT_MAP_E2E_PERSISTED === "true" &&
  Boolean(persistedEmail && persistedPassword);
const googleReauthEmail = process.env.FLIGHT_MAP_E2E_GOOGLE_EMAIL;
const googleReauthEnabled =
  process.env.FLIGHT_MAP_E2E_GOOGLE_REAUTH === "true" &&
  Boolean(
    process.env.FLIGHT_MAP_E2E_BASE_URL &&
      process.env.FLIGHT_MAP_E2E_GOOGLE_STORAGE_STATE &&
      googleReauthEmail,
  );
const googleReauthMaxMs = Number(
  process.env.FLIGHT_MAP_E2E_GOOGLE_REAUTH_MAX_MS ?? "15000",
);

async function expectDescription(
  control: ReturnType<Parameters<typeof expect>[0]["getByLabel"]>,
) {
  const describedBy = await control.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  for (const id of describedBy?.split(/\s+/) ?? []) {
    await expect(control.page().locator(`#${id}`)).toBeVisible();
  }
}

test("sign-in and registration are clearly linked and accessibly described", async ({
  page,
}) => {
  const authErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /UnsupportedStrategy|credentials only supported if JWT/i.test(
        message.text(),
      )
    ) {
      authErrors.push(message.text());
    }
  });

  await page.goto("/auth/sign-in");
  await expect(
    page.getByRole("heading", { name: "Sign in to Waypointer" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);

  const email = page.getByLabel("Email address", { exact: true });
  const password = page.getByLabel("Password", { exact: true });
  await expect(email).toHaveAttribute("autocomplete", "email");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await expectDescription(email);
  await expectDescription(password);
  await expect(
    page.getByText("Open your private map, flight history, and imports."),
  ).toBeVisible();

  await email.focus();
  await expect(email).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();

  const createAccount = page.getByRole("link", {
    name: "Create an account",
  });
  await createAccount.focus();
  await expect(createAccount).toBeFocused();
  await Promise.all([
    page.waitForURL(/\/auth\/register$/, { timeout: 15_000 }),
    page.keyboard.press("Enter"),
  ]);
  await expect(
    page.getByRole("heading", { name: "Create your Waypointer account" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in", exact: true }))
    .toHaveAttribute("href", "/auth/sign-in");

  const username = page.getByLabel("Username");
  const newPassword = page.getByLabel("Password", { exact: true });
  const confirmation = page.getByLabel("Confirm password", { exact: true });
  await expect(username).toHaveAttribute("autocomplete", "username");
  await expect(newPassword).toHaveAttribute("autocomplete", "new-password");
  await expect(confirmation).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByLabel(/preview access code/i)).toHaveCount(0);
  await expectDescription(username);
  await expectDescription(newPassword);
  await expectDescription(confirmation);
  await expect(page.getByText(/start a personal map/i)).toBeVisible();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(authErrors).toEqual([]);
});

test("unconfigured auth is honest and prevents unusable submissions", async ({
  page,
}) => {
  await page.goto("/auth/sign-in");
  await expect(page.locator("#auth-unavailable[role=status]")).toContainText(
    /unavailable in this preview environment/i,
  );
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Sign in" }))
    .toHaveAttribute("aria-describedby", "auth-unavailable");

  await page.goto("/auth/register");
  await expect(page.getByRole("button", { name: "Create account" }))
    .toBeDisabled();
  await expect(page.locator("#auth-unavailable[role=status]")).toContainText(
    /account creation is unavailable in this preview environment/i,
  );
  await expect(page.locator("form")).not.toHaveAttribute("aria-busy", "true");
});

test("auth errors and verification guidance use announced status semantics", async ({
  page,
}) => {
  await page.goto("/auth/sign-in?error=invalid-credentials");
  await expect(page.locator(".auth-message[role=alert]")).toContainText(
    /couldn't sign you in.*verified/i,
  );

  await page.goto("/auth/sign-in?verified=true");
  await expect(page.locator(".auth-message-success[role=status]")).toContainText(
    /email verified.*sign in/i,
  );

  await page.goto("/auth/register?error=invalid-password");
  await expect(page.locator(".auth-message[role=alert]")).toContainText(
    /passwords must match/i,
  );

  await page.goto(
    "/auth/verify?sent=true&email=synthetic.pilot%40example.test",
  );
  await expect(
    page.getByRole("heading", { name: "Check your inbox" }),
  ).toBeVisible();
  await expect(page.locator(".auth-message-success[role=status]")).toContainText(
    /synthetic.pilot@example.test.*expires/i,
  );
  await expect(page.getByRole("link", { name: "Return to sign in" }))
    .toHaveAttribute("href", "/auth/sign-in");

  await page.goto("/auth/verify?error=invalid-or-expired");
  await expect(page.locator(".auth-message[role=alert]")).toContainText(
    /invalid or expired.*newest link/i,
  );
});

test("configured credentials sign-in reaches the private map", async ({
  page,
}) => {
  test.skip(
    !persistedCredentialsEnabled,
    "Persisted E2E credentials are not configured.",
  );

  await page.goto("/auth/sign-in");
  await page
    .getByLabel("Email address", { exact: true })
    .fill(persistedEmail!);
  await page
    .getByLabel("Password", { exact: true })
    .fill(persistedPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(/\/map$/);
  await expect(
    page.getByRole("region", {
      name: /interactive cartographic flight map/i,
    }),
  ).toBeVisible();
});

test("profile sign-out returns home and clears protected access", async ({
  page,
  context,
}) => {
  test.skip(
    !persistedCredentialsEnabled,
    "Persisted E2E credentials are not configured.",
  );

  await page.goto("/auth/sign-in");
  await page
    .getByLabel("Email address", { exact: true })
    .fill(persistedEmail!);
  await page
    .getByLabel("Password", { exact: true })
    .fill(persistedPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/map$/);

  await page.goto("/settings");
  await page.getByRole("button", { name: "Sign out" }).click();

  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/$/);
  expect(
    (await context.cookies()).some((cookie) =>
      cookie.name.endsWith("authjs.session-token"),
    ),
  ).toBe(false);
  await page.goto("/settings");
  await expect(page).toHaveURL(
    /\/auth\/sign-in\?callbackUrl=%2Fsettings$/,
  );
});

test("production hard gate: clean sign-out then Google sign-in completes promptly", async ({
  page,
}) => {
  test.skip(
    !googleReauthEnabled,
    "Production Google reauthentication state is not configured.",
  );
  test.setTimeout(60_000);

  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Private account settings" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/^https:\/\/[^/]+\/$/);

  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  const startedAt = Date.now();
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.waitForURL(/accounts\.google\.com/, { timeout: 10_000 });
  await page.getByText(googleReauthEmail!, { exact: true }).first().click();
  await expect(page).toHaveURL(/\/map$/, { timeout: googleReauthMaxMs });
  expect(Date.now() - startedAt).toBeLessThan(googleReauthMaxMs);
  await expect(
    page.getByRole("region", {
      name: /interactive cartographic flight map/i,
    }),
  ).toBeVisible();
});

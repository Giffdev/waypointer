import { expect, test } from "@playwright/test";

const email = process.env.FLIGHT_MAP_E2E_EMAIL;
const password = process.env.FLIGHT_MAP_E2E_PASSWORD;
const enabled =
  process.env.FLIGHT_MAP_E2E_PERSISTED === "true" &&
  Boolean(email && password);
const csv = Buffer.from(
  [
    "Date,Flight number,From,To,Dep time,Arr time,Duration,Airline,Aircraft,Registration,Seat number,Seat type,Flight class,Flight reason,Note,Dep_id,Arr_id,Airline_id,Aircraft_id",
    "2026-04-05,AS100,Seattle (SEA/KSEA),New York (JFK/KJFK),08:05,16:35,05:30,Alaska Airlines,Boeing 737,N123AB,,,,,,,,,",
    "2026-04-05,AS100,Seattle (SEA/KSEA),New York (JFK/KJFK),08:05,16:35,05:30,Alaska Airlines,Boeing 737,N123AB,,,,,,,,,",
    "2026-04-05,AS100,Seattle (SEA/KSEA),New York (JFK/KJFK),08:05,16:35,05:30,Alaska Airlines,Boeing 737,N123AB,,,,,,,,,",
  ].join("\n"),
);
const genericCsv = Buffer.from(
  [
    "TripDay,StartCode,EndCode,PrivateMemo",
    "2026-08-13,SEA,JFK,never-render-this-sentinel",
    "2026-08-14,JFK,LHR,never-render-this-sentinel",
  ].join("\n"),
);

test("persisted import review corrects an airport and explicitly resolves a duplicate", async ({
  page,
}) => {
  test.skip(!enabled, "Persisted import E2E credentials are not configured.");

  await page.goto("/auth/sign-in");
  await page.getByLabel("Email").fill(email!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.goto("/map");
  await page.getByRole("link", { name: "Import" }).click();
  await expect(page).toHaveURL(/\/import$/);
  await expect(page.getByLabel("CSV file drop area")).toBeVisible();
  await expect(page.getByText(/\.csv files only/i)).toBeVisible();

  await page.getByLabel("Choose one supported CSV").setInputFiles({
    name: `e2e-${Date.now()}.csv`,
    mimeType: "text/csv",
    buffer: csv,
  });

  await page.getByRole("button", { name: "Upload and process" }).click();
  await expect(page.getByRole("heading", { name: /e2e-/ })).toBeVisible();

  await page.getByText("Correct flight").first().click();
  const origin = page.getByLabel(/Origin airport for row/).first();
  await origin.fill("Portland");
  await page
    .getByRole("button", { name: /PDX.*Portland International/i })
    .first()
    .click();
  await page.getByRole("button", { name: "Save correction" }).first().click();
  await expect(page.getByText(/duplicates unresolved/i)).toBeVisible();

  const useExisting = page.getByRole("button", { name: "Use existing" });
  const keepNew = page.getByRole("button", { name: "Keep as new" });
  if (await useExisting.first().isVisible().catch(() => false)) {
    await useExisting.first().click();
  } else if (await keepNew.first().isVisible().catch(() => false)) {
    await keepNew.first().click();
  } else {
    await page.getByRole("button", { name: "Accept" }).first().click();
  }
  await expect(
    page.getByRole("button", { name: /Commit \d+ accepted rows?/ }),
  ).toBeEnabled();
});

test("map navigation opens generic CSV mapping, sanitized preview, and existing review", async ({
  page,
}) => {
  test.skip(!enabled, "Persisted import E2E credentials are not configured.");

  await page.goto("/auth/sign-in");
  await page.getByLabel("Email").fill(email!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.goto("/map");
  await page.getByRole("link", { name: "Import" }).click();

  const fileName = `generic-e2e-${Date.now()}.csv`;
  await page.getByLabel("Choose one supported CSV").setInputFiles({
    name: fileName,
    mimeType: "text/csv",
    buffer: genericCsv,
  });

  await expect(
    page.getByRole("heading", { name: "Match this CSV to flight fields" }),
  ).toBeVisible();
  await expect(page.getByText("3 required")).toBeVisible();
  await page.getByLabel(/Flight date/).selectOption("TripDay");
  await page.getByLabel(/Origin airport/).selectOption("StartCode");
  await page.getByLabel(/Destination airport/).selectOption("EndCode");
  await expect(
    page.getByRole("heading", { name: "Sanitized preview" }),
  ).toBeVisible();
  await expect(page.getByText("2 valid")).toBeVisible();
  await expect(page.getByText("SEA → JFK")).toBeVisible();
  await expect(page.getByText(/never-render-this-sentinel/)).toHaveCount(0);
  await page.getByRole("button", { name: "Upload and process" }).click();
  await expect(page.getByRole("heading", { name: fileName })).toBeVisible();
});

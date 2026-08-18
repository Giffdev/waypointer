import { expect, test } from "@playwright/test";

function shownCount(status: string): number {
  const match = /^([\d,]+) of/.exec(status);
  if (!match) throw new Error(`Unexpected records status: ${status}`);
  return Number(match[1].replaceAll(",", ""));
}

test("interactive globe initializes, loads data, and survives filter updates", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/map");
  const globe = page.getByRole("region", {
    name: /interactive cartographic flight map/i,
  });
  await expect(globe).toHaveAttribute("data-map-ready", "true", {
    timeout: 15_000,
  });
  await expect(globe).toHaveAttribute("aria-busy", "false");
  await expect(
    page.getByText("Preparing the interactive globe…", { exact: true }),
  ).toHaveCount(0);
  await expect(globe.locator("canvas")).toBeVisible();
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fit my flights" })).toBeVisible();

  const initialRoutes = Number(await globe.getAttribute("data-route-count"));
  const airports = Number(await globe.getAttribute("data-airport-count"));
  expect(initialRoutes).toBeGreaterThan(0);
  expect(airports).toBeGreaterThan(0);

  await page
    .getByRole("combobox", { name: "Filter flights by flight role or type" })
    .selectOption("private");
  await expect(page).toHaveURL(/\/map\?type=private$/);
  await expect(globe).toHaveAttribute("data-map-ready", "true");
  await expect
    .poll(async () => Number(await globe.getAttribute("data-route-count")))
    .not.toBe(initialRoutes);
  expect(Number(await globe.getAttribute("data-route-count"))).toBeGreaterThan(0);
  expect(consoleErrors).toEqual([]);
});

test("source filtering updates history, URL, navigation, stats, and map data", async ({
  page,
}) => {
  await page.goto("/flights");
  const status = page.getByRole("status", { name: "Flight records status" });
  const source = page.getByRole("combobox", {
    name: "Filter flights by import source",
  });
  const initialCount = shownCount(await status.innerText());

  await source.click();
  await source.selectOption("ForeFlight");

  await expect(page).toHaveURL(/\/flights\?source=ForeFlight$/);
  await expect(source).toHaveValue("ForeFlight");
  const foreFlightCount = shownCount(await status.innerText());
  expect(foreFlightCount).toBeGreaterThan(0);
  expect(foreFlightCount).toBeLessThan(initialCount);
  await expect(page.locator(".flight-row .record-tags span:last-child")).toHaveText(
    Array(Math.min(foreFlightCount, 50)).fill("ForeFlight"),
  );

  await page.getByRole("link", { name: "Map" }).first().click();
  await expect(page).toHaveURL(/\/map\?source=ForeFlight$/);
  await expect(page.locator(".filter-heading strong")).toContainText(
    `${foreFlightCount.toLocaleString()} flights`,
  );

  await page.goBack();
  await expect(source).toHaveValue("ForeFlight");
  await page.goBack();
  await expect(page).toHaveURL(/\/flights$/);
  await expect(source).toHaveValue("all");
  await page.goForward();
  await expect(source).toHaveValue("ForeFlight");
});

test("metadata comboboxes support pointer, typing, selection, clear, and keyboard", async ({
  page,
}) => {
  await page.goto("/flights");
  await page.locator("details.route-filter-disclosure > summary").click();

  const aircraft = page.getByRole("combobox", {
    name: "Filter flights by aircraft type or model",
  });
  await aircraft.click();
  await expect(aircraft).toBeFocused();
  await expect(aircraft).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("listbox", { name: "Aircraft type / model options" }),
  ).toBeVisible();

  await aircraft.fill("cessna 172");
  await page.getByRole("option", { name: "Cessna 172", exact: true }).click();
  await expect(page).toHaveURL(/aircraft=Cessna\+172/);
  await expect(aircraft).toHaveValue("Cessna 172");

  await page
    .getByRole("button", { name: "Clear aircraft type / model filter" })
    .click();
  await expect(page).not.toHaveURL(/aircraft=/);
  await expect(aircraft).toHaveValue("All available aircraft");

  const registration = page.getByRole("combobox", {
    name: "Filter flights by tail number or registration",
  });
  await registration.click();
  await expect(registration).toHaveAttribute("aria-expanded", "true");
  await registration.fill("not-a-registration");
  await expect(
    page.getByText("No options match “not-a-registration”", { exact: true }),
  ).toBeVisible();
  await registration.press("Escape");
  await expect(registration).toHaveValue("All available registrations");

  await aircraft.click();
  await aircraft.press("ArrowDown");
  await aircraft.press("Enter");
  await expect(page).toHaveURL(/aircraft=/);
  await expect(aircraft).not.toHaveValue("All available aircraft");
});

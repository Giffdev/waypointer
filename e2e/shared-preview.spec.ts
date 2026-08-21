import { expect, test } from "@playwright/test";

const storageKey = "waypointer:map-share-preview";
const parentSentinelKey = "waypointer:e2e-parent-only";
const projection = {
  owner: { displayName: null },
  summary: { flightCount: 3, routeCount: 1 },
  routes: [
    {
      id: "browser-preview-route",
      kind: "commercial",
      flightCount: 3,
      origin: { lat: 47.4, lon: -122.3, country: "US" },
      destination: { lat: 40.6, lon: -73.8, country: "US" },
    },
  ],
};

test("settings preview opens an isolated interactive tab that survives navigation", async ({
  page,
}) => {
  await page.route(/\/api\/account\/sharing$/, async (route) => {
    expect(route.request().method()).toBe("GET");
    await route.fulfill({
      json: {
        sharing: {
          enabled: false,
          sharePath: null,
          includeDisplayName: false,
          publishedFlightCount: 0,
        },
      },
    });
  });
  await page.route(/\/api\/account\/sharing\/preview$/, async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({
      includeDisplayName: false,
    });
    await route.fulfill({
      json: {
        preview: {
          previewId: "a".repeat(64),
          includeDisplayName: false,
          projection,
        },
      },
    });
  });

  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Private account settings" }),
  ).toBeVisible();
  await page.evaluate(
    ({ key, value }) => window.sessionStorage.setItem(key, value),
    { key: parentSentinelKey, value: "keep-in-parent" },
  );

  const popupPromise = page.waitForEvent("popup");
  await page
    .getByRole("button", { name: "Preview shared map" })
    .click();
  const popup = await popupPromise;
  const heading = popup.getByRole("heading", {
    name: "Shared Waypointer map preview",
  });
  await expect(heading).toBeVisible();
  await expect(popup).toHaveURL(/\/shared\/preview$/);
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  expect(
    await popup.evaluate(
      (key) => window.sessionStorage.getItem(key),
      parentSentinelKey,
    ),
  ).toBeNull();
  expect(
    await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      parentSentinelKey,
    ),
  ).toBe("keep-in-parent");

  const envelope = await popup.evaluate((key) => {
    const value = window.sessionStorage.getItem(key);
    return value ? JSON.parse(value) : null;
  }, storageKey);
  expect(envelope).toEqual({
    nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
    projection,
  });

  await popup.reload();
  await expect(heading).toBeVisible();
  expect(
    await popup.evaluate(
      (key) => window.sessionStorage.getItem(key),
      storageKey,
    ),
  ).not.toBeNull();

  await popup.goto("/auth/sign-in");
  await popup.goBack();
  await expect(heading).toBeVisible();
  await expect(
    popup.getByText(
      "Approximate aggregated routes · 3 flights · 1 routes",
    ),
  ).toBeVisible();

  const flatMap = popup.getByRole("button", { name: "Flat map" });
  await flatMap.click();
  await expect(flatMap).toHaveAttribute("aria-pressed", "true");
  const interactiveMap = popup.getByRole("region", {
    name: /interactive flat projected map/i,
  });
  await expect(interactiveMap).toHaveAttribute("data-view-mode", "flat");
  await expect(interactiveMap).toHaveAttribute("data-map-ready", "true", {
    timeout: 15_000,
  });
});

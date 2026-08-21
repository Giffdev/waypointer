import { expect, test } from "@playwright/test";

const projection = {
  owner: { displayName: null },
  summary: { flightCount: 3, routeCount: 1 },
  routes: [
    {
      id: "public-route",
      kind: "commercial",
      flightCount: 3,
      origin: { lat: 47.4, lon: -122.3, country: "US" },
      destination: { lat: 40.6, lon: -73.8, country: "US" },
    },
  ],
};

test("enables the entire public map and returns an absolute username link", async ({
  page,
}) => {
  const writes: string[] = [];
  await page.route(/\/api\/account\/sharing$/, async (route) => {
    if (route.request().method() === "POST") {
      writes.push(route.request().method());
      await route.fulfill({
        json: {
          sharing: {
            enabled: true,
            publicHandle: "readable-pilot",
            sharePath: "/readable-pilot",
            publishedFlightCount: 3,
          },
        },
      });
      return;
    }
    if (route.request().method() === "DELETE") {
      writes.push(route.request().method());
      await route.fulfill({
        json: {
          sharing: {
            enabled: false,
            publicHandle: "readable-pilot",
            sharePath: null,
            publishedFlightCount: 0,
          },
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        sharing: {
          enabled: false,
          publicHandle: "readable-pilot",
          sharePath: null,
          publishedFlightCount: 0,
        },
      },
    });
  });
  await page.route(/\/api\/shared\/readable-pilot$/, (route) =>
    route.fulfill({ json: { map: projection } }),
  );

  await page.goto("/settings");
  await page.getByRole("button", { name: "Share my map" }).click();

  const publicUrl = `${new URL(page.url()).origin}/readable-pilot`;
  await expect(page.getByRole("textbox", { name: "Public map link" })).toHaveValue(
    publicUrl,
  );
  expect(writes).toEqual(["POST"]);

  const publicPagePromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open public map" }).click();
  const publicPage = await publicPagePromise;
  await expect(publicPage).toHaveURL(publicUrl);

  await page.getByRole("button", { name: "Disable sharing" }).click();
  await expect(page.getByText("Private - sharing is off")).toBeVisible();
  expect(writes).toEqual(["POST", "DELETE"]);
});

test("opens a public username route with no key or token", async ({ page }) => {
  const requests: Array<{ method: string; body: string | null }> = [];
  await page.route(/\/api\/shared\/readable-pilot$/, async (route) => {
    requests.push({
      method: route.request().method(),
      body: route.request().postData(),
    });
    await route.fulfill({ json: { map: projection } });
  });

  await page.goto("/readable-pilot");

  await expect(
    page.getByRole("heading", { name: "Shared Waypointer map" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Shared Waypointer map" }),
  ).toBeVisible();
  expect(requests).toEqual([{ method: "GET", body: null }]);
});

test("shows the generic unavailable state for an unknown or disabled handle", async ({
  page,
}) => {
  await page.route(/\/api\/shared\/unknown$/, (route) =>
    route.fulfill({
      status: 404,
      json: {
        error: {
          code: "not-found",
          message: "Waypointer shared map not found.",
        },
      },
    }),
  );

  await page.goto("/unknown");
  await expect(
    page.getByRole("heading", { name: "Shared map not found" }),
  ).toBeVisible();
});

test("keeps reserved static roots out of the public handle route", async ({
  page,
}) => {
  let sharedRequests = 0;
  await page.route(/\/api\/shared\//, async (route) => {
    sharedRequests += 1;
    await route.abort();
  });

  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Account settings" }),
  ).toBeVisible();
  expect(sharedRequests).toBe(0);
});

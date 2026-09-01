import { expect, test } from "@playwright/test";
import { CANONICAL_PRODUCTION_ORIGIN } from "../scripts/production-reauth-gate";
import { installOpenMapAttributionFixture } from "./map-style-fixture";

const projection = {
  schemaVersion: 3,
  owner: { displayName: null },
  summary: { flightCount: 4, routeCount: 2 },
  routes: [
    {
      id: "public-route",
      kind: "commercial",
      flightCount: 3,
      forwardFlightCount: 2,
      reverseFlightCount: 1,
      directionMode: "both",
      origin: {
        code: "SEA",
        name: "Seattle-Tacoma International Airport",
        city: "Seattle",
        lat: 47.4,
        lon: -122.3,
        country: "US",
        facility: "commercial",
      },
      destination: {
        code: "JFK",
        name: "John F Kennedy International Airport",
        city: "New York",
        lat: 40.6,
        lon: -73.8,
        country: "US",
        facility: "commercial",
      },
    },
    {
      id: "unrelated-route",
      kind: "private",
      flightCount: 1,
      forwardFlightCount: 1,
      reverseFlightCount: 0,
      directionMode: "one-way",
      origin: {
        code: "DEN",
        name: "Denver International Airport",
        city: "Denver",
        lat: 39.8561,
        lon: -104.6737,
        country: "US",
        facility: "commercial",
      },
      destination: {
        code: "LHR",
        name: "London Heathrow Airport",
        city: "London",
        lat: 51.47,
        lon: -0.4543,
        country: "GB",
        facility: "commercial",
      },
    },
  ],
  flights: [
    {
      date: "2025-01-10",
      kind: "commercial",
      role: "passenger",
      aircraft: ["Boeing 737"],
      registration: "N100AA",
      routeLegs: [{ routeId: "public-route", direction: "forward" }],
    },
    {
      date: "2024-12-01",
      kind: "private",
      role: "passenger",
      aircraft: ["Piper PA-28"],
      registration: "N400DD",
      routeLegs: [{ routeId: "unrelated-route", direction: "forward" }],
    },
    {
      date: "2026-02-20",
      kind: "commercial",
      role: "passenger",
      aircraft: ["Airbus A320"],
      registration: "N200BB",
      routeLegs: [{ routeId: "public-route", direction: "reverse" }],
    },
    {
      date: "2026-03-15",
      kind: "commercial",
      role: "pilot",
      aircraft: ["Cessna 172"],
      registration: "N300CC",
      routeLegs: [{ routeId: "public-route", direction: "forward" }],
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
  await page.route(/\/api\/shared\/readable-pilot(\?|$)/, (route) =>
    route.fulfill({ json: { map: projection } }),
  );

  await page.goto("/settings");
  await page.getByRole("button", { name: "Share my map" }).click();

  const publicUrl = `${CANONICAL_PRODUCTION_ORIGIN}/readable-pilot`;
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
  await page.route(/\/api\/shared\/readable-pilot(\?|$)/, async (route) => {
    requests.push({
      method: route.request().method(),
      body: route.request().postData(),
    });
    await route.fulfill({ json: { map: projection } });
  });
  await installOpenMapAttributionFixture(page);

  await page.goto("/readable-pilot");

  await expect(page.getByText("MVP production", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Shared Waypointer map" }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Shared Waypointer map" }),
  ).toBeVisible();
  const attribution = page.locator(".maplibregl-ctrl-attrib");
  await expect(attribution).toBeVisible();
  await expect(attribution).toContainText("OpenMapTiles");
  await expect(attribution).toContainText("OpenStreetMap");
  await expect(page.locator(".maplibregl-ctrl-attrib-button")).toBeHidden();
  await expect(page.getByText("Mapzen Terrarium", { exact: false })).toHaveCount(0);
  const terrainCredits = page.getByText("Terrain data credits", { exact: true });
  await expect(terrainCredits).toBeVisible();
  await terrainCredits.click();
  await expect(
    page.getByRole("link", { name: "Full terrain provider attribution (joerd)" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/tilezen/joerd/blob/master/docs/attribution.md",
  );
  await expect(page.getByText(/3DEP \(formerly NED\)/)).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Filter shared flights by airport" }),
  ).toHaveValue("All shared airports");
  const busiestRoute = page.getByText(/Busiest route:/).locator("..");
  await expect(busiestRoute).toContainText(
    "SEA — Seattle-Tacoma International Airport",
  );
  await expect(busiestRoute).toContainText(
    "JFK — John F Kennedy International Airport",
  );
  await expect(page.locator("body")).not.toContainText(/\bR\d+\b/);
  await expect(page.locator("body")).not.toContainText(/Approximate region/i);
  expect(requests).toEqual([{ method: "GET", body: null }]);
});

test("pivots between 3D globe and flat map while preserving filters, stats, legend, and route cues, and toggling terrain attribution", async ({
  page,
}) => {
  const sharedRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/shared/readable-pilot") {
      sharedRequests.push(`${request.method()} ${path}`);
    }
  });
  await page.route(/\/api\/shared\/readable-pilot(\?|$)/, (route) =>
    route.fulfill({ json: { map: projection } }),
  );
  await installOpenMapAttributionFixture(page);

  await page.goto("/readable-pilot");
  const interactiveGlobe = page.getByRole("region", {
    name: /Interactive 3D globe|Interactive flat projected map/,
  });
  const globeButton = page.getByRole("button", { name: "3D globe" });
  const flatButton = page.getByRole("button", { name: "Flat map" });

  // Sensible default: opens in 3D globe, matching the private map default.
  await expect(globeButton).toHaveAttribute("aria-pressed", "true");
  await expect(interactiveGlobe).toHaveAttribute(
    "aria-label",
    /Interactive 3D globe/,
  );
  await expect(page.getByText("Terrain data credits")).toBeVisible();
  // The full required upstream-provider attribution list — not just a
  // generic summary link — must be reachable while the DEM/terrain source
  // is active (3D globe mode).
  await page.getByText("Terrain data credits").click();
  await expect(page.getByText(/3DEP \(formerly NED\)/)).toBeVisible();
  await expect(page.getByText(/Kartverket/)).toBeVisible();

  await page
    .getByLabel("Filter shared flights by role")
    .selectOption("pilot");
  await expect(page.getByRole("status")).toContainText(
    "Showing 1 of 4 shared flights",
  );
  const busiestBefore = await page
    .getByText(/Busiest route:/)
    .locator("..")
    .innerText();
  await expect(page.getByText("Map legend")).toBeVisible();

  // Keyboard accessibility: arrow keys move focus between the two choices.
  await flatButton.focus();
  await page.keyboard.press("ArrowRight");
  await expect(flatButton).toHaveAttribute("aria-pressed", "true");
  await expect(interactiveGlobe).toHaveAttribute(
    "aria-label",
    /Interactive flat projected map/,
  );
  // Flat mode omits the DEM/hillshade source, so its terrain credit — and
  // the full required upstream-provider attribution text — is absent.
  await expect(page.getByText("Terrain data credits")).toHaveCount(0);
  await expect(page.getByText(/3DEP \(formerly NED\)/)).toHaveCount(0);
  await expect(page.getByText(/Kartverket/)).toHaveCount(0);

  // Toggling the view must not refetch or lose filters/stats/legend/route cues.
  await expect(
    page.getByLabel("Filter shared flights by role"),
  ).toHaveValue("pilot");
  await expect(page.getByRole("status")).toContainText(
    "Showing 1 of 4 shared flights",
  );
  await expect(
    page.getByText(/Busiest route:/).locator(".."),
  ).toHaveText(busiestBefore);
  await expect(page.getByText("Map legend")).toBeVisible();
  expect(sharedRequests).toEqual(["GET /api/shared/readable-pilot"]);

  await globeButton.click();
  await expect(globeButton).toHaveAttribute("aria-pressed", "true");
  await expect(interactiveGlobe).toHaveAttribute(
    "aria-label",
    /Interactive 3D globe/,
  );
  await expect(page.getByText("Terrain data credits")).toBeVisible();
  // Re-expand after the toggle re-mounted the control (closed by default)
  // to confirm the full attribution text is reachable again in 3D mode.
  await page.getByText("Terrain data credits").click();
  await expect(page.getByText(/3DEP \(formerly NED\)/)).toBeVisible();
  await expect(
    page.getByLabel("Filter shared flights by role"),
  ).toHaveValue("pilot");
  expect(sharedRequests).toEqual(["GET /api/shared/readable-pilot"]);
});

test("keeps the view toggle usable at mobile widths", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route(/\/api\/shared\/readable-pilot(\?|$)/, (route) =>
    route.fulfill({ json: { map: projection } }),
  );
  await installOpenMapAttributionFixture(page);

  await page.goto("/readable-pilot");
  const globeButton = page.getByRole("button", { name: "3D globe" });
  const flatButton = page.getByRole("button", { name: "Flat map" });
  await expect(globeButton).toBeVisible();
  await expect(flatButton).toBeVisible();

  await flatButton.click();
  await expect(flatButton).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("region", { name: /Interactive flat projected map/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth + 1));
});

test("filters locally and renders truthful route modes on desktop and mobile", async ({
  page,
}) => {
  const apiWrites: string[] = [];
  const sharedRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/shared/readable-pilot") {
      sharedRequests.push(`${request.method()} ${path}`);
    }
    if (path.startsWith("/api/") && request.method() !== "GET") {
      apiWrites.push(`${request.method()} ${path}`);
    }
  });
  await page.route(/\/api\/shared\/readable-pilot(\?|$)/, (route) =>
    route.fulfill({ json: { map: projection } }),
  );

  await page.goto("/readable-pilot");
  await expect(page.getByRole("status")).toContainText(
    "Showing 4 of 4 shared flights",
  );
  await expect(page.getByText("Map legend")).toBeVisible();
  await expect(page.getByText("One-way route").locator("..")).toContainText(
    "➤",
  );
  await expect(page.getByText("Both directions").locator("..")).toContainText(
    "↔",
  );
  await expect(
    page.getByText(/SEA — Seattle-Tacoma International Airport ↔ JFK — John F Kennedy International Airport/),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Statistics for this view" }),
  ).toBeVisible();

  await page
    .getByLabel("Filter shared flights by role")
    .selectOption("pilot");
  await expect(page.getByRole("status")).toContainText(
    "Showing 1 of 4 shared flights",
  );
  await expect(page.getByText("Both directions")).toHaveCount(0);
  await expect(page.getByText("One-way route").locator("..")).toContainText(
    "➤",
  );
  await expect(page.getByText(/Busiest route:/).locator("..")).toContainText(
    "SEA — Seattle-Tacoma International Airport ➤ JFK — John F Kennedy International Airport",
  );
  expect(sharedRequests).toEqual(["GET /api/shared/readable-pilot"]);
  await page.getByRole("button", { name: "Clear filters" }).click();

  await page.getByLabel("Filter shared flights from date").fill("2026-01-01");
  await expect(page.getByRole("status")).toContainText(
    "Showing 2 of 4 shared flights",
  );
  await page.getByRole("button", { name: "Clear filters" }).click();

  const aircraft = page.getByRole("combobox", {
    name: "Filter shared flights by aircraft",
  });
  await aircraft.fill("Cessna 172");
  await aircraft.press("Enter");
  await expect(page.getByRole("status")).toContainText(
    "Showing 1 of 4 shared flights",
  );
  await page.getByRole("button", { name: "Clear filters" }).click();

  const registration = page.getByRole("combobox", {
    name: "Filter shared flights by tail number or registration",
  });
  await registration.fill("N300CC");
  await registration.press("Enter");
  await expect(page.getByRole("status")).toContainText(
    "Showing 1 of 4 shared flights",
  );
  await page.getByRole("button", { name: "Clear filters" }).click();

  const airport = page.getByRole("combobox", {
    name: "Filter shared flights by airport",
  });
  await airport.fill("SEA");
  await airport.press("Enter");
  await expect(page.getByRole("status")).toContainText(
    "Showing 3 of 4 shared flights",
  );
  const statistics = page.getByRole("region", {
    name: "Statistics for this view",
  });
  await expect(statistics.getByText("Routes").locator("..")).toContainText("1");
  await expect(statistics.getByText("Airports").locator("..")).toContainText("2");
  await expect(statistics).toContainText(
    "SEA — Seattle-Tacoma International Airport",
  );
  await expect(statistics).not.toContainText(/\bR\d+\b|Approximate region/i);

  expect(apiWrites).toEqual([]);
  expect(sharedRequests).toEqual(["GET /api/shared/readable-pilot"]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth + 1));
});

test("shows the generic unavailable state for an unknown or disabled handle", async ({
  page,
}) => {
  await page.route(/\/api\/shared\/unknown(\?|$)/, (route) =>
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

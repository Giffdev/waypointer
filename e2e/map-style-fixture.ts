import type { Page } from "@playwright/test";

export async function installOpenMapAttributionFixture(page: Page) {
  await page.route("https://tiles.openfreemap.org/styles/liberty", (route) =>
    route.fulfill({
      json: {
        version: 8,
        sources: {
          openmaptiles: {
            type: "vector",
            url: "https://tiles.openfreemap.org/planet",
          },
        },
        layers: [
          {
            id: "fixture",
            type: "circle",
            source: "openmaptiles",
            "source-layer": "fixture",
          },
        ],
      },
    }),
  );
  await page.route("https://tiles.openfreemap.org/planet", (route) =>
    route.fulfill({
      json: {
        tilejson: "3.0.0",
        tiles: ["https://tiles.openfreemap.org/fixture/{z}/{x}/{y}.pbf"],
        vector_layers: [
          {
            id: "fixture",
            fields: {},
            minzoom: 0,
            maxzoom: 14,
          },
        ],
        attribution:
          '<a href="https://openfreemap.org">OpenFreeMap</a> <a href="https://www.openmaptiles.org/">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
    }),
  );
  await page.route(
    "https://tiles.openfreemap.org/fixture/**/*.pbf",
    (route) => route.fulfill({ body: Buffer.alloc(0), contentType: "application/x-protobuf" }),
  );
}

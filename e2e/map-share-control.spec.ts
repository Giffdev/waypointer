import { expect, test, type Page } from "@playwright/test";

// MapShareControl only renders when the map route resolves `dataMode` to
// "persisted", which requires a real authenticated user with real
// database-backed flights (see src/lib/route-page-data.ts). There is no
// production-safe bypass for that gate, so this coverage follows the same
// existing pattern as e2e/import-review.spec.ts and the persisted cases in
// e2e/auth.spec.ts: it signs in with real, non-production E2E credentials
// and is skipped unless they are configured.
const email = process.env.FLIGHT_MAP_E2E_EMAIL;
const password = process.env.FLIGHT_MAP_E2E_PASSWORD;
const enabled =
  process.env.FLIGHT_MAP_E2E_PERSISTED === "true" &&
  Boolean(email && password);

async function mockSharingStatus(page: Page) {
  await page.route(/\/api\/account\/sharing$/, (route) =>
    route.fulfill({
      json: {
        sharing: {
          enabled: false,
          publicHandle: "e2e-pilot",
          sharePath: null,
          publishedFlightCount: 0,
        },
      },
    }),
  );
}

async function signInAndOpenMap(page: Page) {
  await page.goto("/auth/sign-in");
  await page.getByLabel("Email").fill(email!);
  await page.getByLabel("Password").fill(password!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/map$/);
}

for (const width of [320, 390]) {
  test(`fits the share control alongside the other map icon controls with no horizontal overflow at ${width}px`, async ({
    page,
  }) => {
    test.skip(!enabled, "Persisted map E2E credentials are not configured.");
    await page.setViewportSize({ width, height: 800 });
    await mockSharingStatus(page);
    await signInAndOpenMap(page);

    const controls = page.locator(".icon-controls");
    await expect(controls).toBeVisible();
    const shareButton = page.getByRole("button", { name: "Share map" });
    await expect(shareButton).toBeVisible();

    // Every icon-row control, including the newly added share button,
    // must actually fit inside the row's own box rather than merely
    // inside the page (no wrapping/clipping/crowding).
    const rowBox = await controls.boundingBox();
    const buttonBoxes = await Promise.all(
      [
        "Zoom in",
        "Zoom out",
        "Fit my flights",
        "Share map",
      ].map((name) => page.getByRole("button", { name }).boundingBox()),
    );
    expect(rowBox).not.toBeNull();
    for (const box of buttonBoxes) {
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(rowBox!.y - 1);
      expect(box!.y + box!.height).toBeLessThanOrEqual(
        rowBox!.y + rowBox!.height + 1,
      );
    }

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth + 1));

    // The popover itself (not just the trigger buttons) must stay fully
    // within the viewport when opened — it must neither overflow off the
    // right edge (the historical 44px-collapse bug) nor off the left edge
    // (which a naive fix for that bug can reintroduce at narrow widths).
    await shareButton.click();
    const dialog = page.getByRole("dialog", { name: "Share your map" });
    await expect(dialog).toBeVisible();
    const popupBox = await dialog.boundingBox();
    expect(popupBox).not.toBeNull();
    expect(popupBox!.x).toBeGreaterThanOrEqual(0);
    expect(popupBox!.x + popupBox!.width).toBeLessThanOrEqual(width + 1);
  });
}

test("keeps popover interaction inside its own boundary: it doesn't steal or block clicks on sibling map controls", async ({
  page,
}) => {
  test.skip(!enabled, "Persisted map E2E credentials are not configured.");
  await mockSharingStatus(page);
  await signInAndOpenMap(page);

  const zoomStatus = page.getByRole("status", { name: "Map zoom level" });
  const initialZoomText = await zoomStatus.textContent();

  await page.getByRole("button", { name: "Share map" }).click();
  const dialog = page.getByRole("dialog", { name: "Share your map" });
  await expect(dialog).toBeVisible();
  // Interact inside the popover: this must not reach the map/globe
  // underneath (it lives in a disjoint DOM subtree, so a real click can
  // only "leak" through a document-level listener such as the popover's
  // own outside-pointerdown dismissal, not native bubbling).
  await dialog.getByText(/entire map/i).click();
  expect(await zoomStatus.textContent()).toBe(initialZoomText);

  // Clicking a sibling map control while the popover is open must both
  // (a) dismiss the popover via the existing outside-pointerdown handler
  // and (b) still register its own click — proving that handler only
  // observes the event rather than intercepting/blocking it.
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(() => zoomStatus.textContent())
    .not.toBe(initialZoomText);
});

import { expect, test } from "@playwright/test";

test("private settings update and deletion confirmation stay owner-only", async ({
  page,
}) => {
  await page.route("**/api/account/profile", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        profile: {
          email: "preview@example.test",
          username: body.username,
          displayName: body.displayName,
          timeZone: body.timeZone,
          distanceUnit: body.distanceUnit,
          hasPassword: false,
        },
      }),
    });
  });
  await page.route("**/api/account/delete", async (route) => {
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        status: "pending",
        graceExpiresAt: "2026-08-19T18:00:00.000Z",
      }),
    });
  });

  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Private account settings" }),
  ).toBeVisible();
  await expect(page.getByText(/there is no public profile/i)).toBeVisible();
  await page
    .getByRole("textbox", { name: "Display name", exact: true })
    .fill("Updated Pilot");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Account settings saved.")).toBeVisible();

  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await expect(page.getByText(/Account disabled/i)).toBeVisible();
});

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
    name: /interactive .* flight routes/i,
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

test("Add flight stays single-line at 1080p and the heading still stacks responsively", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chrome",
    "One desktop browser covers both responsive viewport widths.",
  );

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/flights");
  await page.evaluate(() => document.fonts.ready);

  const heading = page.locator(".section-heading.record-heading");
  const addFlight = page.getByRole("button", { name: "Add flight" });
  const layout = () =>
    addFlight.evaluate((button) => {
      const textNode = Array.from(button.childNodes).find(
        (node) =>
          node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );
      if (!textNode) throw new Error("Add flight text node is missing.");
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const lineTops = new Set(
        Array.from(range.getClientRects()).map(({ top }) => Math.round(top)),
      );
      const styles = getComputedStyle(button);
      return {
        flexShrink: styles.flexShrink,
        lineCount: lineTops.size,
        whiteSpace: styles.whiteSpace,
      };
    });

  await expect(addFlight).toBeVisible();
  await expect(heading).toHaveCSS("flex-direction", "row");
  await expect(heading.locator(":scope > div").first()).toHaveCSS(
    "min-width",
    "0px",
  );
  await expect.poll(layout).toEqual({
    flexShrink: "0",
    lineCount: 1,
    whiteSpace: "nowrap",
  });

  await page.setViewportSize({ width: 760, height: 1000 });

  await expect(heading).toHaveCSS("flex-direction", "column");
  await expect.poll(layout).toEqual({
    flexShrink: "0",
    lineCount: 1,
    whiteSpace: "nowrap",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("Add flight reads as an accessible form on desktop and narrow screens", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop-chrome",
    "One desktop browser covers both responsive viewport widths.",
  );

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/flights");
  await page.getByRole("button", { name: "Add flight" }).click();

  const dialog = page.getByRole("dialog", { name: "Add one flight" });
  const classification = page.getByRole("group", {
    name: "Flight classification (required)",
  });
  const date = page.getByLabel("Date (required)");
  const departure = page.getByRole("combobox", {
    name: "Departure airport (required)",
  });
  const arrival = page.getByRole("combobox", {
    name: "Arrival airport (required)",
  });
  const fieldStyles = () =>
    date.evaluate((input) => {
      const styles = getComputedStyle(input);
      return {
        backgroundColor: styles.backgroundColor,
        borderStyle: styles.borderStyle,
        borderWidth: styles.borderWidth,
        cursor: styles.cursor,
        height: input.getBoundingClientRect().height,
      };
    });

  await expect(dialog).toBeVisible();
  await expect(classification).toBeVisible();
  await expect(date).toBeVisible();
  await expect(departure).toHaveAttribute("aria-required", "true");
  await expect(arrival).toHaveAttribute("aria-required", "true");
  await expect.poll(fieldStyles).toMatchObject({
    borderStyle: "solid",
    borderWidth: "1px",
    cursor: "pointer",
  });
  const initialStyles = await fieldStyles();
  expect(initialStyles.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(initialStyles.height).toBeGreaterThanOrEqual(48);

  const initialBorderColor = await date.evaluate(
    (input) => getComputedStyle(input).borderColor,
  );
  await date.hover();
  await expect
    .poll(() => date.evaluate((input) => getComputedStyle(input).borderColor))
    .not.toBe(initialBorderColor);
  await date.focus();
  await expect
    .poll(() => date.evaluate((input) => getComputedStyle(input).boxShadow))
    .not.toBe("none");

  await page.getByRole("button", { name: "Save flight" }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Choose Personal or Commercial, a date, and both airports.",
  );
  await expect(classification).toHaveAttribute("data-invalid", "true");
  await expect(date).toHaveAttribute("aria-invalid", "true");
  await expect(departure).toHaveAttribute("aria-invalid", "true");
  await expect(arrival).toHaveAttribute("aria-invalid", "true");

  const personal = page.getByRole("radio", { name: "Personal" });
  const commercial = page.getByRole("radio", { name: "Commercial" });
  await personal.focus();
  await personal.press("ArrowRight");
  await expect(commercial).toBeChecked();
  await expect(classification).toHaveAttribute("data-invalid", "false");

  await page.getByText("Optional flight details").click();
  await expect(page.getByLabel("Flight number (optional)")).toBeVisible();
  await expect(page.getByLabel("Aircraft type (optional)")).toBeVisible();
  await expect(
    page.getByLabel("Tail number / registration (optional)"),
  ).toBeVisible();

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(dialog).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator(".manual-airport-grid")
          .evaluate(
            (grid) =>
              getComputedStyle(grid).gridTemplateColumns.split(" ").length,
          ),
      )
      .toBe(1);
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
});

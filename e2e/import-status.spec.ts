import { expect, test } from "@playwright/test";

test("import stages use aligned, readable, honest status chips", async ({
  page,
}) => {
  await page.goto("/import");

  const workflow = page.getByLabel("Import review stages");
  const chips = workflow.locator(".status-chip");
  await expect(chips).toHaveText([
    "Available",
    "Not started",
    "Unavailable in preview",
  ]);
  const pendingChips = workflow.locator(".status-chip.pending");
  await expect(pendingChips).toHaveCount(1);
  await expect(pendingChips).toHaveText(["Not started"]);
  await expect(page.getByText(/exactly one high-confidence adapter must match/i))
    .toBeVisible();
  await expect(page.getByLabel("Choose one supported CSV"))
    .toBeEnabled();
  await expect(
    page.getByRole("button", { name: /commit unavailable/i }),
  ).toBeDisabled();

  const chipMetrics = await chips.evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      const styles = getComputedStyle(element);
      return {
        fitsViewport: bounds.right <= window.innerWidth,
        height: bounds.height,
        whiteSpace: styles.whiteSpace,
      };
    }),
  );
  expect(new Set(chipMetrics.map(({ height }) => height)).size).toBe(1);
  expect(chipMetrics.every(({ height }) => height >= 22)).toBe(true);
  expect(chipMetrics.every(({ fitsViewport }) => fitsViewport)).toBe(true);
  expect(chipMetrics.every(({ whiteSpace }) => whiteSpace === "nowrap")).toBe(true);

  const pendingChipMetrics = await pendingChips.evaluateAll((elements) =>
    elements.map((element) => {
      const chip = element as HTMLElement;
      const parent = chip.parentElement as HTMLElement;
      const chipBounds = chip.getBoundingClientRect();
      const parentBounds = parent.getBoundingClientRect();
      const styles = getComputedStyle(chip);
      return {
        justifySelf: styles.justifySelf,
        width: chipBounds.width,
        parentWidth: parentBounds.width,
        contentFits: chip.scrollWidth <= chip.clientWidth,
        staysOnOneLine: chip.scrollHeight <= chip.clientHeight,
      };
    }),
  );
  expect(
    pendingChipMetrics.every(({ justifySelf }) => justifySelf === "start"),
  ).toBe(true);
  expect(
    pendingChipMetrics.every(
      ({ width, parentWidth }) => width < parentWidth * 0.5,
    ),
  ).toBe(true);
  expect(
    pendingChipMetrics.every(({ contentFits, staysOnOneLine }) =>
      contentFits && staysOnOneLine
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

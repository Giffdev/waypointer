// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Strips `/* ... *&#47;` CSS comments so they can't be mistaken for real rules/selectors. */
function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Extracts the selector list (the part before `{`) of the first CSS rule
 * in `source` whose declaration block matches `bodyPattern`. Matching on
 * the declarations (not a hand-typed selector string) keeps the assertion
 * accurate even if the selector's formatting/whitespace changes, while
 * still failing if the rule's actual scoping regresses (e.g. back to a
 * bare descendant selector) because we test the *real* selector text
 * against real DOM structure below, via `Element.matches()`.
 */
function extractSelectorList(source: string, bodyPattern: RegExp): string[] {
  const ruleRegex = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = ruleRegex.exec(stripCssComments(source)))) {
    const [, selectorText, body] = match;
    if (bodyPattern.test(body)) {
      return selectorText
        .split(",")
        .map((selector) => selector.trim())
        .filter(Boolean);
    }
  }
  throw new Error("No CSS rule matched the given declaration pattern.");
}

/** True if any selector in `selectors` matches `element`. */
function matchesAny(element: Element, selectors: string[]): boolean {
  return selectors.some((selector) => {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  });
}

describe("mobile flight actions", () => {
  it("keeps both flight actions visible with stable touch targets", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const mobileRules = css.slice(css.indexOf("@media (max-width: 580px)"));

    expect(mobileRules).not.toMatch(/\.flight-actions\s*\{[^}]*display:\s*none/);
    expect(mobileRules).not.toMatch(/\.route small,\s*\.flight-actions/);
    expect(mobileRules).toMatch(
      /\.flight-actions\s*\{[^}]*grid-column:\s*2/,
    );
    expect(css).toMatch(
      /\.flight-action-button\s*\{[^}]*min-height:\s*44px[^}]*min-width:\s*44px/,
    );
  });

  it("keeps sidebar controls readable with stable touch targets and compact stacking", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const desktopRules = css.slice(0, css.indexOf("@media (max-width: 1000px)"));
    const narrowSidebarRules = css.slice(
      css.indexOf("@media (max-width: 1000px)"),
      css.indexOf("@media (max-width: 800px)"),
    );
    const veryNarrowRules = css.slice(css.indexOf("@media (max-width: 360px)"));

    // The 44x44 icon-tile rule is scoped to `.icon-controls`'s own direct
    // children plus the Share trigger (one level deeper, inside
    // `.map-share-control`) via `>` combinators -- not a bare descendant
    // selector, which would also reach into `.map-share-popup` and force
    // its text-labeled action buttons ("Share my map", "Copy link",
    // "Retry sharing status") into the same fixed 44x44 box.
    expect(desktopRules).toMatch(
      /\.icon-controls\s*>\s*button,\s*\.icon-controls\s*>\s*\.map-share-control\s*>\s*button\s*\{[^}]*height:\s*44px[^}]*min-width:\s*44px/,
    );
    // A regression back to the old bare descendant selector would add a
    // second, broader rule alongside (or instead of) the scoped one above;
    // guard against that directly (ignoring comments, which intentionally
    // reference the old selector's literal text), since the presence of
    // the correct rule alone doesn't prove the incorrect one was removed.
    expect(stripCssComments(desktopRules)).not.toMatch(/\.icon-controls\s+button\b/);
    expect(desktopRules).toMatch(/\.compact-type-select\s*\{[^}]*width:\s*100%/);
    expect(desktopRules).toMatch(
      /\.airport-select select\s*\{[^}]*min-height:\s*46px[^}]*text-overflow:\s*ellipsis/,
    );
    expect(desktopRules).toMatch(
      /\.period-select-control select\s*\{[^}]*min-height:\s*46px[^}]*width:\s*100%/,
    );
    expect(narrowSidebarRules).toMatch(
      /\.control-heading\s*\{[^}]*display:\s*grid/,
    );
    expect(veryNarrowRules).toMatch(
      /\.filter-select-grid\s*\{[^}]*grid-template-columns:\s*1fr/,
    );
  });

  it("scopes the icon-controls 44x44 touch target to direct icon buttons and the Share trigger only, excluding nested popup actions", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const desktopRules = css.slice(0, css.indexOf("@media (max-width: 1000px)"));

    // Pull the *actual* selector list off the rule that forces 44x44
    // sizing, then check it against real DOM structure via
    // `Element.matches()`. This proves the selectors' real matching
    // behavior (not just their textual shape), so a regression back to a
    // bare `.icon-controls button` descendant selector -- which would
    // also match the nested popup buttons below -- fails this test even
    // if someone reformats the selector list's whitespace/line-wrapping.
    const iconButtonSelectors = extractSelectorList(
      desktopRules,
      /height:\s*44px[^}]*min-width:\s*44px/,
    );

    // Mirrors the real markup: `.icon-controls` renders plain sibling
    // icon buttons plus `MapShareControl`, whose trigger button sits one
    // level deeper (inside `.map-share-control`) and whose popup content
    // (including the "Share my map" primary button and, once shared, the
    // "Copy link"/"Retry sharing status" secondary buttons) sits two
    // levels deeper still, inside `.map-share-popup`.
    const container = document.createElement("div");
    container.innerHTML = `
      <div class="icon-controls">
        <button id="zoom-in">Zoom in</button>
        <button id="home-control" class="home-control">Home</button>
        <div class="map-share-control">
          <button id="share-trigger">Share map</button>
          <div class="map-share-popup">
            <button id="share-my-map" class="primary-button">Share my map</button>
            <div class="sharing-actions">
              <button id="copy-link" class="secondary-button">Copy link</button>
            </div>
            <button id="retry-status" class="secondary-button">Retry sharing status</button>
          </div>
        </div>
      </div>
    `;

    const zoomIn = container.querySelector("#zoom-in")!;
    const homeControl = container.querySelector("#home-control")!;
    const shareTrigger = container.querySelector("#share-trigger")!;
    const shareMyMap = container.querySelector("#share-my-map")!;
    const copyLink = container.querySelector("#copy-link")!;
    const retryStatus = container.querySelector("#retry-status")!;

    // Ordinary direct icon-controls buttons and the MapShareControl
    // trigger must retain the 44x44 touch target.
    expect(matchesAny(zoomIn, iconButtonSelectors)).toBe(true);
    expect(matchesAny(homeControl, iconButtonSelectors)).toBe(true);
    expect(matchesAny(shareTrigger, iconButtonSelectors)).toBe(true);

    // Buttons nested inside the popup -- including "Share my map", which
    // the old bare descendant selector also incorrectly overrode, not
    // just "Copy link"/"Retry sharing status" -- must be excluded so
    // their text labels are never squeezed into a fixed icon tile.
    expect(matchesAny(shareMyMap, iconButtonSelectors)).toBe(false);
    expect(matchesAny(copyLink, iconButtonSelectors)).toBe(false);
    expect(matchesAny(retryStatus, iconButtonSelectors)).toBe(false);
  });

  it("keeps the period selector and statistics ribbon contained across map breakpoints", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const desktopRules = css.slice(0, css.indexOf("@media (max-width: 1000px)"));
    const tabletRules = css.slice(
      css.indexOf("@media (max-width: 800px)"),
      css.indexOf("@media (max-width: 580px)"),
    );

    expect(css).not.toContain(".quick-period-rail");
    expect(desktopRules).toMatch(/\.period-select\s*\{[^}]*min-width:\s*0/);
    expect(desktopRules).toMatch(
      /\.period-select-control\s*\{[^}]*min-width:\s*0/,
    );
    expect(desktopRules).toMatch(
      /\.stats-ribbon-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(tabletRules).toMatch(
      /\.map-stage\s*\{[^}]*display:\s*block[^}]*height:\s*auto/,
    );
  });

  it("keeps Flights filters compact and native select choices readable", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const desktopRules = css.slice(0, css.indexOf("@media (max-width: 1000px)"));
    const phoneRules = css.slice(
      css.indexOf("@media (max-width: 580px)"),
      css.indexOf("@media (max-width: 360px)"),
    );
    const forcedColorsRules = css.slice(css.indexOf("@media (forced-colors: active)"));

    expect(desktopRules).toMatch(
      /\.route-filter-header\s*\{[^}]*margin-bottom:\s*24px[^}]*overflow:\s*visible[^}]*padding:\s*0/,
    );
    expect(desktopRules).toMatch(
      /\.route-filter-disclosure > summary\s*\{[^}]*min-height:\s*72px/,
    );
    expect(desktopRules).toMatch(
      /\.route-filter-summary-toggle\s*\{[^}]*min-height:\s*44px/,
    );
    expect(desktopRules).toMatch(
      /\.metadata-combobox-control\s*\{[^}]*height:\s*46px[^}]*min-height:\s*46px/,
    );
    expect(desktopRules).toMatch(
      /\.metadata-combobox-popup \[role="option"\]\s*\{[^}]*min-height:\s*44px/,
    );
    expect(desktopRules).toMatch(
      /\.metadata-combobox-clear\s*\{[^}]*height:\s*44px[^}]*min-width:\s*44px/,
    );
    expect(desktopRules).toMatch(
      /\.metadata-combobox-popup > p\s*\{[^}]*min-height:\s*44px/,
    );
    expect(desktopRules).toMatch(
      /\.route-filter-controls\s*\{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(desktopRules).not.toContain(".route-filter-controls .map-filter");
    expect(desktopRules).toMatch(
      /@container \(max-width:\s*420px\)\s*\{[\s\S]*?\.aircraft-metadata-filter \.filter-select-grid\s*\{[^}]*grid-template-columns:\s*1fr/,
    );
    expect(desktopRules).toMatch(
      /\.route-filter-controls:has\(> \.route-custom-date-filter\)[\s\S]*?> \.aircraft-metadata-filter\s*\{[^}]*grid-column:\s*span 12/,
    );
    expect(phoneRules).toMatch(
      /\.route-filter-controls > \.flight-type-filter,[\s\S]*?grid-column:\s*span 12/,
    );
    expect(phoneRules).toMatch(
      /\.route-filter-actions\s*\{[^}]*justify-content:\s*stretch/,
    );
    expect(desktopRules).toMatch(/select\s*\{[^}]*color-scheme:\s*dark/);
    expect(desktopRules).toMatch(
      /select option\s*\{[^}]*background-color:\s*var\(--field-option\)[^}]*color:\s*var\(--ink\)/,
    );
    expect(forcedColorsRules).toMatch(
      /select,[\s\S]*?select option\s*\{[^}]*background:\s*Canvas[^}]*color:\s*CanvasText/,
    );
  });

  it("keeps the distinct records workspaces usable on desktop and phone", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const desktopRules = css.slice(0, css.indexOf("@media (max-width: 1000px)"));
    const phoneRules = css.slice(
      css.indexOf("@media (max-width: 580px)"),
      css.indexOf("@media (max-width: 360px)"),
    );

    expect(desktopRules).toMatch(
      /\.records-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(desktopRules).toMatch(
      /\.history-toolbar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(desktopRules).toMatch(
      /\.workflow-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(phoneRules).toMatch(
      /\.history-toolbar,\s*\.workflow-grid\s*\{[^}]*grid-template-columns:\s*1fr/,
    );
    expect(phoneRules).toMatch(
      /\.flight-row\s*\{[^}]*grid-template-columns:\s*35px\s+minmax\(0,\s*1fr\)/,
    );
  });

  it("provides 44px route targets and a mobile navigation replacement", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const desktopRules = css.slice(0, css.indexOf("@media (max-width: 1000px)"));
    const tabletRules = css.slice(
      css.indexOf("@media (max-width: 800px)"),
      css.indexOf("@media (max-width: 580px)"),
    );

    expect(desktopRules).toMatch(
      /\.nav-links a\s*\{[^}]*min-height:\s*44px/,
    );
    expect(desktopRules).toMatch(
      /\.brand\s*\{[^}]*min-height:\s*44px/,
    );
    expect(desktopRules).toMatch(/\.mobile-nav\s*\{[^}]*display:\s*none/);
    expect(tabletRules).toMatch(
      /\.mobile-nav\s*\{[^}]*display:\s*grid/,
    );
    expect(tabletRules).toMatch(
      /\.mobile-nav a\s*\{[^}]*min-height:\s*48px/,
    );
  });

  it("keeps all four primary mobile nav destinations on a single row", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const tabletRules = css.slice(
      css.indexOf("@media (max-width: 800px)"),
      css.indexOf("@media (max-width: 580px)"),
    );

    // Map, Flights, Import, Settings: the grid must have one column per
    // destination so the row never wraps onto a second line on phones.
    expect(tabletRules).toMatch(
      /\.mobile-nav\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
    );
    expect(tabletRules).not.toMatch(
      /\.mobile-nav\s*\{[^}]*grid-template-columns:\s*repeat\(3,/,
    );
    expect(tabletRules).toMatch(/\.mobile-nav a\s*\{[^}]*min-width:\s*0/);
  });
});

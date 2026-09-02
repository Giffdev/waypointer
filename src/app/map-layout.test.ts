import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("route split layout", () => {
  it("uses server-side auth routing without a client redirect script", () => {
    const rootPage = fs.readFileSync(path.join(process.cwd(), "src", "app", "page.tsx"), "utf8");
    const rootLayout = fs.readFileSync(path.join(process.cwd(), "src", "app", "layout.tsx"), "utf8");
    expect(rootPage).toContain('return redirect("/map")');
    expect(rootPage).toContain("<LandingPage />");
    expect(rootPage).toContain("getOptionalAuthenticatedUser");
    expect(rootPage).toContain('from "next/navigation"');
    expect(rootLayout).not.toContain("window.location.replace");
  });

  it("defines route pages and active nav affordance", () => {
    const nav = fs.readFileSync(path.join(process.cwd(), "src", "components", "app-navigation.tsx"), "utf8");
    expect(nav).toContain('/map');
    expect(nav).toContain('/flights');
    expect(nav).toContain('/import');
    expect(nav).toContain('aria-current={active ? "page" : undefined}');
  });

  it("keeps desktop map layout grid intact", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const desktopRules = css.slice(0, css.indexOf("@media (max-width: 1000px)"));
    expect(desktopRules).toMatch(/\.map-stage\s*\{[^}]*display:\s*grid/);
    // `.globe-frame` (not `.globe-shell`) carries the grid placement: it
    // wraps `.globe-shell` plus the sibling `.terrain-attribution` control,
    // so the credits box can be repositioned out of the map overlay at the
    // mobile breakpoint without moving it in the DOM.
    expect(desktopRules).toMatch(/\.globe-frame\s*\{[^}]*grid-column:\s*2/);
    expect(desktopRules).toMatch(/\.map-overlay\s*\{[^}]*grid-column:\s*1/);
  });

  it("keeps the terrain credits box as a desktop overlay but an in-flow bar below the map on mobile", () => {
    // Regression guard for the mobile "credits box eats the viewport" fix.
    // The control must stay a *single* `.terrain-attribution` node (no
    // breakpoint-specific duplicate in the a11y tree): the desktop rule
    // keeps it an absolutely positioned overlay in the map's corner, and
    // only the `@media (max-width: 800px)` rule swaps it to `position:
    // static` so the exact same DOM node instead renders in normal
    // document flow, directly below the map.
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const desktopRules = css.slice(0, css.indexOf("@media (max-width: 1000px)"));
    expect(desktopRules).toMatch(/\.terrain-attribution\s*\{[^}]*position:\s*absolute/);

    const mobileBlockStart = css.indexOf("@media (max-width: 800px)");
    const mobileBlockEnd = css.indexOf("@media (max-width: 580px)");
    expect(mobileBlockStart).toBeGreaterThan(-1);
    expect(mobileBlockEnd).toBeGreaterThan(mobileBlockStart);
    const mobileRules = css.slice(mobileBlockStart, mobileBlockEnd);
    expect(mobileRules).toMatch(/\.terrain-attribution\s*\{[^}]*position:\s*static/);

    // The wrapper's height must collapse to `auto` on mobile so the
    // now-in-flow credits bar can grow the section instead of being
    // clipped. `.globe-shell` keeps the same explicit mobile height
    // *formula* it always had, minus a fixed offset sized to the in-flow
    // credits bar's own footprint (closed <details> row + its top
    // margin), so the map + credits together occupy the same total
    // height the map alone used to. That keeps the control panel and
    // filters from being pushed further down the page than before (see
    // the "exposes filters in the first viewport" e2e assertion in
    // e2e/flight-filters.spec.ts, which regressed without this offset).
    expect(mobileRules).toMatch(/\.globe-frame\s*\{[^}]*height:\s*auto/);
    expect(mobileRules).toMatch(
      /\.globe-shell\s*\{[^}]*height:\s*calc\(min\(68svh,\s*620px\)\s*-\s*40px\)/,
    );

    const narrowBlockStart = css.indexOf("@media (max-width: 580px)");
    expect(narrowBlockStart).toBeGreaterThan(-1);
    const narrowRules = css.slice(narrowBlockStart);
    expect(narrowRules).toMatch(/\.globe-shell\s*\{[^}]*height:\s*calc\(50svh\s*-\s*40px\)/);
  });

  it("keeps the flown-airport legend token decoupled from the unrelated private-route literal", () => {
    // Regression guard: .legend-airport and .legend-route.private used to
    // coincidentally share the literal #f0c56b. Fixing the airport color
    // must never retint the private-route legend swatch, and the two rules
    // must not be re-coupled behind a single shared selector or token.
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const mapStyle = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "map-style.ts"),
      "utf8",
    );

    const rootMatch = css.match(/:root\s*\{[^}]*--airport-marker-active:\s*(#[0-9a-fA-F]+)/);
    expect(rootMatch).not.toBeNull();
    const cssToken = rootMatch![1].toLowerCase();

    const activeColorMatch = mapStyle.match(/active:\s*"(#[0-9a-fA-F]+)"/);
    expect(activeColorMatch).not.toBeNull();
    expect(cssToken).toBe(activeColorMatch![1].toLowerCase());

    const legendAirportMatch = css.match(/\.legend-airport\s*\{[^}]*\}/);
    expect(legendAirportMatch).not.toBeNull();
    expect(legendAirportMatch![0]).toMatch(/background:\s*var\(--airport-marker-active\)/);
    expect(legendAirportMatch![0]).not.toContain("#f0c56b");

    const legendRoutePrivateMatch = css.match(/\.legend-route\.private\s*\{[^}]*\}/);
    expect(legendRoutePrivateMatch).not.toBeNull();
    expect(legendRoutePrivateMatch![0]).toContain("#f0c56b");
    expect(legendRoutePrivateMatch![0]).not.toContain("--airport-marker-active");
  });

  it("preserves the shared page's globe height and legend nesting inside the canvas section", () => {
    // The mobile reorder must move .shared-map-canvas as a whole unit; its
    // globe sizing and the legend nested inside it must stay untouched.
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    expect(css).toMatch(
      /\.shared-map-canvas \.globe-shell\s*\{[^}]*height:\s*min\(70svh,\s*760px\)/,
    );
    expect(css).toMatch(/\.shared-map-canvas \.map-legend\s*\{[^}]*margin-top:\s*12px/);
  });
});

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
    expect(desktopRules).toMatch(/\.globe-shell\s*\{[^}]*grid-column:\s*2/);
    expect(desktopRules).toMatch(/\.map-overlay\s*\{[^}]*grid-column:\s*1/);
  });

  it("reorders the mobile map above the filters, below the Flat/3D toggle, via CSS order (not DOM changes)", () => {
    // The map and filters are visual siblings once .map-overlay is flattened
    // with display: contents; `order` alone drives the mobile stacking so
    // GlobePanel's DOM position (and its WebGL context) never changes.
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const mobileBlockStart = css.indexOf("@media (max-width: 800px)");
    const mobileBlockEnd = css.indexOf("@media (max-width: 580px)");
    expect(mobileBlockStart).toBeGreaterThan(-1);
    expect(mobileBlockEnd).toBeGreaterThan(mobileBlockStart);
    const mobileRules = css.slice(mobileBlockStart, mobileBlockEnd);

    expect(mobileRules).toMatch(/\.map-stage\s*\{[^}]*display:\s*flex/);
    expect(mobileRules).toMatch(/\.map-overlay\s*\{\s*display:\s*contents;\s*\}/);
    expect(mobileRules).toMatch(/\.map-control-panel-top\s*\{[^}]*order:\s*1\b/);
    expect(mobileRules).toMatch(/\.globe-shell\s*\{[^}]*order:\s*2\b/);
    expect(mobileRules).toMatch(/\.map-control-panel-bottom\s*\{[^}]*order:\s*3\b/);
    expect(mobileRules).toMatch(/\.map-legend\s*\{[^}]*order:\s*4\b/);

    // Order values must place the map strictly between the two control-panel
    // halves (the Flat/3D toggle lives in -top, the filters live in -bottom).
    const orderOf = (selector: string) => {
      const match = mobileRules.match(
        new RegExp(`\\.${selector}\\s*\\{[^}]*order:\\s*(\\d+)`),
      );
      expect(match).not.toBeNull();
      return Number(match![1]);
    };
    expect(orderOf("map-control-panel-top")).toBeLessThan(orderOf("globe-shell"));
    expect(orderOf("globe-shell")).toBeLessThan(orderOf("map-control-panel-bottom"));
  });

  it("mirrors the mobile map-first order on the shared map page at the same breakpoint", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const blockStart = css.indexOf("@media (max-width: 800px) {\n  .shared-map-page");
    expect(blockStart).toBeGreaterThan(-1);
    const blockEnd = css.indexOf("@media", blockStart + 1);
    const sharedMobileRules = css.slice(blockStart, blockEnd);

    expect(sharedMobileRules).toMatch(/\.shared-map-page\s*\{[^}]*display:\s*flex/);
    const orderOf = (selector: string) => {
      const match = sharedMobileRules.match(
        new RegExp(`\\.${selector}\\s*\\{[^}]*order:\\s*(\\d+)`),
      );
      expect(match).not.toBeNull();
      return Number(match![1]);
    };
    expect(orderOf("shared-map-header")).toBeLessThan(orderOf("shared-map-canvas"));
    expect(orderOf("shared-map-canvas")).toBeLessThan(orderOf("shared-map-controls"));
    expect(orderOf("shared-map-controls")).toBeLessThan(orderOf("shared-map-statistics"));
  });

  it("splits the private page's control panel so the Flat/3D toggle and filters land in the correct mobile-order halves", () => {
    // Structural (not pixel) check on the JSX itself: the CSS `order` rules
    // above only work if map-view-control (Flat/3D) stays in the "-top" half
    // and flight-filter-panel stays in the "-bottom" half, in that document
    // order, so GlobePanel's mobile position (order: 2) lands between them.
    const tsx = fs.readFileSync(
      path.join(process.cwd(), "src", "app", "(routes)", "map", "route-client.tsx"),
      "utf8",
    );
    const topIndex = tsx.indexOf("map-control-panel-top");
    const toggleIndex = tsx.indexOf("map-view-control");
    const bottomIndex = tsx.indexOf("map-control-panel-bottom");
    const filterIndex = tsx.indexOf("flight-filter-panel");
    const legendIndex = tsx.indexOf("<MapLegend");

    expect(topIndex).toBeGreaterThan(-1);
    expect(bottomIndex).toBeGreaterThan(-1);
    expect(topIndex).toBeLessThan(toggleIndex);
    expect(toggleIndex).toBeLessThan(bottomIndex);
    expect(bottomIndex).toBeLessThan(filterIndex);
    expect(filterIndex).toBeLessThan(legendIndex);
  });
});

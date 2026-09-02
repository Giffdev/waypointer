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

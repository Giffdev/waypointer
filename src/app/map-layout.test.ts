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
});

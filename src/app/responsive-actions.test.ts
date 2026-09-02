import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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

    expect(desktopRules).toMatch(
      /\.icon-controls button\s*\{[^}]*height:\s*44px[^}]*min-width:\s*44px/,
    );
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

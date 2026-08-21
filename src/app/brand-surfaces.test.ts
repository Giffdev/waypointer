import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const primarySurfaceFiles = [
  "src/app/layout.tsx",
  "src/app/(routes)/layout.tsx",
  "src/app/auth/register/page.tsx",
  "src/app/auth/sign-in/page.tsx",
  "src/app/auth/sign-out/page.tsx",
  "src/app/auth/firebase/callback/page.tsx",
  "src/components/app-navigation.tsx",
  "src/components/auth/auth-shell.tsx",
  "src/components/landing/landing-page.tsx",
  "src/lib/auth/email.ts",
  "src/app/api/shared/[handle]/route.ts",
  "README.md",
] as const;

describe("Waypointer public brand", () => {
  it("uses Waypointer without the retired product name on primary user surfaces", () => {
    for (const file of primarySurfaceFiles) {
      const source = fs.readFileSync(path.join(root, file), "utf8");
      expect(source, file).toContain("Waypointer");
      expect(source, file).not.toContain("Flight Map");
    }
  });

  it("keeps internal package, route, API, and environment identifiers stable", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { name: string };
    const rootPage = fs.readFileSync(path.join(root, "src/app/page.tsx"), "utf8");
    const guards = fs.readFileSync(
      path.join(root, "src/lib/auth/guards.ts"),
      "utf8",
    );
    const sharedRoute = fs.readFileSync(
      path.join(root, "src/app/api/shared/[handle]/route.ts"),
      "utf8",
    );

    expect(packageJson.name).toBe("flight-map");
    expect(rootPage).toContain('redirect("/map")');
    expect(guards).toContain("FLIGHT_MAP_DEV_PREVIEW");
    expect(sharedRoute).toContain('"shared-map-unavailable"');
  });
});

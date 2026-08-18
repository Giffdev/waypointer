import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  signIn: vi.fn(),
}));

import { OAuthSignInButtons } from "./oauth-buttons";

describe("OAuth sign-in buttons", () => {
  it("renders no alternative UI when providers are absent", () => {
    expect(renderToStaticMarkup(<OAuthSignInButtons providerIds={[]} />)).toBe(
      "",
    );
  });

  it("renders only configured provider actions", () => {
    const markup = renderToStaticMarkup(
      <OAuthSignInButtons providerIds={["google", "microsoft-entra-id"]} />,
    );
    expect(markup).toContain("Continue with Google");
    expect(markup).toContain("Continue with Microsoft");
  });
});

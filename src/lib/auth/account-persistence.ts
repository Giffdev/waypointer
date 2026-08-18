import type { AdapterAccount } from "@auth/core/adapters";

export function withoutOAuthBearerTokens(
  account: AdapterAccount,
): AdapterAccount {
  return {
    ...account,
    access_token: undefined,
    refresh_token: undefined,
    id_token: undefined,
  };
}

export const CANONICAL_PRODUCTION_ORIGIN =
  "https://waypointer-app.vercel.app";

type ProductionGoogleReauthEnvironment = Readonly<{
  FLIGHT_MAP_E2E_GOOGLE_REAUTH?: string;
  FLIGHT_MAP_E2E_BASE_URL?: string;
  FLIGHT_MAP_E2E_GOOGLE_STORAGE_STATE?: string;
  FLIGHT_MAP_E2E_GOOGLE_EMAIL?: string;
  FLIGHT_MAP_E2E_GOOGLE_REAUTH_MAX_MS?: string;
}>;

export function isProductionGoogleReauthRequested(
  env: ProductionGoogleReauthEnvironment,
): boolean {
  const value = env.FLIGHT_MAP_E2E_GOOGLE_REAUTH;
  return value !== undefined && value !== "false";
}

export function requireProductionGoogleReauthConfig(
  env: ProductionGoogleReauthEnvironment,
) {
  if (env.FLIGHT_MAP_E2E_GOOGLE_REAUTH !== "true") {
    throw new Error(
      "FLIGHT_MAP_E2E_GOOGLE_REAUTH must be exactly true or false.",
    );
  }

  const missingVariables = [
    ["FLIGHT_MAP_E2E_BASE_URL", env.FLIGHT_MAP_E2E_BASE_URL],
    [
      "FLIGHT_MAP_E2E_GOOGLE_STORAGE_STATE",
      env.FLIGHT_MAP_E2E_GOOGLE_STORAGE_STATE,
    ],
    ["FLIGHT_MAP_E2E_GOOGLE_EMAIL", env.FLIGHT_MAP_E2E_GOOGLE_EMAIL],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingVariables.length > 0) {
    throw new Error(
      `Production Google reauthentication requires ${missingVariables.join(", ")}.`,
    );
  }
  if (env.FLIGHT_MAP_E2E_BASE_URL !== CANONICAL_PRODUCTION_ORIGIN) {
    throw new Error(
      `Production Google reauthentication must target ${CANONICAL_PRODUCTION_ORIGIN}.`,
    );
  }

  const maxMs = Number(env.FLIGHT_MAP_E2E_GOOGLE_REAUTH_MAX_MS ?? "15000");
  if (!Number.isFinite(maxMs) || maxMs <= 0) {
    throw new Error(
      "FLIGHT_MAP_E2E_GOOGLE_REAUTH_MAX_MS must be a positive number.",
    );
  }

  return {
    email: env.FLIGHT_MAP_E2E_GOOGLE_EMAIL!,
    maxMs,
  };
}

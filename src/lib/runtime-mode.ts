export type FlightMapRuntimeMode =
  | { kind: "local-full"; label: string; detail: string }
  | { kind: "durable-production"; label: string; detail: string }
  | { kind: "mvp-production"; label: string; detail: string }
  | { kind: "hosted-preview"; label: string; detail: string }
  | { kind: "preview"; label: string; detail: string }
  | { kind: "configured"; label: string; detail: string }
  | { kind: "unavailable"; label: string; detail: string };

export type ImportRuntimeCapability = {
  available: boolean;
  durable: boolean;
  maxFileBytes: number;
  unavailableReason?: string;
};

const DEFAULT_MAX_IMPORT_BYTES = 10 * 1024 * 1024;

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function isRemoteHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !isLoopbackUrl(value);
  } catch {
    return false;
  }
}

export function isLoopbackLocalConfiguration(): boolean {
  return (
    process.env.FLIGHT_MAP_LOCAL_FULL === "true" &&
    isLoopbackUrl(process.env.AUTH_URL) &&
    isLoopbackUrl(process.env.DATABASE_URL) &&
    process.env.IMPORT_STORAGE_BACKEND === "local" &&
    process.env.FLIGHT_MAP_DEV_PREVIEW !== "true"
  );
}

export function canExposeDevelopmentVerificationLink(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    isLoopbackLocalConfiguration() &&
    process.env.AUTH_DEV_EXPOSE_VERIFICATION_LINK === "true"
  );
}

export function isHostedPreviewConfiguration(): boolean {
  const maxBytes = Number(process.env.IMPORT_MAX_BYTES);
  const authUrl = process.env.AUTH_URL?.trim();
  return (
    process.env.NODE_ENV === "production" &&
    process.env.FLIGHT_MAP_HOSTED_PREVIEW === "true" &&
    Boolean(process.env.DATABASE_URL?.trim()) &&
    Boolean(process.env.AUTH_SECRET?.trim()) &&
    isRemoteHttpsUrl(authUrl) &&
    process.env.IMPORT_STORAGE_BACKEND === "sync-preview" &&
    Number.isSafeInteger(maxBytes) &&
    maxBytes >= 1024 &&
    maxBytes <= 1024 * 1024
  );
}

export function isMvpProductionConfiguration(): boolean {
  const maxBytes = Number(process.env.IMPORT_MAX_BYTES);
  const authUrl = process.env.AUTH_URL?.trim();
  const proxyDomain =
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN?.trim();
  let authHostname = "";
  try {
    authHostname = authUrl ? new URL(authUrl).hostname : "";
  } catch {
    return false;
  }
  return (
    process.env.NODE_ENV === "production" &&
    process.env.FLIGHT_MAP_MVP_SYNC_IMPORTS === "true" &&
    Boolean(process.env.DATABASE_URL?.trim()) &&
    process.env.DB_POOL_MAX === "1" &&
    Boolean(process.env.AUTH_SECRET?.trim()) &&
    isRemoteHttpsUrl(authUrl) &&
    Boolean(proxyDomain) &&
    authHostname === proxyDomain &&
    Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim()) &&
    Boolean(process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim()) &&
    Boolean(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim()) &&
    Boolean(process.env.NEXT_PUBLIC_FIREBASE_APP_ID?.trim()) &&
    process.env.IMPORT_STORAGE_BACKEND === "sync-mvp" &&
    Number.isSafeInteger(maxBytes) &&
    maxBytes >= 1024 &&
    maxBytes <= 1024 * 1024
  );
}

export function isBoundedMvpSyncImportConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const maxBytes = Number(environment.IMPORT_MAX_BYTES);
  return (
    environment.NODE_ENV === "production" &&
    environment.FLIGHT_MAP_MVP_SYNC_IMPORTS === "true" &&
    environment.IMPORT_STORAGE_BACKEND === "sync-mvp" &&
    Boolean(environment.DATABASE_URL?.trim()) &&
    Boolean(environment.AUTH_SECRET?.trim()) &&
    Number.isSafeInteger(maxBytes) &&
    maxBytes >= 1024 &&
    maxBytes <= 1024 * 1024
  );
}

export function isDurableImportConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const maxBytes = Number(environment.IMPORT_MAX_BYTES);
  return (
    environment.FLIGHT_MAP_DURABLE_IMPORTS === "true" &&
    environment.FLIGHT_MAP_MVP_SYNC_IMPORTS !== "true" &&
    environment.IMPORT_STORAGE_BACKEND === "r2" &&
    Boolean(environment.OBJECT_STORAGE_ENDPOINT?.trim()) &&
    Boolean(environment.OBJECT_STORAGE_REGION?.trim()) &&
    Boolean(environment.OBJECT_STORAGE_BUCKET?.trim()) &&
    Boolean(environment.OBJECT_STORAGE_ACCESS_KEY_ID?.trim()) &&
    Boolean(environment.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim()) &&
    Number.isSafeInteger(maxBytes) &&
    maxBytes >= 1024 &&
    maxBytes <= 10 * 1024 * 1024
  );
}

export function getFlightMapRuntimeMode(): FlightMapRuntimeMode {
  if (
    process.env.NODE_ENV !== "production" &&
    isLoopbackLocalConfiguration()
  ) {
    return {
      kind: "local-full",
      label: "Full local workspace",
      detail: "Local PostgreSQL, private filesystem uploads, and development email verification are active.",
    };
  }

  if (
    process.env.NODE_ENV === "production" &&
    isDurableImportConfiguration()
  ) {
    return {
      kind: "durable-production",
      label: "Durable production",
      detail: "Verified accounts upload directly to private storage for isolated malware scanning and durable processing.",
    };
  }

  if (isMvpProductionConfiguration()) {
    return {
      kind: "mvp-production",
      label: "MVP production",
      detail: "Verified accounts use bounded synchronous imports. Original CSV files are not retained.",
    };
  }
  if (isHostedPreviewConfiguration()) {
    return {
      kind: "hosted-preview",
      label: "Hosted preview",
      detail: "Verified accounts use synchronous private imports. Original files are not retained.",
    };
  }
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.FLIGHT_MAP_DEV_PREVIEW === "true"
  ) {
    return {
      kind: "preview",
      label: "Preview only",
      detail: "CSV parsing stays in this browser; accounts, uploads, and commits are unavailable.",
    };
  }
  if (
    process.env.DATABASE_URL &&
    process.env.AUTH_SECRET &&
    process.env.IMPORT_STORAGE_BACKEND === "s3"
  ) {
    return {
      kind: "configured",
      label: "Private persisted workspace",
      detail: "Authenticated database-backed imports are active.",
    };
  }
  return {
    kind: "unavailable",
    label: "Persistence unavailable",
    detail: "Run npm run dev:full locally or configure production database, auth, and storage services.",
  };
}

export function getImportRuntimeCapability(): ImportRuntimeCapability {
  const mode = getFlightMapRuntimeMode();
  const boundedMvpSyncAvailable = isBoundedMvpSyncImportConfiguration();
  const configuredMax = Number(
    process.env.IMPORT_MAX_BYTES ?? DEFAULT_MAX_IMPORT_BYTES,
  );
  const maxFileBytes =
    Number.isSafeInteger(configuredMax) &&
    configuredMax >= 1024 &&
    configuredMax <= DEFAULT_MAX_IMPORT_BYTES
      ? configuredMax
      : DEFAULT_MAX_IMPORT_BYTES;
  const available =
    boundedMvpSyncAvailable ||
    [
      "local-full",
      "durable-production",
      "mvp-production",
      "hosted-preview",
      "configured",
    ].includes(mode.kind);

  return {
    available,
    durable: mode.kind === "durable-production",
    maxFileBytes,
    unavailableReason: available ? undefined : mode.detail,
  };
}

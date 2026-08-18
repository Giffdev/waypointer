export type FirebasePublicConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
};

export function firebasePublicConfig(
  environment: NodeJS.ProcessEnv = process.env,
): FirebasePublicConfig | null {
  const config = {
    apiKey: environment.NEXT_PUBLIC_FIREBASE_API_KEY?.trim() ?? "",
    authDomain:
      environment.NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN?.trim() ||
      environment.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim() ||
      "",
    projectId: environment.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim() ?? "",
    appId: environment.NEXT_PUBLIC_FIREBASE_APP_ID?.trim() ?? "",
  };
  return Object.values(config).every(Boolean) ? config : null;
}

export function firebaseAuthProxyRewrite(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const proxyDomain =
    environment.NEXT_PUBLIC_FIREBASE_AUTH_PROXY_DOMAIN?.trim();
  const upstreamDomain =
    environment.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN?.trim();
  if (!proxyDomain || !upstreamDomain) return null;
  return {
    source: "/__/auth/:path*",
    destination: `https://${upstreamDomain}/__/auth/:path*`,
  };
}

export function firebaseOAuthDeploymentUrls(host: string) {
  const normalized = host.trim().toLowerCase();
  if (
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized) ||
    normalized.includes("..")
  ) {
    throw new Error("Firebase OAuth host must be a hostname without a path.");
  }
  const origin = `https://${normalized}`;
  return {
    authorizedJavaScriptOrigin: origin,
    authorizedRedirectUri: `${origin}/__/auth/handler`,
  };
}

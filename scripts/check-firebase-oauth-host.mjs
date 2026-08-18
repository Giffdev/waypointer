import { readFileSync } from "node:fs";

const host = process.argv[2]?.trim().toLowerCase();
if (!host || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) {
  console.error("Usage: node scripts/check-firebase-oauth-host.mjs <hostname>");
  process.exit(1);
}

const manifest = JSON.parse(
  readFileSync(
    new URL("../config/firebase-oauth-hosts.json", import.meta.url),
    "utf8",
  ),
);
const expected = {
  authorizedJavaScriptOrigin: `https://${host}`,
  authorizedRedirectUri: `https://${host}/__/auth/handler`,
};
const configured = manifest[host];

if (
  !configured ||
  configured.authorizedJavaScriptOrigin !==
    expected.authorizedJavaScriptOrigin ||
  configured.authorizedRedirectUri !== expected.authorizedRedirectUri
) {
  console.error(`Firebase Google OAuth is not recorded for ${host}.`);
  console.error(
    `Required JavaScript origin: ${expected.authorizedJavaScriptOrigin}`,
  );
  console.error(
    `Required redirect URI: ${expected.authorizedRedirectUri}`,
  );
  console.error(
    "Configure both on the Firebase-managed Google web client, then record the exact values in config/firebase-oauth-hosts.json.",
  );
  process.exit(1);
}

console.log(
  `Firebase OAuth host recorded: ${expected.authorizedRedirectUri}`,
);


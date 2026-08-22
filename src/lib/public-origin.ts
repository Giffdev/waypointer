export const CANONICAL_PUBLIC_ORIGIN =
  "https://waypointer-app.vercel.app";

export function canonicalPublicUrl(pathname: string): string {
  return new URL(pathname, `${CANONICAL_PUBLIC_ORIGIN}/`).href;
}

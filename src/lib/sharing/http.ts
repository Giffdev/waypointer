export const SHARING_CACHE_CONTROL =
  "no-store, max-age=0, s-maxage=0, must-revalidate";

export const SHARING_NO_STORE_HEADERS = {
  "Cache-Control": SHARING_CACHE_CONTROL,
} as const;

export function withSharingNoStore<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", SHARING_CACHE_CONTROL);
  return response;
}

export function requestIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const expected = new URL(request.url).origin;
  if (!origin || origin !== expected) {
    throw new RequestOriginError();
  }
}
export class RequestOriginError extends Error {
  constructor() {
    super("The request origin is not allowed.");
    this.name = "RequestOriginError";
  }
}

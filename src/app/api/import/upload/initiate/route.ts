import { requireImportUser } from "@/lib/auth/guards";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { assertSameOrigin } from "@/lib/auth/request";
import { initiateDurableImport } from "@/lib/import/durable-service";
import { importApiError } from "../../_lib/response";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await requireImportUser();
    assertSameOrigin(request);
    await consumeRateLimit("import-upload-user", user.id, 5, 60 * 60_000);
    const body = (await request.json()) as {
      fileName?: unknown;
      contentType?: unknown;
      sizeBytes?: unknown;
      idempotencyKey?: unknown;
    };
    const result = await initiateDurableImport(user.id, {
      fileName: typeof body.fileName === "string" ? body.fileName : "",
      contentType:
        typeof body.contentType === "string" ? body.contentType : "",
      sizeBytes: Number(body.sizeBytes),
      idempotencyKey:
        typeof body.idempotencyKey === "string"
          ? body.idempotencyKey
          : undefined,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return importApiError(error);
  }
}

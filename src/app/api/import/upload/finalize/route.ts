import { requireImportUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import { finalizeDurableImport } from "@/lib/import/durable-service";
import { importApiError } from "../../_lib/response";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await requireImportUser();
    assertSameOrigin(request);
    const body = (await request.json()) as {
      batchId?: unknown;
      mapping?: unknown;
    };
    const batchId = typeof body.batchId === "string" ? body.batchId : "";
    const result =
      body.mapping === undefined
        ? await finalizeDurableImport(user.id, batchId)
        : await finalizeDurableImport(user.id, batchId, body.mapping);
    return Response.json(result, { status: result.reused ? 200 : 202 });
  } catch (error) {
    return importApiError(error);
  }
}

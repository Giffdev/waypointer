import { requireImportUser } from "@/lib/auth/guards";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { assertSameOrigin } from "@/lib/auth/request";
import { reprocessDurableImport } from "@/lib/import/durable-service";
import { importApiError } from "../../../_lib/response";

export const runtime = "nodejs";

/**
 * Restage a retained upload under the current importer.
 *
 * Rate limited like an upload, because that is what it costs: it copies the
 * private original and queues a full scan-and-parse. Without a limit, one
 * held-down button multiplies a user's stored logbook copies and their
 * background work.
 *
 * `200` when the reprocess already existed, `202` when this call created it,
 * so a client can tell "queued again" from "queued now" without guessing.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  try {
    const user = await requireImportUser();
    assertSameOrigin(request);
    await consumeRateLimit("import-reprocess-user", user.id, 5, 60 * 60_000);
    const { batchId } = await params;
    const result = await reprocessDurableImport(user.id, batchId);
    return Response.json(result, { status: result.reused ? 200 : 202 });
  } catch (error) {
    return importApiError(error);
  }
}

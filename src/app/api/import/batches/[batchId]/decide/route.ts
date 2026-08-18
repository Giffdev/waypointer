import { requireImportUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import { importApiError } from "../../../_lib/response";
import { revalidateOwnerFlightViews } from "../../../_lib/revalidate";
import {
  importService,
  ImportServiceError,
  type ImportDecision,
} from "../../../_lib/service";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  try {
    const user = await requireImportUser();
    assertSameOrigin(request);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 256 * 1024) {
      throw new ImportServiceError(
        413,
        "request-too-large",
        "The decision request is too large.",
      );
    }
    const body = (await request.json()) as { decisions?: ImportDecision[] };
    if (!Array.isArray(body.decisions)) {
      throw new ImportServiceError(
        400,
        "invalid-decisions",
        "A decisions array is required.",
      );
    }
    const { batchId } = await params;
    const result = await importService.decide(user.id, batchId, body.decisions);
    if ((result.counts.importedRows ?? 0) > 0) {
      revalidateOwnerFlightViews();
    }
    return Response.json(result);
  } catch (error) {
    return importApiError(error);
  }
}

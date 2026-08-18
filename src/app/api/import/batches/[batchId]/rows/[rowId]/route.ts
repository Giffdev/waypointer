import { requireImportUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import type { UpdateImportRowRequest } from "@/lib/import/types";
import { importApiError } from "../../../../_lib/response";
import { revalidateOwnerFlightViews } from "../../../../_lib/revalidate";
import {
  importService,
  ImportServiceError,
} from "../../../../_lib/service";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  {
    params,
  }: { params: Promise<{ batchId: string; rowId: string }> },
) {
  try {
    const user = await requireImportUser();
    assertSameOrigin(request);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 32 * 1024) {
      throw new ImportServiceError(
        413,
        "request-too-large",
        "The correction request is too large.",
      );
    }
    const body = (await request.json()) as Partial<UpdateImportRowRequest>;
    if (!body.proposal || typeof body.proposal !== "object") {
      throw new ImportServiceError(
        400,
        "invalid-row-correction",
        "A proposal correction object is required.",
      );
    }
    const { batchId, rowId } = await params;
    const result = await importService.updateRow(user.id, batchId, rowId, {
      expectedUpdatedAt: body.expectedUpdatedAt,
      proposal: body.proposal,
    });
    if ((result.counts.importedRows ?? 0) > 0) {
      revalidateOwnerFlightViews();
    }
    return Response.json(result);
  } catch (error) {
    return importApiError(error);
  }
}

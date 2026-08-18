import { requireImportUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import { importApiError } from "../../../_lib/response";
import { revalidateOwnerFlightViews } from "../../../_lib/revalidate";
import { importService } from "../../../_lib/service";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  try {
    const user = await requireImportUser();
    assertSameOrigin(request);
    const { batchId } = await params;
    const result = await importService.commit(user.id, batchId);
    if ((result.completion?.importedRows ?? 0) > 0) {
      revalidateOwnerFlightViews();
    }
    return Response.json(result);
  } catch (error) {
    return importApiError(error);
  }
}

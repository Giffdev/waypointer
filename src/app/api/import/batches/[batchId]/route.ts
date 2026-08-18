import { requireImportUser } from "@/lib/auth/guards";
import { importApiError } from "../../_lib/response";
import { importService, ImportServiceError } from "../../_lib/service";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  try {
    const user = await requireImportUser();
    const { batchId } = await params;
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const pageSize = Math.min(
      100,
      Math.max(1, Number(url.searchParams.get("pageSize") ?? 50)),
    );
    if (!Number.isSafeInteger(page) || !Number.isSafeInteger(pageSize)) {
      throw new ImportServiceError(
        400,
        "invalid-pagination",
        "Pagination values must be integers.",
      );
    }
    const batch = await importService.getBatch(
      user.id,
      batchId,
      page,
      pageSize,
    );
    if (!batch) {
      throw new ImportServiceError(404, "batch-not-found", "Batch not found.");
    }
    return Response.json({ batch });
  } catch (error) {
    return importApiError(error);
  }
}

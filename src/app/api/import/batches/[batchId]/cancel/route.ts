import { requireImportUser } from "@/lib/auth/guards";
import { assertSameOrigin } from "@/lib/auth/request";
import { cancelDurableImport } from "@/lib/import/durable-service";
import { importApiError } from "../../../_lib/response";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ batchId: string }> },
) {
  try {
    const user = await requireImportUser();
    assertSameOrigin(request);
    const { batchId } = await params;
    await cancelDurableImport(user.id, batchId);
    return Response.json({ ok: true }, { status: 202 });
  } catch (error) {
    return importApiError(error);
  }
}

import { requireImportUser } from "@/lib/auth/guards";
import { importApiError } from "../_lib/response";
import { importService } from "../_lib/service";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireImportUser();
    return Response.json({ batches: await importService.listBatches(user.id) });
  } catch (error) {
    return importApiError(error);
  }
}

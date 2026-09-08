import { requireImportUser } from "@/lib/auth/guards";
import { importApiError } from "../_lib/response";
import { importService } from "../_lib/service";

export const runtime = "nodejs";

/**
 * The one batch the import screen may still need to hand back to its owner,
 * or `null`. This replaced an unbounded `GET /api/import/batches`: rendering
 * the resume banner never needs the account's import history, and reading it
 * made opening /import cost one row summary per batch ever imported.
 */
export async function GET() {
  try {
    const user = await requireImportUser();
    return Response.json({
      batch: await importService.findLatestActionableBatch(user.id),
    });
  } catch (error) {
    return importApiError(error);
  }
}

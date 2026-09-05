import { requireImportUser } from "@/lib/auth/guards";
import { importApiError } from "../_lib/response";
import { importService } from "../_lib/service";

export const runtime = "nodejs";

/**
 * One counts endpoint for every surface that shows an import badge.
 *
 * It exists so unresolved import work stays visible instead of being disposed
 * of quietly: the map, the flights list, and the import page all read the same
 * numbers, so none of them can imply "nothing to do" while rows still need a
 * decision.
 */
export async function GET() {
  try {
    const user = await requireImportUser();
    return Response.json(
      await importService.getPendingImportAttention(user.id),
    );
  } catch (error) {
    return importApiError(error);
  }
}

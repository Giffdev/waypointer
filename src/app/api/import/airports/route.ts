import { requireImportUser } from "@/lib/auth/guards";
import { importApiError } from "../_lib/response";
import { importService } from "../_lib/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireImportUser();
    const url = new URL(request.url);
    const query = url.searchParams.get("query") ?? "";
    const limit = Number(url.searchParams.get("limit") ?? 10);
    return Response.json({
      airports: await importService.searchAirports(user.id, query, limit),
    });
  } catch (error) {
    return importApiError(error);
  }
}

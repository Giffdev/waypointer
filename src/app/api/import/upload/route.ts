import { requireImportUser } from "@/lib/auth/guards";
import { consumeRateLimit } from "@/lib/auth/rate-limit";
import { assertSameOrigin } from "@/lib/auth/request";
import { importApiError } from "../_lib/response";
import { revalidateOwnerFlightViews } from "../_lib/revalidate";
import { importService, ImportServiceError } from "../_lib/service";
import { parseGenericCsvMapping } from "@/lib/import/generic-mapping";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const user = await requireImportUser();
    assertSameOrigin(request);
    await consumeRateLimit("import-upload-user", user.id, 5, 60 * 60_000);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    const configuredMax = Number(
      process.env.IMPORT_MAX_BYTES ?? 10 * 1024 * 1024,
    );
    if (contentLength > configuredMax + 128 * 1024) {
      throw new ImportServiceError(
        413,
        "file-too-large",
        "The upload is too large.",
      );
    }
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ImportServiceError(
        400,
        "missing-file",
        "A single file field is required.",
      );
    }
    const mappingValue = form.get("mapping");
    let mapping;
    if (mappingValue !== null) {
      if (typeof mappingValue !== "string" || mappingValue.length > 8 * 1024) {
        throw new ImportServiceError(
          400,
          "invalid-mapping",
          "The CSV column mapping is invalid.",
        );
      }
      try {
        mapping = parseGenericCsvMapping(JSON.parse(mappingValue));
      } catch {
        throw new ImportServiceError(
          400,
          "invalid-mapping",
          "The CSV column mapping is invalid.",
        );
      }
    }
    const result = await importService.createUpload(user.id, file, mapping);
    if ((result.completion?.importedRows ?? 0) > 0) {
      revalidateOwnerFlightViews();
    }
    return Response.json(result, {
      status: result.status === "processing" ? 202 : 200,
    });
  } catch (error) {
    return importApiError(error);
  }
}

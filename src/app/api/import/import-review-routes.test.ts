import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireImportUser: vi.fn(),
  revalidateOwnerFlightViews: vi.fn(),
  assertSameOrigin: vi.fn(),
  searchAirports: vi.fn(),
  updateRow: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({
  requireImportUser: mocks.requireImportUser,
  AuthenticationRequiredError: class AuthenticationRequiredError extends Error {},
}));
vi.mock("@/lib/auth/request", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestOriginError: class RequestOriginError extends Error {},
}));
vi.mock("./_lib/service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./_lib/service")>();
  return {
    ...actual,
    importService: {
      searchAirports: mocks.searchAirports,
      updateRow: mocks.updateRow,
    },
  };
});
vi.mock("./_lib/revalidate", () => ({
  revalidateOwnerFlightViews: mocks.revalidateOwnerFlightViews,
}));

import { GET as searchAirports } from "./airports/route";
import { PATCH as updateRow } from "./batches/[batchId]/rows/[rowId]/route";

describe("import review routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireImportUser.mockResolvedValue({ id: "user-a" });
    mocks.searchAirports.mockResolvedValue([]);
    mocks.updateRow.mockResolvedValue({
      id: "batch-a",
      counts: { importedRows: 0 },
    });
  });

  it("derives airport search ownership from the authenticated session", async () => {
    const response = await searchAirports(
      new Request(
        "http://localhost/api/import/airports?query=Seattle&limit=8",
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.searchAirports).toHaveBeenCalledWith(
      "user-a",
      "Seattle",
      8,
    );
  });

  it("does not accept a client-supplied owner for staged corrections", async () => {
    const response = await updateRow(
      new Request(
        "http://localhost/api/import/batches/batch-a/rows/row-a",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost",
          },
          body: JSON.stringify({
            userId: "user-b",
            proposal: { originAirportId: "airport-a" },
          }),
        },
      ),
      { params: Promise.resolve({ batchId: "batch-a", rowId: "row-a" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.assertSameOrigin).toHaveBeenCalled();
    expect(mocks.updateRow).toHaveBeenCalledWith(
      "user-a",
      "batch-a",
      "row-a",
      {
        expectedUpdatedAt: undefined,
        proposal: { originAirportId: "airport-a" },
      },
    );
  });

  it("reports an out-of-range route stop as 422, not 503", async () => {
    // An out-of-range index is a statement about *this request's data*. The
    // catch-all previously mapped the bare Error to 503, which tells the
    // client to retry a request that will never succeed and buries the defect
    // behind a retry loop.
    const { ImportInvariantError } = await import("@/lib/import/errors");
    mocks.updateRow.mockRejectedValue(
      new ImportInvariantError(
        "route-stop-invalid",
        "Route stop index is out of range",
      ),
    );

    const response = await updateRow(
      new Request("http://localhost/api/import/batches/batch-a/rows/row-a", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
        },
        body: JSON.stringify({
          proposal: { routeStop: { index: 9, airportId: "airport-a" } },
        }),
      }),
      { params: Promise.resolve({ batchId: "batch-a", rowId: "row-a" }) },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "route-stop-invalid",
        message: "Route stop index is out of range",
      },
    });
  });
});

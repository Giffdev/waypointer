// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImportRouteClientView,
  nextImportPollDelayMs,
  shouldPauseImportPolling,
  shouldWarnImportPolling,
} from "./route-client";
import { CSV_MIME_TYPES } from "@/lib/import/csv-mime";

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

const data = {
  hasLocalArtifact: false,
  normalizedFlightCount: 0,
  supportedFormats: [
    "ForeFlight Logbook Import",
    "myFlightradar24 Flight Diary CSV",
    "Digital logbook CSV (MyFlightbook Export and CrewLounge PILOTLOG presets, or map another CSV)",
  ],
};

const fr24Csv = [
  "Date,Flight number,From,To,Dep time,Arr time,Duration,Airline,Aircraft,Registration,Seat number,Seat type,Flight class,Flight reason,Note,Dep_id,Arr_id,Airline_id,Aircraft_id",
  "2026-04-05,DL123,Seattle (SEA/KSEA),New York (JFK/KJFK),8:05,10:35,02:30,Delta,Airbus A321,N123AB,12A,Window,Economy,Leisure,,101,202,DL,4512",
].join("\n");

const foreFlightCsv = [
  "ForeFlight Logbook Import",
  "",
  "Aircraft Table",
  "AircraftID,TypeCode,Year,Make,Model,GearType,EngineType,equipType (FAA),aircraftClass (FAA)",
  "SYNTH-A,C172,2020,Example Aviation,Trainer,Fixed Tricycle,Reciprocating,airplane,Airplane Single Engine Land",
  "Flights Table",
  "Date,AircraftID,From,To,Distance,TimeOut,TotalTime",
  "2026-01-02,SYNTH-A,KSEA,KJFK,2100,8:05,5.2",
].join("\n");

afterEach(() => {
  cleanup();
  replace.mockReset();
  refresh.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("development import preview", () => {
  it("discloses original-file retention before file collection", () => {
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
        maxFileBytes={1024 * 1024}
      />,
    );

    const notice = screen.getByText(
      "Your CSV is processed to save flight records. The original file is not retained after this import.",
    );
    const input = screen.getByLabelText("Choose one supported CSV");
    expect(input).toHaveAttribute(
      "aria-describedby",
      "import-retention-notice",
    );
    expect(
      notice.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("advertises the .csv extension plus every shared CSV MIME type on the file input, with no wildcard", () => {
    // Android Chrome's native file picker (Storage Access Framework)
    // filters documents by MIME type, and document providers label CSVs as
    // text/csv, text/plain, application/vnd.ms-excel, or
    // application/octet-stream depending on provider/device. An accept
    // value of only ".csv" causes SAF to grey out valid CSVs. This asserts
    // the rendered input's accept contract stays in lockstep with
    // CSV_MIME_TYPES (src/lib/import/csv-mime.ts) without ever widening to
    // "*/*", which would defeat picker filtering entirely.
    //
    // Note: jsdom/RTL cannot model native Android SAF chooser filtering, so
    // this only verifies the rendered accept attribute contract, not real
    // device behavior.
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
        maxFileBytes={1024 * 1024}
      />,
    );

    const input = screen.getByLabelText("Choose one supported CSV");
    const accept = input.getAttribute("accept") ?? "";
    const acceptTokens = accept.split(",").map((token) => token.trim());

    expect(acceptTokens).toContain(".csv");
    for (const mimeType of CSV_MIME_TYPES) {
      expect(acceptTokens).toContain(mimeType);
    }
    expect(accept).not.toContain("*/*");
  });

  it("plainly distinguishes the empty map from the file being reviewed", () => {
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled={false}
        developmentPreviewEnabled
      />,
    );

    expect(screen.getByText("No earlier imports are on the map")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The map has no flights imported earlier on this computer. Selecting or reviewing a file here is separate from the map. Raw file fields are not shown on the map.",
      ),
    ).toBeInTheDocument();
  });

  it("plainly distinguishes earlier imports from the file being reviewed", () => {
    render(
      <ImportRouteClientView
        data={{ ...data, hasLocalArtifact: true, normalizedFlightCount: 321 }}
        apiEnabled={false}
        developmentPreviewEnabled
      />,
    );

    expect(
      screen.getByText("Flights from an earlier import are on the map"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The map is showing 321 flights imported earlier on this computer. They are separate from the file selected or reviewed here. Raw file fields are not shown on the map.",
      ),
    ).toBeInTheDocument();
  });

  it("enables the native file input and parses a supported CSV locally", async () => {
    const user = userEvent.setup();
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled={false}
        developmentPreviewEnabled
      />,
    );

    const input = screen.getByLabelText("Choose one supported CSV");
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute("type", "file");

    const file = new File([fr24Csv], "flightdiary.csv", {
      type: "text/csv",
    });
    await user.upload(input, file);

    expect(
      await screen.findByRole("heading", { name: "flightdiary.csv" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/detected myflightradar24 flight diary csv/i))
      .toHaveTextContent(/source FlightRadar24/i);
    expect(screen.getByText(/1 rows staged for preview/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing has been uploaded, saved, or committed/i))
      .toBeInTheDocument();
    expect(screen.getByText("SEA → JFK")).toBeInTheDocument();
    expect(input).toHaveValue("");

    await user.upload(input, file);
    expect(
      await screen.findByRole("heading", { name: "flightdiary.csv" }),
    ).toBeInTheDocument();
  });

  it("surfaces actionable errors for invalid, unsupported, and binary files", async () => {
    const user = userEvent.setup();
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled={false}
        developmentPreviewEnabled
      />,
    );
    const input = screen.getByLabelText("Choose one supported CSV");

    await user.upload(
      input,
      new File(["timestamp,latitude\n1,2"], "unknown.csv", {
        type: "text/csv",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /does not match a supported ForeFlight or myFlightradar24 export/i,
    );

    await user.upload(
      input,
      new File([`${fr24Csv.split("\n")[0]}\n2026-04-05,short`], "broken.csv", {
        type: "text/csv",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /unexpected number of columns/i,
    );

    await user.upload(
      input,
      new File([new Uint8Array([65, 0, 66])], "binary.csv", {
        type: "text/csv",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /contains binary data/i,
    );
  });

  it("parses a Windows-1252-encoded CSV re-saved by a spreadsheet from a UTF-8 BOM export", async () => {
    // 0xE9 is "é" in Windows-1252 but is not valid standalone UTF-8, so this
    // exercises readPreviewCsv's fallback path, not just plain ASCII input.
    const windows1252Bytes = new Uint8Array([
      ...new TextEncoder().encode(`${fr24Csv.split("\n")[0]}\n2026-04-05,DL123,Seattle (SEA/KSEA),New York (JFK/KJFK),8:05,10:35,02:30,Delta,Airbus A321,N123AB,12A,Window,Economy,Leisure,Caf`),
      0xe9,
      ...new TextEncoder().encode(",101,202,DL,4512"),
    ]);
    const user = userEvent.setup();
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled={false}
        developmentPreviewEnabled
      />,
    );
    const input = screen.getByLabelText("Choose one supported CSV");

    await user.upload(
      input,
      new File([windows1252Bytes], "windows-1252.csv", { type: "text/csv" }),
    );

    expect(
      await screen.findByRole("heading", { name: "windows-1252.csv" }),
    ).toBeInTheDocument();
  });

  it("rejects a corrupted upload that decodes as neither UTF-8 nor Windows-1252", async () => {
    const user = userEvent.setup();
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled={false}
        developmentPreviewEnabled
      />,
    );
    const input = screen.getByLabelText("Choose one supported CSV");

    // Five bytes the WHATWG Windows-1252 index leaves unassigned; combined
    // with the C1-range safeguard in decodeCsvBytes, these are rejected
    // rather than silently accepted as corrupted text. Node's ICU-backed
    // TextDecoder (used here under jsdom too, since jsdom does not
    // implement its own TextDecoder) passes these through as literal C1
    // control code points rather than the replacement character a
    // spec-compliant browser would produce, so this is caught by the
    // control-character safeguard ("binary-content") rather than the
    // replacement-character check ("invalid-encoding"). Both paths reject
    // the upload; see the comment on isControlOrUnmappedCharacter in
    // csv-decode.ts for the full rationale.
    await user.upload(
      input,
      new File(
        [new Uint8Array([0x81, 0x8d, 0x8f, 0x90, 0x9d, 0x81, 0x8d])],
        "corrupted.csv",
        { type: "text/csv" },
      ),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /contains binary data/i,
    );
  });

  it("rejects a declared UTF-8 BOM that is not actually valid UTF-8 (no Windows-1252 fallback)", async () => {
    const user = userEvent.setup();
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled={false}
        developmentPreviewEnabled
      />,
    );
    const input = screen.getByLabelText("Choose one supported CSV");

    // A UTF-8 BOM followed by a byte sequence that is not valid UTF-8. Since
    // the file declares UTF-8 via its BOM, decodeCsvBytes must not silently
    // fall back to Windows-1252 for it.
    await user.upload(
      input,
      new File(
        [new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xff, 0xfe, 0x42])],
        "corrupt-utf8-bom.csv",
        { type: "text/csv" },
      ),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /not valid UTF-8 or Windows-1252 text/i,
    );
  });

  it.each([
    ["text/csv"],
    ["text/plain"],
    // iOS Safari's Files picker reports this MIME type for .csv files
    // instead of "text/csv"; regression coverage for the mobile CSV
    // upload bug where such files were rejected before any upload.
    ["application/vnd.ms-excel"],
    ["APPLICATION/VND.MS-EXCEL"],
    // Some mobile pickers report this generic binary type instead of
    // text/csv; regression coverage for the mobile CSV upload bug where
    // the durable initiate path rejected such files even though this
    // client-side preview gate accepted them. See
    // src/lib/import/csv-mime.ts.
    ["application/octet-stream"],
    // Some mobile browsers omit a content type entirely.
    [""],
  ])(
    "parses a supported CSV declared with the mobile-safe content type %s",
    async (type) => {
      const user = userEvent.setup();
      render(
        <ImportRouteClientView
          data={data}
          apiEnabled={false}
          developmentPreviewEnabled
        />,
      );
      const input = screen.getByLabelText("Choose one supported CSV");

      await user.upload(
        input,
        new File([fr24Csv], "flightdiary.csv", { type }),
      );

      expect(
        await screen.findByRole("heading", { name: "flightdiary.csv" }),
      ).toBeInTheDocument();
    },
  );

  it("rejects a content type unrelated to CSV, even with a .csv name", async () => {
    const user = userEvent.setup();
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled={false}
        developmentPreviewEnabled
      />,
    );
    const input = screen.getByLabelText("Choose one supported CSV");

    await user.upload(
      input,
      new File([fr24Csv], "flightdiary.csv", { type: "text/html" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /not reported as CSV or plain-text content/i,
    );
  });

  it("auto-starts the configured authenticated upload flow", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/import/upload" && init?.method === "POST") {
        return jsonResponse({
          batchId: "batch-1",
          status: "processing",
          reused: false,
        });
      }
      if (url.startsWith("/api/import/batches/batch-1")) {
        return jsonResponse({
          contractVersion: 1,
          id: "batch-1",
          fileName: "flightdiary.csv",
          status: "processing",
          counts: {
            totalRows: 0,
            parsedRows: 0,
            readyRows: 0,
            acceptedRows: 0,
            skippedRows: 0,
            pendingRows: 0,
            committedFlights: 0,
            attachedSources: 0,
          },
          createdAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
          rows: {
            page: 1,
            pageSize: 25,
            totalRows: 0,
            totalPages: 1,
            rows: [],
          },
        });

      }
      return jsonResponse({ batches: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled
      />,
    );
    expect(
      screen.getByText(/clean new flights are saved automatically/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/development preview parses supported CSVs/i),
    ).not.toBeInTheDocument();

    const input = screen.getByLabelText("Choose one supported CSV");
    await user.upload(
      input,
      new File([fr24Csv], "flightdiary.csv", { type: "text/csv" }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/import/upload",
        expect.objectContaining({
          method: "POST",
          body: expect.any(FormData),
        }),
      ),
    );
  });

  it("auto-starts the authenticated upload flow for a mobile-reported vnd.ms-excel CSV", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/import/upload" && init?.method === "POST") {
        return jsonResponse({
          batchId: "batch-1",
          status: "processing",
          reused: false,
        });
      }
      return jsonResponse({ batches: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView data={data} apiEnabled developmentPreviewEnabled />,
    );

    const input = screen.getByLabelText("Choose one supported CSV");
    // iOS Safari's Files picker reports this MIME type for .csv files
    // instead of "text/csv"; this is the exact defect the mobile upload
    // bug report described.
    await user.upload(
      input,
      new File([fr24Csv], "flightdiary.csv", {
        type: "application/vnd.ms-excel",
      }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/import/upload",
        expect.objectContaining({
          method: "POST",
          body: expect.any(FormData),
        }),
      ),
    );
  });

  it("auto-starts the same import path for drag and drop", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/import/upload") {
        return new Response(
          JSON.stringify({
            error: { code: "test-stop", message: "Drop upload captured." },
          }),
          {
            status: 422,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      return jsonResponse({ batches: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
        maxFileBytes={1024 * 1024}
      />,
    );

    const dropArea = screen.getByLabelText("CSV file drop area");
    expect(screen.getByText(/1\.0 MB maximum/)).toBeInTheDocument();
    fireEvent.dragEnter(dropArea, {
      dataTransfer: { files: [] },
    });
    expect(screen.getByText("Drop CSV to select it")).toBeInTheDocument();

    fireEvent.drop(dropArea, {
      dataTransfer: {
        files: [
          new File([fr24Csv], "flightdiary.csv", { type: "text/csv" }),
        ],
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Drop upload captured.",
    );
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/import/upload",
      ),
    ).toHaveLength(1);
  });

  it("makes an auto-started upload visibly and accessibly busy", async () => {
    const user = userEvent.setup();
    let resolveUpload!: (response: Response) => void;
    const uploadResponse = new Promise<Response>((resolve) => {
      resolveUpload = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/import/upload") return uploadResponse;
      return jsonResponse({ batches: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
        maxFileBytes={1024 * 1024}
      />,
    );

    expect(screen.queryByRole("button", { name: /upload|import/i }))
      .not.toBeInTheDocument();
    expect(screen.getByText("Choose or drop a CSV to start an import."))
      .toBeInTheDocument();

    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File([foreFlightCsv], "foreflight.csv", { type: "text/csv" }),
    );

    const uploading = await screen.findByRole("button", { name: "Uploading…" });
    expect(uploading).toBeDisabled();
    expect(uploading).toHaveClass("import-upload-button", "loading");
    expect(uploading).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("CSV file drop area")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/import/upload",
      ),
    ).toHaveLength(1);

    resolveUpload(
      new Response(
        JSON.stringify({
          error: { code: "test-stop", message: "Upload captured." },
        }),
        {
          status: 422,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Upload captured.",
    );
  });

  it("does nothing when the file picker is cancelled", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL) => Promise<Response>
    >(
      async () => jsonResponse({ batches: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );

    fireEvent.change(screen.getByLabelText("Choose one supported CSV"), {
      target: { files: [] },
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/import/upload",
      ),
    ).toHaveLength(0);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Choose or drop a CSV to start an import."))
      .toBeInTheDocument();
  });

  it("rejects invalid CSV content locally without submitting it", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<
      (input: RequestInfo | URL) => Promise<Response>
    >(
      async () => jsonResponse({ batches: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File(
        [`${fr24Csv.split("\n")[0]}\n2026-04-05,short`],
        "broken.csv",
        { type: "text/csv" },
      ),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /unexpected number of columns/i,
    );
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/import/upload",
      ),
    ).toHaveLength(0);
    expect(
      screen.queryByRole("button", { name: "Try import again" }),
    ).not.toBeInTheDocument();
  });

  it("stays busy through post-upload refresh and prevents a second submission", async () => {
    const user = userEvent.setup();
    let resolveDetail!: (response: Response) => void;
    const detailResponse = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/import/upload") {
        return jsonResponse({
          batchId: "batch-busy-refresh",
          status: "review",
          reused: false,
        });
      }
      if (url.startsWith("/api/import/batches/batch-busy-refresh")) {
        return (await detailResponse).clone();
      }
      return jsonResponse({ batches: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );

    const input = screen.getByLabelText("Choose one supported CSV");
    const file = new File([fr24Csv], "one-upload.csv", {
      type: "text/csv",
    });
    await user.upload(input, file);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([request]) =>
          String(request).includes("/api/import/batches/batch-busy-refresh"),
        ),
      ).toBe(true),
    );
    const uploading = await screen.findByRole("button", { name: "Uploading…" });
    expect(input).toBeDisabled();
    expect(screen.getByLabelText("CSV file drop area")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    fireEvent.click(uploading);
    fireEvent.drop(screen.getByLabelText("CSV file drop area"), {
      dataTransfer: { files: [file] },
    });

    expect(
      fetchMock.mock.calls.filter(
        ([request]) => String(request) === "/api/import/upload",
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([request]) =>
        String(request).includes("/api/import/batches/batch-busy-refresh"),
      ),
    ).toHaveLength(1);

    resolveDetail(
      jsonResponse({
        batch: {
          contractVersion: 1,
          id: "batch-busy-refresh",
          fileName: "one-upload.csv",
          status: "review",
          counts: {
            totalRows: 1,
            parsedRows: 1,
            readyRows: 0,
            acceptedRows: 0,
            skippedRows: 0,
            pendingRows: 1,
            committedFlights: 0,
            attachedSources: 0,
          },
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:01.000Z",
          rows: {
            page: 1,
            pageSize: 25,
            totalRows: 0,
            totalPages: 1,
            rows: [],
          },
        },
      }),
    );
    expect(await screen.findByText("Import summary")).toBeInTheDocument();
    expect(input).toBeEnabled();
    expect(
      fetchMock.mock.calls.filter(([request]) =>
        String(request).includes("/api/import/batches/batch-busy-refresh"),
      ),
    ).toHaveLength(1);
  });

  it("does not offer upload retry after the server accepts a batch", async () => {
    const user = userEvent.setup();
    let batchAccepted = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/import/upload") {
        batchAccepted = true;
        return jsonResponse({
          batchId: "batch-refresh-failed",
          status: "review",
          reused: false,
        });
      }
      if (url.startsWith("/api/import/batches/batch-refresh-failed")) {
        return new Response(null, { status: 503 });
      }
      if (url === "/api/import/batches" && batchAccepted) {
        return new Response(null, { status: 503 });
      }
      return jsonResponse({ batches: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File([fr24Csv], "accepted.csv", { type: "text/csv" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Uploading…" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /import (?:was accepted, but its )?status could not be refreshed/i,
    );
    expect(
      screen.queryByRole("button", { name: "Try import again" }),
    ).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([request]) => String(request) === "/api/import/upload",
      ),
    ).toHaveLength(1);
  });

  it("allows the same file after both a failed and completed attempt", async () => {
    const user = userEvent.setup();
    let uploadCount = 0;
    const completion = {
      totalRows: 1,
      importedRows: 1,
      duplicateRows: 0,
      skippedRows: 0,
      invalidRows: 0,
      reviewRequiredRows: 0,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/import/upload") {
        uploadCount += 1;
        if (uploadCount === 2) {
          return jsonResponse({
            batchId: "batch-complete-reselect",
            status: "committed",
            reused: false,
            completion,
          });
        }
        return new Response(
          JSON.stringify({
            error: {
              code: "test-stop",
              message:
                uploadCount === 1
                  ? "First attempt failed."
                  : "Same file selected after completion.",
            },
          }),
          {
            status: 422,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      if (url.startsWith("/api/import/batches/batch-complete-reselect")) {
        return jsonResponse({
          batch: {
            contractVersion: 1,
            id: "batch-complete-reselect",
            fileName: "repeat.csv",
            status: "committed",
            counts: {
              totalRows: 1,
              parsedRows: 1,
              readyRows: 1,
              acceptedRows: 1,
              skippedRows: 0,
              pendingRows: 0,
              committedFlights: 1,
              attachedSources: 1,
            },
            createdAt: "2026-08-20T00:00:00.000Z",
            updatedAt: "2026-08-20T00:00:01.000Z",
            rows: {
              page: 1,
              pageSize: 25,
              totalRows: 0,
              totalPages: 1,
              rows: [],
            },
          },
        });
      }
      return jsonResponse({ batches: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );

    const input = screen.getByLabelText("Choose one supported CSV");
    const file = new File([fr24Csv], "repeat.csv", { type: "text/csv" });
    await user.upload(input, file);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "First attempt failed.",
    );

    await user.upload(input, file);
    expect(await screen.findByText("Import finished")).toBeInTheDocument();

    await user.upload(input, file);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Same file selected after completion.",
    );
    expect(uploadCount).toBe(3);
  });

  it("automatically maps an unambiguous generic CSV", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (...args: [RequestInfo | URL, RequestInit?]) => {
        const [input] = args;
        if (String(input) === "/api/import/upload") {
          return new Response(
            JSON.stringify({
              error: { code: "test-stop", message: "Mapping captured." },
            }),
            {
              status: 422,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return jsonResponse({ batches: [] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File(
        [
          "Flight Date,Origin,Destination,Flight Number\n2026-08-13,SEA,SFO,FM123",
        ],
        "personal-log.csv",
        { type: "text/csv" },
      ),
    );
    expect(
      screen.queryByRole("heading", {
        name: "Match this CSV to flight fields",
      }),
    ).not.toBeInTheDocument();
    await screen.findByText("Mapping captured.");

    const uploadCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "/api/import/upload",
    );
    const body = uploadCall?.[1]?.body as FormData;
    expect(body.get("file")).toBeInstanceOf(File);
    expect(JSON.parse(String(body.get("mapping")))).toMatchObject({
      version: 1,
      columns: {
        date: "flight date",
        origin: "origin",
        destination: "destination",
        flightNumber: "flight number",
      },
      dateFormat: "iso",
      defaults: { kind: "private", role: "pilot" },
    });
  });

  it("does not expose raw values while awaiting an ambiguous generic mapping", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ batches: [] })));
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File(
        [[
          "TripDay,StartCode,EndCode,Private note",
          "not-a-date,SEA,SFO,do not render this raw value",
        ].join("\n")],
        "generic-issues.csv",
        { type: "text/csv" },
      ),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Match this CSV to flight fields",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("do not render this raw value"),
    ).not.toBeInTheDocument();
  });

  it("keeps unknown generic headers available for explicit required mapping", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (...args: [RequestInfo | URL, RequestInit?]) => {
        const [input] = args;
        if (String(input) === "/api/import/upload") {
          return new Response(
            JSON.stringify({
              error: { code: "test-stop", message: "Unknown mapping captured." },
            }),
            {
              status: 422,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return jsonResponse({ batches: [] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File(
        [[
          "TripDay,StartCode,EndCode,PrivateMemo",
          "2026-08-13,SEA,JFK,do-not-display-alpha",
          "2026-08-14,JFK,LHR,do-not-display-beta",
        ].join("\n")],
        "unknown-logbook.csv",
        { type: "text/csv" },
      ),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Match this CSV to flight fields",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("3 required")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Import mapped CSV" }),
    ).toBeDisabled();

    await user.selectOptions(screen.getByLabelText(/Flight date/), "TripDay");
    await user.selectOptions(
      screen.getByLabelText(/Origin airport/),
      "StartCode",
    );
    await user.selectOptions(
      screen.getByLabelText(/Destination airport/),
      "EndCode",
    );

    expect(await screen.findByText("2 valid")).toBeInTheDocument();
    expect(screen.getByText("0 need attention")).toBeInTheDocument();
    expect(screen.getByText("SEA → JFK")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Import mapped CSV" }),
    ).toBeEnabled();
    expect(screen.queryByText(/do-not-display/)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Import mapped CSV" }),
    );
    await screen.findByText("Unknown mapping captured.");
    const uploadCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "/api/import/upload",
    );
    const body = uploadCall?.[1]?.body as FormData;
    expect(JSON.parse(String(body.get("mapping")))).toMatchObject({
      version: 1,
      columns: {
        date: "tripday",
        origin: "startcode",
        destination: "endcode",
      },
    });
  });

  it("carries generic mapping at durable finalize without changing initiate", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/import/upload/initiate") {
          return jsonResponse({
            batchId: "batch-generic-durable",
            uploadUrl: "https://objects.example.test/generic-signed-put",
            headers: { "content-type": "text/csv" },
          });
        }
        if (url === "https://objects.example.test/generic-signed-put") {
          return new Response(null, { status: 200 });
        }
        if (url === "/api/import/upload/finalize") {
          return jsonResponse({
            batchId: "batch-generic-durable",
            status: "queued",
            reused: false,
          });
        }
        if (url.startsWith("/api/import/batches/batch-generic-durable")) {
          return jsonResponse({
            batch: {
              contractVersion: 1,
              id: "batch-generic-durable",
              fileName: "generic-durable.csv",
              status: "queued",
              counts: {
                totalRows: 0,
                parsedRows: 0,
                readyRows: 0,
                acceptedRows: 0,
                skippedRows: 0,
                pendingRows: 0,
                committedFlights: 0,
                attachedSources: 0,
              },
              createdAt: "2026-08-13T00:00:00.000Z",
              updatedAt: "2026-08-13T00:00:01.000Z",
              rows: {
                page: 1,
                pageSize: 25,
                totalRows: 0,
                totalPages: 1,
                rows: [],
              },
            },
          });
        }
        if (url === "/api/import/batches") return jsonResponse({ batches: [] });
        throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
        durableImportEnabled
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File(
        ["TripDay,StartCode,EndCode\n2026-08-13,SEA,SFO"],
        "generic-durable.csv",
        { type: "text/csv" },
      ),
    );
    await screen.findByRole("heading", {
      name: "Match this CSV to flight fields",
    });
    expect(
      screen.getByRole("button", { name: "Import mapped CSV" }),
    ).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/import/upload/initiate",
      expect.anything(),
    );
    await user.selectOptions(screen.getByLabelText(/Flight date/), "TripDay");
    await user.selectOptions(
      screen.getByLabelText(/Origin airport/),
      "StartCode",
    );
    await user.selectOptions(
      screen.getByLabelText(/Destination airport/),
      "EndCode",
    );
    await screen.findByText("1 valid");
    await user.click(
      screen.getByRole("button", { name: "Import mapped CSV" }),
    );
    await screen.findByRole("button", { name: "Cancel import" });

    const initiateCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "/api/import/upload/initiate",
    );
    expect(JSON.parse(String(initiateCall?.[1]?.body))).not.toHaveProperty(
      "mapping",
    );
    const finalizeCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "/api/import/upload/finalize",
    );
    expect(JSON.parse(String(finalizeCall?.[1]?.body))).toMatchObject({
      batchId: "batch-generic-durable",
      mapping: {
        columns: {
          date: "tripday",
          origin: "startcode",
          destination: "endcode",
        },
      },
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/import/upload",
      expect.anything(),
    );
  });


  it("uploads directly to private storage before durable finalization", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/import/upload/initiate") {
          return jsonResponse({
            batchId: "batch-durable",
            uploadUrl: "https://objects.example.test/private-signed-put",
            headers: { "content-type": "text/csv" },
          });
        }
        if (url === "https://objects.example.test/private-signed-put") {
          return new Response(null, { status: 200 });
        }
        if (url === "/api/import/upload/finalize") {
          return jsonResponse({
            batchId: "batch-durable",
            status: "queued",
            reused: false,
          });
        }
        if (url.startsWith("/api/import/batches/batch-durable")) {
          return jsonResponse({
            batch: {
              contractVersion: 1,
              id: "batch-durable",
              fileName: "flightdiary.csv",
              status: "queued",
              counts: {
                totalRows: 0,
                parsedRows: 0,
                readyRows: 0,
                acceptedRows: 0,
                skippedRows: 0,
                pendingRows: 0,
                committedFlights: 0,
                attachedSources: 0,
              },
              createdAt: "2026-08-11T00:00:00.000Z",
              updatedAt: "2026-08-11T00:00:00.000Z",
              rows: {
                page: 1,
                pageSize: 25,
                totalRows: 0,
                totalPages: 1,
                rows: [],
              },
            },
          });
        }
        return jsonResponse({ batches: [] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
        durableImportEnabled
      />,
    );
    const file = new File([fr24Csv], "flightdiary.csv", {
      type: "text/csv",
    });
    await user.upload(screen.getByLabelText("Choose one supported CSV"), file);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "https://objects.example.test/private-signed-put",
        expect.objectContaining({
          method: "PUT",
          headers: { "content-type": "text/csv" },
          body: file,
        }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/import/upload/finalize",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ batchId: "batch-durable" }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/import/upload",
      expect.anything(),
    );
    expect(
      await screen.findByRole("button", { name: "Cancel import" }),
    ).toBeInTheDocument();
  });

  it("forwards a mobile-reported application/octet-stream content type through durable initiate", async () => {
    // Regression test: the durable initiate path (src/lib/import/
    // durable-service.ts) previously rejected "application/octet-stream"
    // even though the client preview gate and the synchronous upload
    // service both accepted it, because the durable service's MIME
    // allowlist had drifted out of sync. This client forwards
    // selectedFile.type verbatim to /api/import/upload/initiate, so a
    // valid mobile CSV declared this way must complete the full
    // upload/finalize flow without error. See src/lib/import/csv-mime.ts.
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/import/upload/initiate") {
        return jsonResponse({
          batchId: "batch-octet-stream",
          uploadUrl: "https://objects.example.test/octet-stream-signed-put",
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (url === "https://objects.example.test/octet-stream-signed-put") {
        return new Response(null, { status: 200 });
      }
      if (url === "/api/import/upload/finalize") {
        return jsonResponse({
          batchId: "batch-octet-stream",
          status: "queued",
          reused: false,
        });
      }
      if (url.startsWith("/api/import/batches/batch-octet-stream")) {
        return jsonResponse({
          batch: {
            contractVersion: 1,
            id: "batch-octet-stream",
            fileName: "flightdiary.csv",
            status: "queued",
            counts: {
              totalRows: 0,
              parsedRows: 0,
              readyRows: 0,
              acceptedRows: 0,
              skippedRows: 0,
              pendingRows: 0,
              committedFlights: 0,
              attachedSources: 0,
            },
            createdAt: "2026-08-11T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
            rows: {
              page: 1,
              pageSize: 25,
              totalRows: 0,
              totalPages: 1,
              rows: [],
            },
          },
        });
      }
      return jsonResponse({ batches: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
        durableImportEnabled
      />,
    );
    const file = new File([fr24Csv], "flightdiary.csv", {
      type: "application/octet-stream",
    });
    await user.upload(screen.getByLabelText("Choose one supported CSV"), file);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/import/upload/initiate",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining(
            '"contentType":"application/octet-stream"',
          ),
        }),
      ),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "https://objects.example.test/octet-stream-signed-put",
        expect.objectContaining({
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: file,
        }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Cancel import" }),
    ).toBeInTheDocument();
  });

  it("shows a safe terminal quarantine state for EICAR with no review or commit path", async () => {
    const user = userEvent.setup();
    const eicar =
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/import/upload/initiate") {
          return jsonResponse({
            batchId: "batch-eicar",
            uploadUrl: "https://objects.example.test/eicar-signed-put",
            headers: { "content-type": "text/csv" },
          });
        }
        if (url === "https://objects.example.test/eicar-signed-put") {
          return new Response(null, { status: 200 });
        }
        if (url === "/api/import/upload/finalize") {
          return jsonResponse({
            batchId: "batch-eicar",
            status: "queued",
            reused: false,
          });
        }
        if (url.startsWith("/api/import/batches/batch-eicar")) {
          return jsonResponse({
            batch: {
              contractVersion: 1,
              id: "batch-eicar",
              fileName: "durable-eicar.csv",
              status: "quarantined",
              counts: {
                totalRows: 0,
                parsedRows: 0,
                readyRows: 0,
                acceptedRows: 0,
                skippedRows: 0,
                pendingRows: 0,
                committedFlights: 0,
                attachedSources: 0,
              },
              error: {
                code: "malware-detected",
                message: "The upload did not pass malware scanning.",
              },
              createdAt: "2026-08-13T00:00:00.000Z",
              updatedAt: "2026-08-13T00:00:01.000Z",
              rows: {
                page: 1,
                pageSize: 25,
                totalRows: 0,
                totalPages: 1,
                rows: [],
              },
            },
          });
        }
        return jsonResponse({ batches: [] });
      }),
    );
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
        durableImportEnabled
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File(
        [fr24Csv.replace("Leisure,,101", `Leisure,${eicar},101`)],
        "durable-eicar.csv",
        {
          type: "text/csv",
        },
      ),
    );

    expect(await screen.findByText("Import quarantined")).toBeInTheDocument();
    expect(
      screen.getByText("The upload did not pass malware scanning."),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("X5O!");
    expect(
      screen.queryByRole("button", { name: /Commit \d+ accepted rows?/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel import" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry import" }),
    ).not.toBeInTheDocument();
  });

  it("shows deduplicated imports as terminal with no processing controls", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/import/upload" && init?.method === "POST") {
          return jsonResponse({
            batchId: "batch-duplicate",
            status: "deduplicated",
            reused: true,
          });
        }
        if (url.startsWith("/api/import/batches/batch-duplicate")) {
          return jsonResponse({
            batch: {
              contractVersion: 1,
              id: "batch-duplicate",
              fileName: "already-imported.csv",
              status: "deduplicated",
              duplicateOfBatchId: "batch-original",
              counts: {
                totalRows: 0,
                parsedRows: 0,
                readyRows: 0,
                acceptedRows: 0,
                skippedRows: 0,
                pendingRows: 0,
                committedFlights: 0,
                attachedSources: 0,
              },
              createdAt: "2026-08-13T00:00:00.000Z",
              updatedAt: "2026-08-13T00:00:01.000Z",
              rows: {
                page: 1,
                pageSize: 25,
                totalRows: 0,
                totalPages: 1,
                rows: [],
              },
            },
          });
        }
        return jsonResponse({ batches: [] });
      }),
    );

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File([fr24Csv], "already-imported.csv", { type: "text/csv" }),
    );

    expect(await screen.findByText("Already imported")).toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/map"));
    expect(screen.queryByText("Processing uploaded CSV")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Commit \d+ accepted rows?/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel import" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry import" }),
    ).not.toBeInTheDocument();
  });

  it("offers an explicit retry only for a transient scanner failure", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/import/upload/initiate") {
        return jsonResponse({
          batchId: "batch-scanner-retry",
          uploadUrl: "https://objects.example.test/retry-signed-put",
          headers: { "content-type": "text/csv" },
        });
      }
      if (url === "https://objects.example.test/retry-signed-put") {
        return new Response(null, { status: 200 });
      }
      if (url === "/api/import/upload/finalize") {
        return jsonResponse({
          batchId: "batch-scanner-retry",
          status: "queued",
          reused: false,
        });
      }
      if (url.endsWith("/retry")) {
        return jsonResponse({ ok: true });
      }
      if (url.startsWith("/api/import/batches/batch-scanner-retry")) {
        return jsonResponse({
          batch: {
            contractVersion: 1,
            id: "batch-scanner-retry",
            fileName: "scanner-retry.csv",
            status: "failed",
            counts: {
              totalRows: 0,
              parsedRows: 0,
              readyRows: 0,
              acceptedRows: 0,
              skippedRows: 0,
              pendingRows: 0,
              committedFlights: 0,
              attachedSources: 0,
            },
            error: {
              code: "scanner-unavailable",
              message: "The import could not be processed safely.",
            },
            createdAt: "2026-08-13T00:00:00.000Z",
            updatedAt: "2026-08-13T00:00:01.000Z",
            rows: {
              page: 1,
              pageSize: 25,
              totalRows: 0,
              totalPages: 1,
              rows: [],
            },
          },
        });
      }
      return jsonResponse({ batches: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
        durableImportEnabled
      />,
    );

    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File([fr24Csv], "scanner-retry.csv", { type: "text/csv" }),
    );
    await user.click(await screen.findByRole("button", { name: "Retry import" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/import/batches/batch-scanner-retry/retry",
      expect.objectContaining({ method: "POST" }),
    );
    expect(
      screen.queryByRole("button", { name: "Commit accepted rows" }),
    ).not.toBeInTheDocument();
  });

  it("shows structured API validation messages instead of an opaque object", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/import/upload") {
          return new Response(
            JSON.stringify({
              error: {
                code: "unsupported-format",
                message:
                  "This CSV does not match a supported ForeFlight or myFlightradar24 export.",
              },
            }),
            {
              status: 422,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return jsonResponse({ batches: [] });
      }),
    );
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File(
        ["Date,From,To\n2026-08-13,SEA,JFK"],
        "server-rejected.csv",
        { type: "text/csv" },
      ),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This CSV does not match a supported ForeFlight or myFlightradar24 export.",
    );
  });

  it("shows automatic completion counts and returns a clean import to the map", async () => {
    const user = userEvent.setup();
    const completion = {
      totalRows: 4,
      importedRows: 2,
      duplicateRows: 1,
      skippedRows: 1,
      invalidRows: 0,
      reviewRequiredRows: 0,
    };
    const batchDetail = {
      contractVersion: 1,
      id: "batch-journey",
      fileName: "flightdiary.csv",
      adapterId: "myflightradar24-v1",
      adapterLabel: "myFlightradar24 Flight Diary CSV",
      adapterVersion: 1,
      source: "FlightRadar24",
      status: "committed",
      counts: {
        totalRows: 4,
        parsedRows: 4,
        readyRows: 2,
        acceptedRows: 0,
        skippedRows: 1,
        pendingRows: 0,
        importedRows: 2,
        duplicateRows: 1,
        invalidRows: 0,
        reviewRequiredRows: 0,
        committedFlights: 2,
        attachedSources: 0,
      },
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      rows: {
        page: 1,
        pageSize: 25,
        totalRows: 0,
        totalPages: 1,
        rows: [],
      },
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/import/upload") {
          return jsonResponse({
            batchId: "batch-journey",
            status: "committed",
            reused: false,
            completion,
          });
        }
        if (url.startsWith("/api/import/batches/batch-journey")) {
          return jsonResponse({ batch: batchDetail });
        }
        return jsonResponse({ batches: [] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File([fr24Csv], "flightdiary.csv", { type: "text/csv" }),
    );

    expect(await screen.findByText("Import finished")).toBeInTheDocument();
    expect(screen.getByText("2 imported")).toBeInTheDocument();
    expect(screen.getByText("1 duplicates skipped")).toBeInTheDocument();
    expect(screen.getByText("1 other rows skipped")).toBeInTheDocument();
    expect(screen.getByText("0 invalid")).toBeInTheDocument();
    expect(screen.getByText("0 need review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" }))
      .not.toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/map"));
    expect(screen.getByRole("link", { name: "View map" })).toHaveAttribute(
      "href",
      "/map",
    );
    expect(screen.getByRole("link", { name: "View flights" })).toHaveAttribute(
      "href",
      "/flights",
    );
  });

  it("returns to the map from a server-confirmed committed detail with legacy counts", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/import/upload") {
          return jsonResponse({
            batchId: "batch-legacy-complete",
            status: "committed",
            reused: false,
          });
        }
        if (url.startsWith("/api/import/batches/batch-legacy-complete")) {
          return jsonResponse({
            batch: {
              contractVersion: 1,
              id: "batch-legacy-complete",
              fileName: "real-export.csv",
              status: "committed",
              counts: {
                totalRows: 2,
                parsedRows: 2,
                readyRows: 2,
                acceptedRows: 2,
                skippedRows: 0,
                pendingRows: 0,
                committedFlights: 2,
                attachedSources: 2,
              },
              createdAt: "2026-08-14T18:00:00.000Z",
              updatedAt: "2026-08-14T18:00:01.000Z",
              rows: {
                page: 1,
                pageSize: 25,
                totalRows: 0,
                totalPages: 1,
                rows: [],
              },
            },
          });
        }
        return jsonResponse({ batches: [] });
      }),
    );

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File([fr24Csv], "real-export.csv", { type: "text/csv" }),
    );

    expect(await screen.findByText("Import complete")).toBeInTheDocument();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/map"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("waits for batch detail and keeps a stale terminal upload response in review", async () => {
    const user = userEvent.setup();
    let resolveDetail!: (response: Response) => void;
    const detailResponse = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/import/upload") {
        return jsonResponse({
          batchId: "batch-raced-review",
          status: "committed",
          reused: false,
          completion: {
            totalRows: 2,
            importedRows: 1,
            duplicateRows: 0,
            skippedRows: 0,
            invalidRows: 0,
            reviewRequiredRows: 0,
          },
        });
      }
      if (url.startsWith("/api/import/batches/batch-raced-review")) {
        return (await detailResponse).clone();
      }
      return jsonResponse({ batches: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File([fr24Csv], "raced.csv", { type: "text/csv" }),
    );
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) =>
          String(input).includes("/api/import/batches/batch-raced-review"),
        ),
      ).toBe(true);
    });
    expect(replace).not.toHaveBeenCalled();

    resolveDetail(
      jsonResponse({
        batch: {
          contractVersion: 1,
          id: "batch-raced-review",
          fileName: "raced.csv",
          status: "review",
          counts: {
            totalRows: 2,
            parsedRows: 2,
            readyRows: 1,
            acceptedRows: 1,
            skippedRows: 0,
            pendingRows: 1,
            committedFlights: 1,
            attachedSources: 1,
          },
          createdAt: "2026-08-14T18:00:00.000Z",
          updatedAt: "2026-08-14T18:00:01.000Z",
          rows: {
            page: 1,
            pageSize: 25,
            totalRows: 0,
            totalPages: 1,
            rows: [],
          },
        },
      }),
    );

    expect(await screen.findByText("Import summary")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("searches airports, patches a staged row, and explicitly resolves a duplicate", async () => {
    const user = userEvent.setup();
    let resolved = false;
    const detail = () => ({
      contractVersion: 1,
      id: "batch-review",
      fileName: "review.csv",
      adapterId: "myflightradar24-v1",
      adapterLabel: "myFlightradar24 Flight Diary CSV",
      adapterVersion: 1,
      source: "FlightRadar24",
      status: resolved ? "committed" : "review",
      counts: {
        totalRows: 3,
        parsedRows: 3,
        readyRows: 1,
        acceptedRows: resolved ? 1 : 0,
        skippedRows: 0,
        pendingRows: resolved ? 0 : 1,
        unresolvedDuplicateRows: resolved ? 0 : 1,
        importedRows: 2,
        duplicateRows: 0,
        invalidRows: 0,
        reviewRequiredRows: resolved ? 0 : 1,
        committedFlights: 0,
        attachedSources: 0,
      },
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      rows: {
        page: 1,
        pageSize: 25,
        totalRows: resolved ? 0 : 1,
        totalPages: 1,
        rows: resolved ? [] : [
          {
            id: "row-review",
            batchId: "batch-review",
            rowNumber: 2,
            rawSnapshot: null,
            proposedFlight: {
              date: "2026-04-05",
              origin: {
                status: "not-found",
                identifier: "ZZZZ",
              },
              destination: {
                status: "resolved",
                identifier: "KJFK",
                airportId: "airport-jfk",
                airport: {
                  code: "JFK",
                  name: "New York",
                  city: "New York",
                  country: "US",
                  lat: 40,
                  lon: -73,
                  facility: "commercial",
                },
              },
              kind: "commercial",
              role: "passenger",
              flightNumber: "AS100",
              source: "FlightRadar24",
            },
            issues: [],
            validationState: "duplicate",
            commitReady: true,
            decision: resolved ? "accepted" : "pending",
            duplicateCandidate: {
              scope: "existing-flight",
              candidateId: "flight-existing",
              score: 0.9,
              ruleVersion: 2,
              explanation: "Departure date, route, and flight number match.",
              signals: [],
              resolution: resolved ? "skip_as_duplicate" : "pending",
            },
            provenance: {
              adapterId: "myflightradar24-v1",
              adapterLabel: "myFlightradar24 Flight Diary CSV",
              adapterVersion: 1,
              source: "FlightRadar24",
              sourceRowNumber: 2,
            },
          },
        ],
      },
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/import/upload") {
          return jsonResponse({
            batchId: "batch-review",
            status: "review",
            reused: false,
            completion: {
              totalRows: 3,
              importedRows: 2,
              duplicateRows: 0,
              skippedRows: 0,
              invalidRows: 0,
              reviewRequiredRows: 1,
            },
          });
        }
        if (url.startsWith("/api/import/airports?")) {
          return jsonResponse({
            airports: [
              {
                airportId: "airport-sea",
                code: "SEA",
                icao: "KSEA",
                name: "Seattle-Tacoma International",
                city: "Seattle",
                country: "US",
              },
            ],
          });
        }
        if (url.includes("/rows/") && init?.method === "PATCH") {
          return jsonResponse(detail());
        }
        if (url.endsWith("/decide") && init?.method === "POST") {
          resolved = true;
          return jsonResponse(detail());
        }
        if (url.startsWith("/api/import/batches/batch-review")) {
          return jsonResponse({ batch: detail() });
        }
        return jsonResponse({ batches: [] });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File([fr24Csv], "review.csv", { type: "text/csv" }),
    );
    expect(await screen.findByText("Import summary")).toBeInTheDocument();
    expect(screen.getByText("1 need review")).toBeInTheDocument();
    expect(
      screen.getByText(/2 rows already imported from review\.csv/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Possible duplicate")).toBeInTheDocument();
    expect(screen.getByText(/90% match/)).toHaveTextContent(
      "Departure date, route, and flight number match.",
    );
    const exceptionRow = screen.getByText("Possible duplicate").closest("article");
    expect(exceptionRow).toHaveClass("flight-row", "import-exception-row");
    expect(
      screen.getByLabelText("Unresolved import rows").querySelectorAll("article"),
    ).toHaveLength(1);
    expect(exceptionRow).toHaveTextContent("Needs correction");
    expect(exceptionRow).not.toHaveTextContent("Edit");
    expect(exceptionRow).not.toHaveTextContent("Delete");
    expect(screen.queryByRole("button", { name: "Accept" }))
      .not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    await user.click(await screen.findByText("Correct flight"));
    await user.type(
      screen.getByLabelText("Origin airport for row 2"),
      "Seattle",
    );
    await user.click(
      await screen.findByRole("option", {
        name: /SEA — Seattle-Tacoma International/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/import/batches/batch-review/rows/row-review",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    await user.click(screen.getByRole("button", { name: "Use existing" }));
    const decisionCall = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith("/decide"),
    );
    expect(JSON.parse(String(decisionCall?.[1]?.body))).toMatchObject({
      decisions: [
        {
          rowId: "row-review",
          action: "accepted",
          duplicateResolution: "skip_as_duplicate",
        },
      ],
    });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/map"));
  });
});

describe("import polling controls", () => {
  it("uses bounded slower polling when hidden or unchanged", () => {
    expect(
      nextImportPollDelayMs({
        visible: true,
        unchangedPolls: 0,
        failedPolls: 0,
      }),
    ).toBe(2000);
    expect(
      nextImportPollDelayMs({
        visible: true,
        unchangedPolls: 3,
        failedPolls: 0,
      }),
    ).toBe(16_000);
    expect(
      nextImportPollDelayMs({
        visible: false,
        unchangedPolls: 0,
        failedPolls: 0,
      }),
    ).toBe(15_000);
    expect(
      nextImportPollDelayMs({
        visible: false,
        unchangedPolls: 7,
        failedPolls: 0,
      }),
    ).toBe(300_000);
  });

  it("warns and pauses polling only after stale thresholds", () => {
    expect(shouldWarnImportPolling(119_999)).toBe(false);
    expect(shouldWarnImportPolling(120_000)).toBe(true);
    expect(shouldPauseImportPolling(1_199_999)).toBe(false);
    expect(shouldPauseImportPolling(1_200_000)).toBe(true);
  });

  it("warns after two minutes of nonterminal processing despite changing timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00.000Z"));
    const batch = {
      contractVersion: 1,
      id: "batch-changing-timestamps",
      fileName: "changing-timestamps.csv",
      status: "processing",
      counts: {
        totalRows: 0,
        parsedRows: 0,
        readyRows: 0,
        acceptedRows: 0,
        skippedRows: 0,
        pendingRows: 0,
        committedFlights: 0,
        attachedSources: 0,
      },
      createdAt: "2026-08-19T11:59:00.000Z",
      updatedAt: "2026-08-19T11:59:01.000Z",
    } as const;
    let detailRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (
        String(input).startsWith(
          "/api/import/batches/batch-changing-timestamps",
        )
      ) {
        detailRequests += 1;
        return jsonResponse({
          batch: {
            ...batch,
            updatedAt: new Date(
              Date.now() + detailRequests,
            ).toISOString(),
            rows: {
              page: 1,
              pageSize: 25,
              totalRows: 0,
              totalPages: 1,
              rows: [],
            },
          },
        });
      }
      return jsonResponse({ batches: [batch] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(
      screen.getByRole("button", { name: /changing-timestamps\.csv/i }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(detailRequests).toBeGreaterThan(2);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This import is taking longer than expected. Status checks are still active with slower backoff.",
    );
    expect(
      screen.queryByRole("button", { name: "Resume status checks" }),
    ).not.toBeInTheDocument();
  });

  it("preserves a terminal result received after twenty minutes without pausing", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-08-19T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    const batch = {
      contractVersion: 1,
      id: "batch-terminal-after-twenty",
      fileName: "terminal-after-twenty.csv",
      status: "processing",
      counts: {
        totalRows: 0,
        parsedRows: 0,
        readyRows: 0,
        acceptedRows: 0,
        skippedRows: 0,
        pendingRows: 0,
        committedFlights: 0,
        attachedSources: 0,
      },
      createdAt: "2026-08-19T11:59:00.000Z",
      updatedAt: "2026-08-19T11:59:01.000Z",
    } as const;
    let detailRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (
        String(input).startsWith(
          "/api/import/batches/batch-terminal-after-twenty",
        )
      ) {
        detailRequests += 1;
        const terminal =
          Date.now() - startedAt.getTime() >= 1_200_000;
        return jsonResponse({
          batch: {
            ...batch,
            status: terminal ? "failed" : "processing",
            updatedAt: new Date(
              Date.now() + detailRequests,
            ).toISOString(),
            ...(terminal
              ? {
                  error: {
                    code: "processing-failed",
                    message: "The worker reported a terminal failure.",
                  },
                }
              : {}),
            rows: {
              page: 1,
              pageSize: 25,
              totalRows: 0,
              totalPages: 1,
              rows: [],
            },
          },
        });
      }
      return jsonResponse({ batches: [batch] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(
      screen.getByRole("button", { name: /terminal-after-twenty\.csv/i }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_202_000);
    });

    expect(screen.getByText("Import failed")).toBeInTheDocument();
    expect(
      screen.getAllByText("The worker reported a terminal failure."),
    ).not.toHaveLength(0);
    expect(screen.queryByText(/status checks paused/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Resume status checks" }),
    ).not.toBeInTheDocument();
  });

  it("continues polling when cancellation initially remains processing", async () => {
    vi.useFakeTimers();
    const batch = {
      contractVersion: 1,
      id: "batch-cancelling",
      fileName: "cancelling.csv",
      status: "scanning",
      counts: {
        totalRows: 0,
        parsedRows: 0,
        readyRows: 0,
        acceptedRows: 0,
        skippedRows: 0,
        pendingRows: 0,
        committedFlights: 0,
        attachedSources: 0,
      },
      createdAt: "2026-08-19T12:00:00.000Z",
      updatedAt: "2026-08-19T12:00:01.000Z",
    } as const;
    let cancelRequested = false;
    const postCancelStatuses: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url === "/api/import/batches/batch-cancelling/cancel" &&
        init?.method === "POST"
      ) {
        cancelRequested = true;
        return jsonResponse({});
      }
      if (url.startsWith("/api/import/batches/batch-cancelling?")) {
        const status = cancelRequested
          ? postCancelStatuses.length === 0
            ? "processing"
            : "cancelled"
          : "scanning";
        if (cancelRequested) postCancelStatuses.push(status);
        return jsonResponse({
          batch: {
            ...batch,
            status,
            updatedAt:
              status === "cancelled"
                ? "2026-08-19T12:00:03.000Z"
                : "2026-08-19T12:00:02.000Z",
            rows: {
              page: 1,
              pageSize: 25,
              totalRows: 0,
              totalPages: 1,
              rows: [],
            },
          },
        });
      }
      return jsonResponse({ batches: [batch] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
        durableImportEnabled
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(
      screen.getByRole("button", { name: /cancelling\.csv/i }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel import" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(postCancelStatuses).toEqual(["processing"]);
    expect(screen.getByText("Processing uploaded CSV")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(postCancelStatuses).toEqual(["processing", "cancelled"]);
    expect(screen.getByText("Import cancelled")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel import" }),
    ).not.toBeInTheDocument();
  });

  it("pauses after persistent status request failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00.000Z"));
    const batch = {
      contractVersion: 1,
      id: "batch-rejected-polls",
      fileName: "rejected-polls.csv",
      status: "processing",
      counts: {
        totalRows: 0,
        parsedRows: 0,
        readyRows: 0,
        acceptedRows: 0,
        skippedRows: 0,
        pendingRows: 0,
        committedFlights: 0,
        attachedSources: 0,
      },
      createdAt: "2026-08-19T11:59:00.000Z",
      updatedAt: "2026-08-19T11:59:01.000Z",
    } as const;
    let detailRequests = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/import/batches/batch-rejected-polls")) {
        detailRequests += 1;
        if (detailRequests > 1) {
          throw new Error("Status service unavailable");
        }
        return jsonResponse({
          batch: {
            ...batch,
            rows: {
              page: 1,
              pageSize: 25,
              totalRows: 0,
              totalPages: 1,
              rows: [],
            },
          },
        });
      }
      return jsonResponse({ batches: [batch] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(
      screen.getByRole("button", { name: /rejected-polls\.csv/i }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This import is taking longer than expected. Status checks are still active with slower backoff.",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_080_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Import status checks paused after a long-running batch with no terminal update.",
    );
    expect(
      screen.getByRole("button", { name: "Resume status checks" }),
    ).toBeInTheDocument();
  });

  it("ignores an abandoned status response after its timeout pauses polling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00.000Z"));
    const batch = {
      contractVersion: 1,
      id: "batch-hung-polls",
      fileName: "hung-polls.csv",
      status: "processing",
      counts: {
        totalRows: 0,
        parsedRows: 0,
        readyRows: 0,
        acceptedRows: 0,
        skippedRows: 0,
        pendingRows: 0,
        committedFlights: 0,
        attachedSources: 0,
      },
      createdAt: "2026-08-19T11:59:00.000Z",
      updatedAt: "2026-08-19T11:59:01.000Z",
    } as const;
    let detailRequests = 0;
    const pollingSignals: AbortSignal[] = [];
    const resolvePollingRequests: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (String(input).startsWith("/api/import/batches/batch-hung-polls")) {
          detailRequests += 1;
          if (detailRequests > 1) {
            if (init?.signal) pollingSignals.push(init.signal);
            return new Promise<Response>((resolve) => {
              resolvePollingRequests.push(resolve);
            });
          }
          return Promise.resolve(
            jsonResponse({
              batch: {
                ...batch,
                rows: {
                  page: 1,
                  pageSize: 25,
                  totalRows: 0,
                  totalPages: 1,
                  rows: [],
                },
              },
            }),
          );
        }
        return Promise.resolve(jsonResponse({ batches: [batch] }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByRole("button", { name: /hung-polls\.csv/i }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_300_000);
    });

    expect(pollingSignals.length).toBeGreaterThan(1);
    expect(pollingSignals.every((signal) => signal.aborted)).toBe(true);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Import status checks paused after a long-running batch with no terminal update.",
    );
    expect(
      screen.getByRole("button", { name: "Resume status checks" }),
    ).toBeInTheDocument();

    const requestsAtPause = detailRequests;
    const resolveLatestRequest =
      resolvePollingRequests[resolvePollingRequests.length - 1];
    await act(async () => {
      resolveLatestRequest(
        jsonResponse({
          batch: {
            ...batch,
            status: "failed",
            updatedAt: "2026-08-19T12:22:00.000Z",
            error: {
              code: "processing-failed",
              message: "Late abandoned result must be ignored.",
            },
            rows: {
              page: 1,
              pageSize: 25,
              totalRows: 0,
              totalPages: 1,
              rows: [],
            },
          },
        }),
      );
      await Promise.resolve();
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Import status checks paused after a long-running batch with no terminal update.",
    );
    expect(
      screen.getByRole("button", { name: "Resume status checks" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Processing uploaded CSV")).toBeInTheDocument();
    expect(
      screen.queryByText("Late abandoned result must be ignored."),
    ).not.toBeInTheDocument();
    expect(detailRequests).toBe(requestsAtPause);
  });

  it("invalidates an in-flight status response when polling effect cleanup runs", async () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "visible";
    const visibilityStateSpy = vi.spyOn(
      document,
      "visibilityState",
      "get",
    ).mockImplementation(
      () => visibilityState,
    );
    const batch = {
      contractVersion: 1,
      id: "batch-cleaned-up-poll",
      fileName: "cleaned-up-poll.csv",
      status: "processing",
      counts: {
        totalRows: 0,
        parsedRows: 0,
        readyRows: 0,
        acceptedRows: 0,
        skippedRows: 0,
        pendingRows: 0,
        committedFlights: 0,
        attachedSources: 0,
      },
      createdAt: "2026-08-19T11:59:00.000Z",
      updatedAt: "2026-08-19T11:59:01.000Z",
    } as const;
    let detailRequests = 0;
    let pollingSignal: AbortSignal | undefined;
    let resolvePollingRequest: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (
          String(input).startsWith(
            "/api/import/batches/batch-cleaned-up-poll",
          )
        ) {
          detailRequests += 1;
          if (detailRequests > 1) {
            pollingSignal = init?.signal ?? undefined;
            return new Promise<Response>((resolve) => {
              resolvePollingRequest = resolve;
            });
          }
          return Promise.resolve(
            jsonResponse({
              batch: {
                ...batch,
                rows: {
                  page: 1,
                  pageSize: 25,
                  totalRows: 0,
                  totalPages: 1,
                  rows: [],
                },
              },
            }),
          );
        }
        return Promise.resolve(jsonResponse({ batches: [batch] }));
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(
      screen.getByRole("button", { name: /cleaned-up-poll\.csv/i }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(pollingSignal?.aborted).toBe(false);
    visibilityState = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    expect(pollingSignal?.aborted).toBe(true);

    await act(async () => {
      resolvePollingRequest?.(
        jsonResponse({
          batch: {
            ...batch,
            status: "failed",
            updatedAt: "2026-08-19T12:00:10.000Z",
            error: {
              code: "processing-failed",
              message: "Cleaned-up result must be ignored.",
            },
            rows: {
              page: 1,
              pageSize: 25,
              totalRows: 0,
              totalPages: 1,
              rows: [],
            },
          },
        }),
      );
      await Promise.resolve();
    });

    expect(screen.getByText("Processing uploaded CSV")).toBeInTheDocument();
    expect(
      screen.queryByText("Cleaned-up result must be ignored."),
    ).not.toBeInTheDocument();
    expect(detailRequests).toBe(2);
    visibilityStateSpy.mockRestore();
  });

  it("pauses a long-running batch and resumes with a fresh polling window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00.000Z"));
    const batch = {
      contractVersion: 1,
      id: "batch-long-running",
      fileName: "long-running.csv",
      status: "processing",
      counts: {
        totalRows: 0,
        parsedRows: 0,
        readyRows: 0,
        acceptedRows: 0,
        skippedRows: 0,
        pendingRows: 0,
        committedFlights: 0,
        attachedSources: 0,
      },
      createdAt: "2026-08-19T11:59:00.000Z",
      updatedAt: "2026-08-19T11:59:01.000Z",
    } as const;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/import/batches/batch-long-running")) {
        return jsonResponse({
          batch: {
            ...batch,
            rows: {
              page: 1,
              pageSize: 25,
              totalRows: 0,
              totalPages: 1,
              rows: [],
            },
          },
        });
      }
      return jsonResponse({ batches: [batch] });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(
      screen.getByRole("button", { name: /long-running\.csv/i }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(122_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This import is taking longer than expected. Status checks are still active with slower backoff.",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_080_000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Import status checks paused after a long-running batch with no terminal update.",
    );
    const resume = screen.getByRole("button", {
      name: "Resume status checks",
    });
    const requestsBeforeResume = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith("/api/import/batches/batch-long-running"),
    ).length;

    fireEvent.click(resume);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.queryByRole("button", { name: "Resume status checks" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).startsWith("/api/import/batches/batch-long-running"),
      ),
    ).toHaveLength(requestsBeforeResume + 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_199_999);
    });
    expect(
      screen.queryByRole("button", { name: "Resume status checks" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Processing uploaded CSV")).toBeInTheDocument();
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImportRouteClientView } from "./route-client";

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
  vi.unstubAllGlobals();
});

describe("development import preview", () => {
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

  it("keeps configured API mode on the authenticated upload flow", async () => {
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
    await user.click(screen.getByRole("button", { name: "Upload and process" }));

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

  it("supports drag and drop and reflects the production upload limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ batches: [] })));
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
    expect(await screen.findByText(/flightdiary\.csv/)).toBeInTheDocument();
    expect(await screen.findByText(/flightdiary\.csv/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Upload and process" }),
    ).toBeEnabled();
  });

  it("makes a valid ForeFlight upload visibly and accessibly ready", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ batches: [] })));
    render(
      <ImportRouteClientView
        data={data}
        apiEnabled
        developmentPreviewEnabled={false}
        maxFileBytes={1024 * 1024}
      />,
    );

    const upload = screen.getByRole("button", { name: "Upload and process" });
    expect(upload).toBeDisabled();
    expect(upload).toHaveClass("import-upload-button", "disabled");
    expect(upload).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText("Choose or drop a CSV to enable upload."))
      .toBeInTheDocument();

    await user.upload(
      screen.getByLabelText("Choose one supported CSV"),
      new File([foreFlightCsv], "foreflight.csv", { type: "text/csv" }),
    );

    expect(upload).toBeEnabled();
    expect(upload).toHaveClass("ready");
    expect(upload).not.toHaveClass("disabled");
    expect(screen.getByText(
      "ForeFlight Logbook Import detected. Ready to upload and process.",
    )).toBeInTheDocument();
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
      await screen.findByText(
        "Generic CSV detected. Ready to upload and process.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "Match this CSV to flight fields",
      }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Upload and process" }),
    );
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
      screen.getByRole("button", { name: "Upload and process" }),
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
      screen.getByRole("button", { name: "Upload and process" }),
    ).toBeEnabled();
    expect(screen.queryByText(/do-not-display/)).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Upload and process" }),
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
      screen.getByRole("button", { name: "Upload and process" }),
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
      screen.getByRole("button", { name: "Upload and process" }),
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
    await user.click(screen.getByRole("button", { name: "Upload and process" }));

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
      new File([`${fr24Csv},${eicar}`], "durable-eicar.csv", {
        type: "text/csv",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Upload and process" }),
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
    await user.click(
      screen.getByRole("button", { name: "Upload and process" }),
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
    await user.click(
      screen.getByRole("button", { name: "Upload and process" }),
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
    await user.click(screen.getByRole("button", { name: "Upload and process" }));

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
    await user.click(screen.getByRole("button", { name: "Upload and process" }));

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
    await user.click(screen.getByRole("button", { name: "Upload and process" }));

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
        return detailResponse;
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
    fireEvent.click(screen.getByRole("button", { name: "Upload and process" }));
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
    await user.click(screen.getByRole("button", { name: "Upload and process" }));
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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

import { describe, expect, it, vi } from "vitest";
import {
  MAP_SHARE_PREVIEW_STORAGE_KEY,
  MapSharePreviewValidationError,
  mapSharePreviewFragment,
  parseMapSharePreview,
  parseMapSharePreviewFragment,
  parsePublicMapProjection,
  readMapSharePreview,
  storeMapSharePreview,
} from "./client-preview";

const nonce = "b".repeat(32);

describe("client map share preview contract", () => {
  it("constructs a new exact DTO from the API response", () => {
    const input = preview();
    const parsed = parseMapSharePreview(input);

    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.projection).not.toBe(input.projection);
    expect(parsed.projection.owner).not.toBe(input.projection.owner);
    expect(parsed.projection.routes[0]).not.toBe(
      input.projection.routes[0],
    );
  });

  it("rejects invalid preview IDs and identity inconsistencies", () => {
    expect(() =>
      parseMapSharePreview({
        ...preview(),
        previewId: "public-capability",
      }),
    ).toThrow(MapSharePreviewValidationError);
    expect(() =>
      parseMapSharePreview({
        ...preview(),
        includeDisplayName: true,
      }),
    ).toThrow(MapSharePreviewValidationError);
  });

  it.each([
    ["preview", () => ({ ...preview(), accountId: "owner-a" })],
    [
      "projection",
      () => ({
        ...projection(),
        imports: [{ id: "private-import" }],
      }),
    ],
    [
      "owner",
      () => ({
        ...projection(),
        owner: { displayName: null, email: "owner@example.test" },
      }),
    ],
    [
      "summary",
      () => ({
        ...projection(),
        summary: {
          ...projection().summary,
          importedRows: 3,
        },
      }),
    ],
    [
      "route",
      () => ({
        ...projection(),
        routes: [
          {
            ...projection().routes[0],
            flightIds: ["private-flight"],
          },
        ],
      }),
    ],
    [
      "place",
      () => ({
        ...projection(),
        routes: [
          {
            ...projection().routes[0],
            origin: {
              ...projection().routes[0].origin,
              airportCode: "SEA",
            },
          },
        ],
      }),
    ],
  ])("rejects undeclared %s properties", (level, makeValue) => {
    expect(level).toBeTruthy();
    const value = makeValue();
    expect(() =>
      level === "preview"
        ? parseMapSharePreview(value)
        : parsePublicMapProjection(value),
    ).toThrow(MapSharePreviewValidationError);
  });

  it.each([
    ["latitude above bounds", { lat: 90.1 }],
    ["longitude below bounds", { lon: -180.1 }],
    ["non-finite latitude", { lat: Number.POSITIVE_INFINITY }],
    ["more than one decimal", { lon: -122.34 }],
    ["unsafe country", { country: "US<script>" }],
  ])("rejects %s", (_label, replacement) => {
    const value = projection();
    value.routes[0].origin = {
      ...value.routes[0].origin,
      ...replacement,
    };
    expect(() => parsePublicMapProjection(value)).toThrow(
      MapSharePreviewValidationError,
    );
  });

  it.each([
    ["unsupported kind", { kind: "charter" }],
    ["unsafe route ID", { id: "../private-route" }],
    ["zero route flight count", { flightCount: 0 }],
    ["fractional route flight count", { flightCount: 1.5 }],
  ])("rejects %s", (_label, replacement) => {
    const value = projection();
    value.routes[0] = {
      ...value.routes[0],
      ...replacement,
    } as typeof value.routes[number];
    expect(() => parsePublicMapProjection(value)).toThrow(
      MapSharePreviewValidationError,
    );
  });

  it("enforces summary and route consistency", () => {
    expect(() =>
      parsePublicMapProjection({
        ...projection(),
        summary: { flightCount: 3, routeCount: 2 },
      }),
    ).toThrow(MapSharePreviewValidationError);
    expect(() =>
      parsePublicMapProjection({
        ...projection(),
        summary: { flightCount: 4, routeCount: 1 },
      }),
    ).toThrow(MapSharePreviewValidationError);
    expect(() =>
      parsePublicMapProjection({
        ...projection(),
        summary: { flightCount: -1, routeCount: 1 },
      }),
    ).toThrow(MapSharePreviewValidationError);
    expect(() =>
      parsePublicMapProjection({
        ...projection(),
        summary: { flightCount: 3, routeCount: 1.5 },
      }),
    ).toThrow(MapSharePreviewValidationError);
    expect(() =>
      parsePublicMapProjection({
        ...projection(),
        summary: {
          flightCount: Number.MAX_SAFE_INTEGER + 1,
          routeCount: 1,
        },
      }),
    ).toThrow(MapSharePreviewValidationError);
    expect(() =>
      parsePublicMapProjection({
        ...projection(),
        routes: [
          projection().routes[0],
          projection().routes[0],
        ],
        summary: { flightCount: 3, routeCount: 2 },
      }),
    ).toThrow(MapSharePreviewValidationError);
  });

  it("stores only an exact nonce-scoped projection and retains it", () => {
    const storage = storageDouble();
    const input = projection();
    const sanitized = storeMapSharePreview(storage, nonce, input);
    const serialized = storage.setItem.mock.calls[0]?.[1];

    expect(storage.setItem).toHaveBeenCalledWith(
      MAP_SHARE_PREVIEW_STORAGE_KEY,
      expect.any(String),
    );
    expect(JSON.parse(String(serialized))).toEqual({
      nonce,
      projection: input,
    });
    expect(serialized).not.toContain("previewId");
    expect(serialized).not.toContain("account");
    expect(serialized).not.toContain("import");
    expect(sanitized).not.toBe(input);

    storage.getItem.mockReturnValue(String(serialized));
    expect(readMapSharePreview(storage, nonce)).toEqual(input);
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(readMapSharePreview(storage, null)).toEqual(input);
  });

  it("rejects mismatched or malformed tab envelopes", () => {
    const storage = storageDouble();
    storage.getItem.mockReturnValue(
      JSON.stringify({
        nonce,
        projection: projection(),
      }),
    );
    expect(() =>
      readMapSharePreview(storage, "c".repeat(32)),
    ).toThrow(MapSharePreviewValidationError);

    storage.getItem.mockReturnValue(
      JSON.stringify({
        nonce,
        projection: projection(),
        previewId: "a".repeat(64),
      }),
    );
    expect(() => readMapSharePreview(storage, nonce)).toThrow(
      MapSharePreviewValidationError,
    );
  });

  it("accepts only a single non-transmitted nonce fragment", () => {
    expect(mapSharePreviewFragment(nonce)).toBe(`#preview=${nonce}`);
    expect(parseMapSharePreviewFragment(`#preview=${nonce}`)).toBe(
      nonce,
    );
    expect(parseMapSharePreviewFragment("")).toBeNull();
    expect(() =>
      parseMapSharePreviewFragment(`#preview=${nonce}&key=public`),
    ).toThrow(MapSharePreviewValidationError);
  });
});

function preview() {
  return {
    previewId: "a".repeat(64),
    includeDisplayName: false,
    projection: projection(),
  };
}

function projection() {
  return {
    owner: { displayName: null },
    summary: { flightCount: 3, routeCount: 1 },
    routes: [
      {
        id: "coarse-route",
        kind: "private" as const,
        flightCount: 3,
        origin: { lat: 47.4, lon: -122.3, country: "US" },
        destination: { lat: 40.6, lon: -73.8, country: "US" },
      },
    ],
  };
}

function storageDouble() {
  return {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(),
    length: 0,
  };
}

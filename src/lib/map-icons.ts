// Direction cues on the map were previously rendered as Unicode text glyphs
// ("➤" / "↔") through the vector-tile glyph/font pipeline. Some glyph sources
// do not ship coverage for the Arrows/Dingbats blocks those characters live
// in, so the requested glyph silently falls back to an unrelated substitute
// (visually resembling a figure-eight in some environments) instead of the
// intended arrowhead. To make the on-map cue robust regardless of the active
// style's glyph coverage, we render the arrows as small raster icons from
// pure geometry (no canvas/DOM dependency, no external font), registered via
// `map.addImage`, and keep the legend's own Unicode glyphs untouched.

export type DirectionIconShape = "one-way" | "both";

const ICON_WIDTH = 28;
const ICON_HEIGHT = 16;
const HALO_MARGIN = 2.4;
const HALO_COLOR = "#03101a";
const HALO_OPACITY = 0.9;
const SUPERSAMPLE = 3;

type Triangle = [number, number, number, number, number, number];

export type DirectionIconImage = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

export const DIRECTION_ICON_COLORS = {
  private: "#fff0b3",
  commercial: "#bafff6",
} as const;

export const DIRECTION_ICON_IDS = {
  oneWayPrivate: "route-direction-one-way-private",
  oneWayCommercial: "route-direction-one-way-commercial",
  bothPrivate: "route-direction-both-private",
  bothCommercial: "route-direction-both-commercial",
} as const;

/**
 * Triangles for each shape, drawn in local icon pixel space. "one-way" is a
 * single arrowhead pointing along the icon's +x axis; MapLibre's
 * `icon-rotation-alignment: "map"` combined with line placement rotates this
 * to follow each route's true forward travel direction automatically, the
 * same way one-way street arrows are conventionally authored in vector-tile
 * styles. "both" is a mirrored pair of arrowheads joined by a bar so it is
 * point-symmetric (identical under a 180° rotation), matching a bidirectional
 * route where either line-drawing direction is equally valid.
 */
function trianglesForShape(shape: DirectionIconShape): Triangle[] {
  const cy = ICON_HEIGHT / 2;
  if (shape === "one-way") {
    return [[3, cy - 6, 3, cy + 6, ICON_WIDTH - 3, cy]];
  }
  const barHalfHeight = 1.6;
  return [
    [3, cy, 11, cy - 6, 11, cy + 6],
    [ICON_WIDTH - 3, cy, ICON_WIDTH - 11, cy - 6, ICON_WIDTH - 11, cy + 6],
    [11, cy - barHalfHeight, ICON_WIDTH - 11, cy - barHalfHeight, 11, cy + barHalfHeight],
    [ICON_WIDTH - 11, cy - barHalfHeight, ICON_WIDTH - 11, cy + barHalfHeight, 11, cy + barHalfHeight],
  ];
}

function dilateTriangle(triangle: Triangle, margin: number): Triangle {
  const [ax, ay, bx, by, cx, cy] = triangle;
  const centerX = (ax + bx + cx) / 3;
  const centerY = (ay + by + cy) / 3;
  const push = (x: number, y: number): [number, number] => {
    const dx = x - centerX;
    const dy = y - centerY;
    const length = Math.hypot(dx, dy) || 1;
    return [x + (dx / length) * margin, y + (dy / length) * margin];
  };
  const [ax2, ay2] = push(ax, ay);
  const [bx2, by2] = push(bx, by);
  const [cx2, cy2] = push(cx, cy);
  return [ax2, ay2, bx2, by2, cx2, cy2];
}

function edgeFunction(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

function pointInTriangle(px: number, py: number, triangle: Triangle): boolean {
  const [ax, ay, bx, by, cx, cy] = triangle;
  const d1 = edgeFunction(ax, ay, bx, by, px, py);
  const d2 = edgeFunction(bx, by, cx, cy, px, py);
  const d3 = edgeFunction(cx, cy, ax, ay, px, py);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function coverage(px: number, py: number, triangles: Triangle[]): number {
  let hits = 0;
  for (let sampleY = 0; sampleY < SUPERSAMPLE; sampleY++) {
    for (let sampleX = 0; sampleX < SUPERSAMPLE; sampleX++) {
      const x = px + (sampleX + 0.5) / SUPERSAMPLE;
      const y = py + (sampleY + 0.5) / SUPERSAMPLE;
      if (triangles.some((triangle) => pointInTriangle(x, y, triangle))) hits++;
    }
  }
  return hits / (SUPERSAMPLE * SUPERSAMPLE);
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  const value = Number.parseInt(normalized, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * Renders a direction-cue icon as a plain RGBA raster (not an SDF), so the
 * fill color is baked in per route `kind` up front, matching how the
 * previous text-based cue picked a fixed color per kind via `text-color`.
 */
export function createDirectionIconImage(
  shape: DirectionIconShape,
  fillColor: string,
): DirectionIconImage {
  const fillTriangles = trianglesForShape(shape);
  const haloTriangles = fillTriangles.map((triangle) =>
    dilateTriangle(triangle, HALO_MARGIN),
  );
  const [fr, fg, fb] = hexToRgb(fillColor);
  const [hr, hg, hb] = hexToRgb(HALO_COLOR);
  const data = new Uint8ClampedArray(ICON_WIDTH * ICON_HEIGHT * 4);

  for (let y = 0; y < ICON_HEIGHT; y++) {
    for (let x = 0; x < ICON_WIDTH; x++) {
      const index = (y * ICON_WIDTH + x) * 4;
      const fillCoverage = coverage(x, y, fillTriangles);
      if (fillCoverage > 0) {
        data[index] = fr;
        data[index + 1] = fg;
        data[index + 2] = fb;
        data[index + 3] = Math.round(fillCoverage * 255);
        continue;
      }
      const haloCoverage = coverage(x, y, haloTriangles);
      data[index] = hr;
      data[index + 1] = hg;
      data[index + 2] = hb;
      data[index + 3] = Math.round(haloCoverage * HALO_OPACITY * 255);
    }
  }

  return { width: ICON_WIDTH, height: ICON_HEIGHT, data };
}

export function buildDirectionIconSet(): Array<{
  id: string;
  image: DirectionIconImage;
}> {
  return [
    {
      id: DIRECTION_ICON_IDS.oneWayPrivate,
      image: createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.private),
    },
    {
      id: DIRECTION_ICON_IDS.oneWayCommercial,
      image: createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.commercial),
    },
    {
      id: DIRECTION_ICON_IDS.bothPrivate,
      image: createDirectionIconImage("both", DIRECTION_ICON_COLORS.private),
    },
    {
      id: DIRECTION_ICON_IDS.bothCommercial,
      image: createDirectionIconImage("both", DIRECTION_ICON_COLORS.commercial),
    },
  ];
}

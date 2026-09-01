import { describe, expect, it } from "vitest";
import {
  buildDirectionIconSet,
  createDirectionIconImage,
  DIRECTION_ICON_COLORS,
  DIRECTION_ICON_IDS,
  type DirectionIconImage,
} from "./map-icons";

/** Number of opaque (fill, not just halo) pixels in a given column. */
function filledHeightAt(image: DirectionIconImage, x: number): number {
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    const alpha = image.data[(y * image.width + x) * 4 + 3];
    if (alpha > 200) count++;
  }
  return count;
}

function pixelAt(
  image: DirectionIconImage,
  x: number,
  y: number,
): [number, number, number, number] {
  const index = (y * image.width + x) * 4;
  return [image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3]];
}

function isPointSymmetric(image: DirectionIconImage): boolean {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const [, , , alpha] = pixelAt(image, x, y);
      const mirroredX = image.width - 1 - x;
      const mirroredY = image.height - 1 - y;
      const [, , , mirroredAlpha] = pixelAt(image, mirroredX, mirroredY);
      if (Math.abs(alpha - mirroredAlpha) > 2) return false;
    }
  }
  return true;
}

describe("direction icon rasters", () => {
  it("draws the one-way icon as a single arrowhead: wide at the trailing edge, narrow to a point at the leading edge", () => {
    const icon = createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.commercial);

    const trailingHeight = filledHeightAt(icon, 4);
    const midHeight = filledHeightAt(icon, Math.round(icon.width / 2));
    const leadingHeight = filledHeightAt(icon, icon.width - 4);

    expect(trailingHeight).toBeGreaterThan(midHeight);
    expect(midHeight).toBeGreaterThan(leadingHeight);
    // The very tip should collapse to (at most) a sliver, not another bulge -
    // this is the discriminating check against the "figure-eight" bug, where
    // a fallback glyph rendered two similarly sized lobes instead of a single
    // directional point.
    expect(leadingHeight).toBeLessThanOrEqual(2);
  });

  it("is NOT point-symmetric for one-way, so its orientation is unambiguous under MapLibre's line-direction auto-rotation", () => {
    const icon = createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.commercial);
    expect(isPointSymmetric(icon)).toBe(false);
  });

  it("draws the bidirectional icon as two mirrored arrowheads joined by a bar, symmetric under 180-degree rotation", () => {
    const icon = createDirectionIconImage("both", DIRECTION_ICON_COLORS.commercial);

    // Point symmetry is required: a "both" route's line geometry can be
    // drawn in either direction depending on which flight leg happened to be
    // first in the data, so the icon must look identical either way.
    expect(isPointSymmetric(icon)).toBe(true);

    // Unlike the one-way icon, both ends should have a comparable amount of
    // fill (mirrored arrowheads), and the very center should also carry some
    // fill (the connecting bar) rather than collapsing to nothing.
    const leftEndHeight = filledHeightAt(icon, 4);
    const rightEndHeight = filledHeightAt(icon, icon.width - 4);
    const centerHeight = filledHeightAt(icon, Math.round(icon.width / 2));

    expect(leftEndHeight).toBeGreaterThan(0);
    expect(rightEndHeight).toBeGreaterThan(0);
    expect(Math.abs(leftEndHeight - rightEndHeight)).toBeLessThanOrEqual(1);
    expect(centerHeight).toBeGreaterThan(0);
  });

  it("bakes the route-kind fill color into opaque pixels, distinguishing private from commercial routes", () => {
    const privateIcon = createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.private);
    const commercialIcon = createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.commercial);

    // Sample a pixel near the wide trailing edge, well inside the shape.
    const [pr, pg, pb, pa] = pixelAt(privateIcon, 4, Math.round(privateIcon.height / 2));
    const [cr, cg, cb, ca] = pixelAt(commercialIcon, 4, Math.round(commercialIcon.height / 2));

    expect(pa).toBeGreaterThan(200);
    expect(ca).toBeGreaterThan(200);
    expect([pr, pg, pb]).toEqual([0xff, 0xf0, 0xb3]);
    expect([cr, cg, cb]).toEqual([0xba, 0xff, 0xf6]);
    expect([pr, pg, pb]).not.toEqual([cr, cg, cb]);
  });

  it("surrounds the fill with a translucent halo rather than a hard edge, so icons stay legible over any basemap color", () => {
    const icon = createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.commercial);
    const midY = Math.round(icon.height / 2);

    // Just past the trailing-edge base (x=3) there should still be some
    // partially-transparent halo coverage rather than an abrupt cutoff to
    // fully transparent background.
    const [, , , edgeAlpha] = pixelAt(icon, 1, midY);
    const [, , , farAlpha] = pixelAt(icon, 0, 0);

    expect(edgeAlpha).toBeGreaterThan(0);
    expect(farAlpha).toBe(0);
  });

  it("registers exactly four uniquely-identified, correctly-shaped icons covering every direction/kind combination", () => {
    const icons = buildDirectionIconSet();

    expect(icons).toHaveLength(4);
    const ids = icons.map(({ id }) => id).sort();
    expect(ids).toEqual(
      [
        DIRECTION_ICON_IDS.oneWayPrivate,
        DIRECTION_ICON_IDS.oneWayCommercial,
        DIRECTION_ICON_IDS.bothPrivate,
        DIRECTION_ICON_IDS.bothCommercial,
      ].sort(),
    );
    expect(new Set(ids).size).toBe(4);

    for (const { image } of icons) {
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
      expect(image.data.length).toBe(image.width * image.height * 4);
    }
  });
});

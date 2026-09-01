import { describe, expect, it } from "vitest";
import {
  buildDirectionIconSet,
  createDirectionIconImage,
  DIRECTION_ICON_COLORS,
  DIRECTION_ICON_IDS,
  type DirectionIconImage,
} from "./map-icons";

function pixelAt(
  image: DirectionIconImage,
  x: number,
  y: number,
): [number, number, number, number] {
  const index = (y * image.width + x) * 4;
  return [image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3]];
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/**
 * True only for pixels painted with the icon's baked-in fill color and with
 * majority coverage. Alpha alone is not a fill test: the dark halo is drawn
 * at 0.9 opacity (alpha 230 at full coverage), so an alpha threshold would
 * silently count halo pixels as shape and make the geometry assertions below
 * pass for almost any blob.
 */
function isFilledPixel(
  image: DirectionIconImage,
  x: number,
  y: number,
  fillColor: string,
): boolean {
  const [red, green, blue, alpha] = pixelAt(image, x, y);
  const [fillRed, fillGreen, fillBlue] = hexToRgb(fillColor);
  return (
    alpha >= 128 &&
    red === fillRed &&
    green === fillGreen &&
    blue === fillBlue
  );
}

/** Number of fill (not halo) pixels in a given column. */
function filledHeightAt(
  image: DirectionIconImage,
  x: number,
  fillColor: string,
): number {
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    if (isFilledPixel(image, x, y, fillColor)) count++;
  }
  return count;
}

/** Number of pixels in a column with any strong alpha, halo included. */
function opaqueHeightAt(image: DirectionIconImage, x: number): number {
  let count = 0;
  for (let y = 0; y < image.height; y++) {
    if (pixelAt(image, x, y)[3] >= 128) count++;
  }
  return count;
}

/** The column that maps onto `x` under a 180-degree rotation of the icon. */
function mirroredColumn(image: DirectionIconImage, x: number): number {
  return image.width - 1 - x;
}

function isPointSymmetric(image: DirectionIconImage): boolean {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const [, , , alpha] = pixelAt(image, x, y);
      const mirroredX = mirroredColumn(image, x);
      const mirroredY = image.height - 1 - y;
      const [, , , mirroredAlpha] = pixelAt(image, mirroredX, mirroredY);
      if (Math.abs(alpha - mirroredAlpha) > 2) return false;
    }
  }
  return true;
}

const TRAILING_COLUMN = 4;

describe("direction icon rasters", () => {
  it("measures shape fill by baked-in fill color, never by halo alpha", () => {
    const icon = createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.commercial);
    const [haloRed, haloGreen, haloBlue] = hexToRgb("#03101a");

    // The halo is opaque enough (alpha 230 at full coverage) that an
    // alpha-only measurement would count it, so the fill measurement must be
    // strictly smaller than the alpha-only one somewhere along the shape.
    expect(filledHeightAt(icon, TRAILING_COLUMN, DIRECTION_ICON_COLORS.commercial))
      .toBeLessThan(opaqueHeightAt(icon, TRAILING_COLUMN));

    const haloPixels: Array<[number, number, number, number]> = [];
    for (let y = 0; y < icon.height; y++) {
      for (let x = 0; x < icon.width; x++) {
        const pixel = pixelAt(icon, x, y);
        if (
          pixel[0] === haloRed &&
          pixel[1] === haloGreen &&
          pixel[2] === haloBlue &&
          pixel[3] >= 128
        ) {
          haloPixels.push(pixel);
          expect(
            isFilledPixel(icon, x, y, DIRECTION_ICON_COLORS.commercial),
          ).toBe(false);
        }
      }
    }
    expect(haloPixels.length).toBeGreaterThan(0);
    expect(Math.max(...haloPixels.map((pixel) => pixel[3]))).toBeGreaterThan(200);

    // A fill measurement keyed on the other route kind's color must find
    // nothing, proving the helper discriminates on color rather than alpha.
    expect(
      filledHeightAt(icon, TRAILING_COLUMN, DIRECTION_ICON_COLORS.private),
    ).toBe(0);
  });

  it("draws the one-way icon as a single arrowhead: wide at the trailing edge, narrow to a point at the leading edge", () => {
    const icon = createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.commercial);
    const fill = DIRECTION_ICON_COLORS.commercial;

    const trailingHeight = filledHeightAt(icon, TRAILING_COLUMN, fill);
    const midHeight = filledHeightAt(icon, Math.round(icon.width / 2), fill);
    const leadingHeight = filledHeightAt(
      icon,
      mirroredColumn(icon, TRAILING_COLUMN),
      fill,
    );

    expect(trailingHeight).toBeGreaterThan(midHeight);
    expect(midHeight).toBeGreaterThan(leadingHeight);
    // The very tip should collapse to (at most) a sliver, not another bulge -
    // this is the discriminating check against the "figure-eight" bug, where
    // a fallback glyph rendered two similarly sized lobes instead of a single
    // directional point.
    expect(leadingHeight).toBeLessThanOrEqual(3);
    expect(leadingHeight * 3).toBeLessThan(trailingHeight);
  });

  it("is NOT point-symmetric for one-way, so its orientation is unambiguous under MapLibre's line-direction auto-rotation", () => {
    const icon = createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.commercial);
    expect(isPointSymmetric(icon)).toBe(false);
  });

  it("draws the bidirectional icon as two mirrored arrowheads joined by a bar, symmetric under 180-degree rotation", () => {
    const icon = createDirectionIconImage("both", DIRECTION_ICON_COLORS.commercial);
    const fill = DIRECTION_ICON_COLORS.commercial;

    // Point symmetry is required: a "both" route's line geometry can be
    // drawn in either direction depending on which flight leg happened to be
    // first in the data, so the icon must look identical either way.
    expect(isPointSymmetric(icon)).toBe(true);

    // Unlike the one-way icon, both ends should have a comparable amount of
    // fill (mirrored arrowheads), and the very center should also carry some
    // fill (the connecting bar) rather than collapsing to nothing. The two
    // sampled columns are true mirror images of one another, so an asymmetric
    // shape cannot slip through by sampling misaligned columns.
    const leftEndHeight = filledHeightAt(icon, TRAILING_COLUMN, fill);
    const rightEndHeight = filledHeightAt(
      icon,
      mirroredColumn(icon, TRAILING_COLUMN),
      fill,
    );
    const centerHeight = filledHeightAt(icon, Math.round(icon.width / 2), fill);

    expect(leftEndHeight).toBeGreaterThan(0);
    expect(rightEndHeight).toBeGreaterThan(0);
    expect(leftEndHeight).toBe(rightEndHeight);
    expect(centerHeight).toBeGreaterThan(0);
  });

  it("bakes the route-kind fill color into opaque pixels, distinguishing private from commercial routes", () => {
    const privateIcon = createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.private);
    const commercialIcon = createDirectionIconImage("one-way", DIRECTION_ICON_COLORS.commercial);

    // Sample a pixel near the wide trailing edge, well inside the shape.
    const [pr, pg, pb, pa] = pixelAt(privateIcon, 4, Math.round(privateIcon.height / 2));
    const [cr, cg, cb, ca] = pixelAt(commercialIcon, 4, Math.round(commercialIcon.height / 2));

    expect(pa).toBe(255);
    expect(ca).toBe(255);
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

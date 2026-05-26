import { describe, expect, it } from "vitest";

import {
  displayBoxToZoteroRect,
  sourceBboxesToZoteroRects,
} from "../../../../src/services/annotations/annotationGeometry";
import {
  CoordOrigin,
  type BoundingBox,
} from "../../../../react/types/citations";
import type { PageGeometry } from "../../../../src/beaver-extract/types";

const baseGeometry: PageGeometry = {
  viewBox: [0, 0, 400, 600],
  width: 400,
  height: 600,
  rotation: 0,
};

const sourceBox: BoundingBox = {
  l: 10,
  t: 20,
  r: 110,
  b: 50,
  coord_origin: CoordOrigin.TOPLEFT,
};

function geometry(overrides: Partial<PageGeometry>): PageGeometry {
  return { ...baseGeometry, ...overrides };
}

describe("annotationGeometry", () => {
  describe("sourceBboxesToZoteroRects", () => {
    it("converts source bboxes for each page rotation", () => {
      expect(sourceBboxesToZoteroRects([sourceBox], geometry({ rotation: 0 }))).toEqual([
        [10, 550, 110, 580],
      ]);
      expect(sourceBboxesToZoteroRects([sourceBox], geometry({ rotation: 90 }))).toEqual([
        [20, 10, 50, 110],
      ]);
      expect(sourceBboxesToZoteroRects([sourceBox], geometry({ rotation: 180 }))).toEqual([
        [290, 20, 390, 50],
      ]);
      expect(sourceBboxesToZoteroRects([sourceBox], geometry({ rotation: 270 }))).toEqual([
        [350, 490, 380, 590],
      ]);
    });

    it("converts bboxes from rotated display pages back to unrotated PDF space", () => {
      expect(
        sourceBboxesToZoteroRects(
          [
            {
              l: 411.9,
              t: 665.9,
              r: 434.4,
              b: 676.5,
              coord_origin: CoordOrigin.TOPLEFT,
            },
          ],
          {
            viewBox: [0, 0, 486, 711],
            width: 486,
            height: 711,
            rotation: 180,
          },
        ),
      ).toEqual([[51.60000000000002, 665.9, 74.10000000000002, 676.5]]);

      expect(
        sourceBboxesToZoteroRects(
          [
            {
              l: 34,
              t: 355.5,
              r: 44.6,
              b: 434.5,
              coord_origin: CoordOrigin.TOPLEFT,
            },
          ],
          {
            viewBox: [0, 0, 486, 711],
            width: 486,
            height: 711,
            rotation: 270,
          },
        ),
      ).toEqual([[51.5, 666.4, 130.5, 677]]);
    });

    it("adds the viewBox offset after converting to PDF user space", () => {
      expect(
        sourceBboxesToZoteroRects(
          [sourceBox],
          geometry({ viewBox: [10, 20, 410, 620] }),
        ),
      ).toEqual([[20, 570, 120, 600]]);
    });

    it("supports explicit bottom-left legacy bboxes for each page rotation", () => {
      const bottomLeftBox: BoundingBox = {
        l: 15,
        b: 25,
        r: 55,
        t: 75,
        coord_origin: CoordOrigin.BOTTOMLEFT,
      };

      expect(sourceBboxesToZoteroRects([bottomLeftBox], geometry({ rotation: 0 }))).toEqual([
        [15, 25, 55, 75],
      ]);
      expect(sourceBboxesToZoteroRects([bottomLeftBox], geometry({ rotation: 90 }))).toEqual([
        [325, 15, 375, 55],
      ]);
      expect(sourceBboxesToZoteroRects([bottomLeftBox], geometry({ rotation: 180 }))).toEqual([
        [345, 525, 385, 575],
      ]);
      expect(sourceBboxesToZoteroRects([bottomLeftBox], geometry({ rotation: 270 }))).toEqual([
        [25, 545, 75, 585],
      ]);
    });

    it("filters malformed converted rects", () => {
      expect(
        sourceBboxesToZoteroRects(
          [
            sourceBox,
            {
              l: Number.NaN,
              t: 20,
              r: 110,
              b: 50,
              coord_origin: CoordOrigin.TOPLEFT,
            },
          ],
          baseGeometry,
        ),
      ).toEqual([[10, 550, 110, 580]]);
    });
  });

  describe("displayBoxToZoteroRect", () => {
    it("converts display-frame note boxes for rotated pages", () => {
      const displayBox = { l: 12, t: 291, r: 30, b: 309 };

      expect(displayBoxToZoteroRect(displayBox, geometry({ rotation: 0 }))).toEqual([
        12, 291, 30, 309,
      ]);
      expect(displayBoxToZoteroRect(displayBox, geometry({ rotation: 90 }))).toEqual([
        291, 12, 309, 30,
      ]);
      expect(displayBoxToZoteroRect(displayBox, geometry({ rotation: 180 }))).toEqual([
        370, 291, 388, 309,
      ]);
      expect(displayBoxToZoteroRect(displayBox, geometry({ rotation: 270 }))).toEqual([
        91, 570, 109, 588,
      ]);
    });
  });
});

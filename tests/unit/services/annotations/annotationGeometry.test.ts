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
        [290, 550, 390, 580],
      ]);
      expect(sourceBboxesToZoteroRects([sourceBox], geometry({ rotation: 270 }))).toEqual([
        [550, 290, 580, 390],
      ]);
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

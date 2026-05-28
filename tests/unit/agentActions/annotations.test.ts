import { describe, expect, it } from "vitest";

import {
  normalizeBoundingBox,
  normalizePageLocations,
} from "../../../react/types/agentActions/annotations";
import { CoordOrigin } from "../../../react/types/citations";

describe("annotation action normalization", () => {
  describe("normalizeBoundingBox", () => {
    it("normalizes tuple rects as top-left extraction bboxes", () => {
      expect(normalizeBoundingBox([1, 2, 3, 4])).toEqual({
        l: 1,
        t: 2,
        r: 3,
        b: 4,
        coord_origin: CoordOrigin.TOPLEFT,
      });
    });

    it("defaults object bboxes without an origin to top-left", () => {
      expect(normalizeBoundingBox({ l: 1, t: 2, r: 3, b: 4 })).toEqual({
        l: 1,
        t: 2,
        r: 3,
        b: 4,
        coord_origin: CoordOrigin.TOPLEFT,
      });
    });

    it("preserves explicit bottom-left legacy input", () => {
      expect(
        normalizeBoundingBox({
          l: 1,
          t: 2,
          r: 3,
          b: 4,
          coord_origin: CoordOrigin.BOTTOMLEFT,
        }),
      ).toEqual({
        l: 1,
        t: 2,
        r: 3,
        b: 4,
        coord_origin: CoordOrigin.BOTTOMLEFT,
      });
    });
  });

  describe("normalizePageLocations", () => {
    it("normalizes tuple rects inside page locations", () => {
      expect(
        normalizePageLocations({
          locations: [{ page_idx: 2, bboxes: [[10, 20, 30, 40]] }],
        }),
      ).toEqual([
        {
          page_idx: 2,
          boxes: [
            {
              l: 10,
              t: 20,
              r: 30,
              b: 40,
              coord_origin: CoordOrigin.TOPLEFT,
            },
          ],
        },
      ]);
    });

    it("preserves reading_order_index (snake_case)", () => {
      const out = normalizePageLocations({
        locations: [
          { page_idx: 3, boxes: [], reading_order_index: 5 },
        ],
      });
      expect(out?.[0]).toMatchObject({ page_idx: 3, reading_order_index: 5 });
    });

    it("accepts camelCase readingOrderIndex from the wire", () => {
      const out = normalizePageLocations({
        locations: [
          { page_idx: 3, boxes: [], readingOrderIndex: 9 },
        ],
      });
      expect(out?.[0]).toMatchObject({ page_idx: 3, reading_order_index: 9 });
    });

    it("omits reading_order_index when neither field is present", () => {
      const out = normalizePageLocations({
        locations: [{ page_idx: 1, boxes: [] }],
      });
      expect(out?.[0].reading_order_index).toBeUndefined();
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/services/agentDataProvider/utils", () => ({
  getAttachmentFileStatus: vi.fn(),
}));

import {
  computeNoteRect,
  convertHighlightBoxesToRects,
} from "../../../../src/services/annotations/createAnnotation";
import {
  CoordOrigin,
  type BoundingBox,
} from "../../../../react/types/citations";
import type { NotePosition } from "../../../../react/types/agentActions/annotations";
import type { PageGeometry } from "../../../../src/beaver-extract/types";

const baseGeometry: PageGeometry = {
  viewBox: [0, 0, 400, 600],
  width: 400,
  height: 600,
  rotation: 0,
};

const rotationFixtureBox: BoundingBox = {
  l: 10,
  t: 420,
  r: 110,
  b: 450,
  coord_origin: CoordOrigin.TOPLEFT,
};

function geometry(overrides: Partial<PageGeometry>): PageGeometry {
  return { ...baseGeometry, ...overrides };
}

describe("createAnnotation geometry primitives", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("convertHighlightBoxesToRects", () => {
    it("converts a top-left bbox on an unrotated page", () => {
      const rects = convertHighlightBoxesToRects(
        [
          {
            l: 10,
            t: 20,
            r: 110,
            b: 50,
            coord_origin: CoordOrigin.TOPLEFT,
          },
        ],
        baseGeometry,
      );

      expect(rects).toEqual([[10, 550, 110, 580]]);
    });

    it("adds the viewBox offset after conversion", () => {
      const rects = convertHighlightBoxesToRects(
        [
          {
            l: 10,
            t: 20,
            r: 110,
            b: 50,
            coord_origin: CoordOrigin.TOPLEFT,
          },
        ],
        geometry({ viewBox: [10, 20, 410, 620] }),
      );

      expect(rects).toEqual([[20, 570, 120, 600]]);
    });

    it("applies 90-degree page rotation", () => {
      const rects = convertHighlightBoxesToRects(
        [rotationFixtureBox],
        geometry({ rotation: 90 }),
      );

      expect(rects).toEqual([[220, 10, 250, 110]]);
    });

    it("applies 180-degree page rotation", () => {
      const rects = convertHighlightBoxesToRects(
        [rotationFixtureBox],
        geometry({ rotation: 180 }),
      );

      expect(rects).toEqual([[290, 420, 390, 450]]);
    });

    it("applies 270-degree page rotation", () => {
      const rects = convertHighlightBoxesToRects(
        [rotationFixtureBox],
        geometry({ rotation: 270 }),
      );

      expect(rects).toEqual([[150, 490, 180, 590]]);
    });

    it("passes bottom-left input through unchanged before the viewBox offset", () => {
      const rects = convertHighlightBoxesToRects(
        [
          {
            l: 15,
            b: 25,
            r: 55,
            t: 75,
            coord_origin: CoordOrigin.BOTTOMLEFT,
          },
        ],
        baseGeometry,
      );

      expect(rects).toEqual([[15, 25, 55, 75]]);
    });

    it("returns an empty array for empty input", () => {
      expect(convertHighlightBoxesToRects([], baseGeometry)).toEqual([]);
    });

    it("filters malformed rects while keeping valid rects", () => {
      const rects = convertHighlightBoxesToRects(
        [
          {
            l: 15,
            b: 25,
            r: 55,
            t: 75,
            coord_origin: CoordOrigin.BOTTOMLEFT,
          },
          {
            l: Number.NaN,
            b: 25,
            r: 55,
            t: 75,
            coord_origin: CoordOrigin.BOTTOMLEFT,
          },
          {
            l: 15,
            b: 25,
            r: Number.POSITIVE_INFINITY,
            t: 75,
            coord_origin: CoordOrigin.BOTTOMLEFT,
          },
        ],
        baseGeometry,
      );

      expect(rects).toEqual([[15, 25, 55, 75]]);
    });
  });

  describe("computeNoteRect", () => {
    const leftNote: NotePosition = {
      page_index: 0,
      side: "left",
      x: 0,
      y: 100,
    };

    it("places a left-side note with fixed margin and size", () => {
      expect(computeNoteRect(leftNote, baseGeometry)).toEqual([
        12, 100, 30, 118,
      ]);
    });

    it("places a right-side note with fixed margin and size", () => {
      expect(
        computeNoteRect({ ...leftNote, side: "right" }, baseGeometry),
      ).toEqual([370, 100, 388, 118]);
    });

    it("applies 90-degree page rotation to notes", () => {
      expect(computeNoteRect(leftNote, geometry({ rotation: 90 }))).toEqual([
        282, 12, 300, 30,
      ]);
    });

    it("applies 180-degree page rotation to notes", () => {
      expect(computeNoteRect(leftNote, geometry({ rotation: 180 }))).toEqual([
        370, 482, 388, 500,
      ]);
    });

    it("applies 270-degree page rotation to notes", () => {
      expect(computeNoteRect(leftNote, geometry({ rotation: 270 }))).toEqual([
        100, 570, 118, 588,
      ]);
    });

    it("adds the viewBox offset to note rects", () => {
      expect(
        computeNoteRect(leftNote, geometry({ viewBox: [5, 7, 405, 607] })),
      ).toEqual([17, 107, 35, 125]);
    });
  });
});

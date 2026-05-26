import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/services/agentDataProvider/utils", () => ({
  getAttachmentFileStatus: vi.fn(),
}));

import {
  buildSortIndex,
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

// Fits inside both the unrotated portrait frame (400x600) and the
// MuPDF /Rotate-applied landscape frame (600x400), so the same fixture
// works for every rotation case without crossing page edges.
const rotationFixtureBox: BoundingBox = {
  l: 10,
  t: 20,
  r: 110,
  b: 50,
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

      expect(rects).toEqual([[20, 10, 50, 110]]);
    });

    it("applies 180-degree page rotation", () => {
      const rects = convertHighlightBoxesToRects(
        [rotationFixtureBox],
        geometry({ rotation: 180 }),
      );

      expect(rects).toEqual([[290, 20, 390, 50]]);
    });

    it("applies 270-degree page rotation", () => {
      const rects = convertHighlightBoxesToRects(
        [rotationFixtureBox],
        geometry({ rotation: 270 }),
      );

      expect(rects).toEqual([[350, 490, 380, 590]]);
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

  describe("buildSortIndex", () => {
    it("clamps negative coordinates to Zotero's non-negative sort-index format", () => {
      expect(buildSortIndex(1, [-120, 404, 20, 420])).toBe("00001|000404|00000");
    });
  });

  describe("computeNoteRect", () => {
    const leftNote: NotePosition = {
      page_index: 0,
      side: "left",
      x: 0,
      y: 100,
      coord_origin: CoordOrigin.TOPLEFT,
    };
    const bottomLeftNote: NotePosition = {
      ...leftNote,
      coord_origin: CoordOrigin.BOTTOMLEFT,
    };

    it("places a top-left-origin left-side note using y as the anchor center", () => {
      expect(computeNoteRect(leftNote, baseGeometry)).toEqual([
        12, 491, 30, 509,
      ]);
    });

    it("places a top-left-origin right-side note using y as the anchor center", () => {
      expect(
        computeNoteRect({ ...leftNote, side: "right" }, baseGeometry),
      ).toEqual([370, 491, 388, 509]);
    });

    it("supports bottom-left-origin note positions", () => {
      expect(computeNoteRect(bottomLeftNote, baseGeometry)).toEqual([
        12, 91, 30, 109,
      ]);
    });

    // `notePosition` is expressed in the **display** (post-/Rotate)
    // frame, so the stored rect is the inverse of PDF.js's viewport
    // transform — `side: 'left'` always lands on the visible left edge
    // of the rendered page regardless of /Rotate. The expected rects
    // below are derived from `viewport.convertToPdfPoint` for each
    // rotation case.
    it("applies 90-degree page rotation to notes", () => {
      expect(computeNoteRect(bottomLeftNote, geometry({ rotation: 90 }))).toEqual([
        291, 12, 309, 30,
      ]);
    });

    it("applies 180-degree page rotation to notes", () => {
      expect(computeNoteRect(bottomLeftNote, geometry({ rotation: 180 }))).toEqual([
        370, 491, 388, 509,
      ]);
    });

    it("applies 270-degree page rotation to notes", () => {
      expect(computeNoteRect(bottomLeftNote, geometry({ rotation: 270 }))).toEqual([
        91, 570, 109, 588,
      ]);
    });

    it("adds the viewBox offset to note rects", () => {
      expect(
        computeNoteRect(leftNote, geometry({ viewBox: [5, 7, 405, 607] })),
      ).toEqual([17, 498, 35, 516]);
    });
  });
});

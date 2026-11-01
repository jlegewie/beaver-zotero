import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/services/agentDataProvider/utils", () => ({
  getAttachmentFileStatus: vi.fn(),
}));

import {
  buildSortIndex,
  computeNoteRect,
  buildHighlightPlacement,
  convertHighlightBoxesToRects,
  HighlightPageSpanError,
  highlightPageSpan,
} from "../../../../src/services/annotations/createAnnotation";
import {
  CoordOrigin,
  type BoundingBox,
} from "@beaver/agent-core/types/citations";
import type { NotePosition } from "@beaver/agent-core/types/agentActions/annotations";
import type { PageGeometry } from "@beaver/agent-core/extract/types";

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
    const SORT_INDEX_REGEX = /^\d{5}\|\d{6}\|\d{5}$/;

    it("emits page|offset|top in the canonical Zotero PDF format", () => {
      // viewBox [0,0,400,600], rect top = 420 → displayTop = 600 - 420 = 180.
      // No reading-order offset supplied, so offset falls back to displayTop.
      expect(
        buildSortIndex({
          pageIndex: 1,
          viewBox: [0, 0, 400, 600],
          rect: [50, 404, 200, 420],
        }),
      ).toBe("00001|000180|00180");
    });

    it("uses the supplied reading-order offset as the offset", () => {
      // Same rect/viewBox; readingOrderOffset=7 wins over displayTop in field 2.
      // Field 3 is still displayTop (180).
      expect(
        buildSortIndex({
          pageIndex: 1,
          viewBox: [0, 0, 400, 600],
          rect: [50, 404, 200, 420],
          readingOrderOffset: 7,
        }),
      ).toBe("00001|000007|00180");
    });

    it("uses displayTop, not left-x, in the third field", () => {
      // Two annotations on the same logical line should NOT differ in field 3
      // by their left-x — they sort by displayTop instead. With identical
      // rect[3] and different rect[0], field 3 stays the same.
      const left = buildSortIndex({
        pageIndex: 0,
        viewBox: [0, 0, 400, 600],
        rect: [50, 404, 200, 420],
      });
      const right = buildSortIndex({
        pageIndex: 0,
        viewBox: [0, 0, 400, 600],
        rect: [250, 404, 380, 420],
      });
      expect(left).toBe(right);
    });

    it("preserves reading order across two sentences in the same paragraph", () => {
      // Two highlights in the same visual paragraph; backend assigns
      // consecutive reading-order indices. The earlier one must lex-sort
      // before the later one regardless of their rect y values.
      const sentenceA = buildSortIndex({
        pageIndex: 6,
        viewBox: [0, 0, 400, 600],
        rect: [50, 400, 200, 420],
        readingOrderOffset: 5,
      });
      const sentenceB = buildSortIndex({
        pageIndex: 6,
        viewBox: [0, 0, 400, 600],
        // Slightly higher rect[3] (lower displayTop) than A — without the
        // readingOrderOffset, displayTop would order B *before* A. The
        // readingOrderOffset must win.
        rect: [50, 410, 200, 440],
        readingOrderOffset: 6,
      });
      expect(sentenceA < sentenceB).toBe(true);
    });

    it("computes displayTop from viewBox[3] - rect[3] (handles cropbox offset)", () => {
      // Cropbox [10, 20, 410, 620]: a bbox 30pt below display top has
      // rect[3] = viewBox[3] - 30 = 590. displayTop should be 30, not 10
      // (which is what pageHeight - rect[3] would give).
      expect(
        buildSortIndex({
          pageIndex: 0,
          viewBox: [10, 20, 410, 620],
          rect: [50, 570, 200, 590],
        }),
      ).toBe("00000|000030|00030");
    });

    it("handles negative, NaN, Infinity, and missing values as zero", () => {
      // readingOrderOffset absent + invalid rect/viewBox → all-zero fields,
      // still matching the canonical regex.
      const out = buildSortIndex({
        pageIndex: -5,
        viewBox: [0, 0, Number.NaN, 600],
        rect: [Number.NaN, Number.POSITIVE_INFINITY, 0, Number.NEGATIVE_INFINITY],
      });
      expect(out).toBe("00000|000000|00000");
      expect(out).toMatch(SORT_INDEX_REGEX);

      // null readingOrderOffset falls back to displayTop computation.
      const outNull = buildSortIndex({
        pageIndex: 0,
        viewBox: [0, 0, 400, 600],
        rect: [50, 404, 200, 420],
        readingOrderOffset: null,
      });
      expect(outNull).toBe("00000|000180|00180");
    });

    it("clamps oversized values so the format regex always validates", () => {
      const out = buildSortIndex({
        pageIndex: 10_000_000,
        viewBox: [0, 0, 0, 10_000_000],
        rect: [0, 0, 0, -1],
        readingOrderOffset: 10_000_000,
      });
      expect(out).toMatch(SORT_INDEX_REGEX);
      // page clamped to 99999, offset clamped to 999999, top clamped to 99999.
      expect(out).toBe("99999|999999|99999");
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

  describe("highlightPageSpan", () => {
    const box = (t: number): BoundingBox => ({
      l: 10, t, r: 110, b: t + 20, coord_origin: CoordOrigin.TOPLEFT,
    });

    it("keeps a one-page highlight on its page with no continuation", () => {
      const span = highlightPageSpan([{ page_idx: 4, boxes: [box(10)] }]);
      expect(span.first.page_idx).toBe(4);
      expect(span.next).toBeNull();
    });

    it("splits two consecutive pages into the first page and its continuation", () => {
      const span = highlightPageSpan([
        { page_idx: 4, boxes: [box(500)], page_label: "iv", reading_order_offset: 900 },
        { page_idx: 5, boxes: [box(10)], page_label: "v", reading_order_offset: 0 },
      ]);
      expect(span.first).toMatchObject({ page_idx: 4, page_label: "iv", reading_order_offset: 900 });
      expect(span.next).toMatchObject({ page_idx: 5, boxes: [box(10)] });
    });

    it("merges locations on the same page, keeping the first one's label and offset", () => {
      const span = highlightPageSpan([
        { page_idx: 4, boxes: [box(10)], page_label: "iv", reading_order_offset: 12 },
        { page_idx: 4, boxes: [box(40)], page_label: "x", reading_order_offset: 99 },
      ]);
      expect(span.first).toMatchObject({ page_label: "iv", reading_order_offset: 12 });
      expect(span.first.boxes).toEqual([box(10), box(40)]);
      expect(span.next).toBeNull();
    });

    it("rejects three pages", () => {
      const call = () => highlightPageSpan([
        { page_idx: 4, boxes: [box(10)] },
        { page_idx: 5, boxes: [box(10)] },
        { page_idx: 6, boxes: [box(10)] },
      ]);
      expect(call).toThrow(HighlightPageSpanError);
      expect(call).toThrow(/at most two consecutive pages/);
      try { call(); } catch (error: any) {
        expect(error.code).toBe("highlight_spans_too_many_pages");
      }
    });

    it("rejects two pages that are not consecutive", () => {
      try {
        highlightPageSpan([
          { page_idx: 4, boxes: [box(10)] },
          { page_idx: 6, boxes: [box(10)] },
        ]);
        expect.unreachable();
      } catch (error: any) {
        expect(error).toBeInstanceOf(HighlightPageSpanError);
        expect(error.code).toBe("highlight_pages_not_consecutive");
      }
    });
  });

  describe("buildHighlightPlacement", () => {
    const firstPageBox: BoundingBox = {
      l: 10, t: 500, r: 110, b: 520, coord_origin: CoordOrigin.TOPLEFT,
    };
    const nextPageBox: BoundingBox = {
      l: 10, t: 20, r: 110, b: 50, coord_origin: CoordOrigin.TOPLEFT,
    };

    it("writes only rects for a one-page highlight", () => {
      const placement = buildHighlightPlacement(
        { pageIndex: 3, boxes: [firstPageBox], text: "t", pageLabel: "4", readingOrderOffset: 7 },
        baseGeometry,
      );
      expect(JSON.parse(placement.position)).toEqual({
        pageIndex: 3,
        rects: [[10, 80, 110, 100]],
      });
    });

    it("writes nextPageRects in the next page's coordinates, with label and sort index from the first page", () => {
      // The next page has a different viewBox offset, so a conversion that
      // reused the first page's geometry would produce different rects.
      const nextGeometry = geometry({ viewBox: [10, 20, 410, 620] });
      const placement = buildHighlightPlacement(
        {
          pageIndex: 3,
          boxes: [firstPageBox],
          nextPageBoxes: [nextPageBox],
          text: "full passage text",
          pageLabel: "iv",
          readingOrderOffset: 900,
        },
        baseGeometry,
        nextGeometry,
      );
      expect(JSON.parse(placement.position)).toEqual({
        pageIndex: 3,
        rects: [[10, 80, 110, 100]],
        nextPageRects: convertHighlightBoxesToRects([nextPageBox], nextGeometry),
      });
      expect(convertHighlightBoxesToRects([nextPageBox], nextGeometry)).toEqual([[20, 570, 120, 600]]);
      expect(placement.pageLabel).toBe("iv");
      expect(placement.sortIndex).toBe(
        buildSortIndex({ pageIndex: 3, viewBox: baseGeometry.viewBox, rect: [10, 80, 110, 100], readingOrderOffset: 900 }),
      );
      expect(placement.sortIndex.startsWith("00003|000900|")).toBe(true);
      expect(placement.text).toBe("full passage text");
    });

    it.each([
      ["no boxes", []],
      ["boxes outside the page", [{ l: 900, t: 900, r: 1000, b: 950, coord_origin: CoordOrigin.TOPLEFT }]],
    ])("refuses a continuation with %s rather than dropping it", (_label, boxes) => {
      expect(() => buildHighlightPlacement(
        { pageIndex: 3, boxes: [firstPageBox], nextPageBoxes: boxes as BoundingBox[], text: "t" },
        baseGeometry,
        baseGeometry,
      )).toThrow(/continuation on the next page produced no rects/);
    });

    it("refuses a continuation without the next page's geometry", () => {
      expect(() => buildHighlightPlacement(
        { pageIndex: 3, boxes: [firstPageBox], nextPageBoxes: [nextPageBox], text: "t" },
        baseGeometry,
      )).toThrow(/next page's geometry/);
    });
  });
});

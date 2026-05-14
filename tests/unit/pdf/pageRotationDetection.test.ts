import { describe, it, expect } from "vitest";

import {
    aspectRatioRotation,
    detectDominantTextOrientation,
    dirToRotation,
} from "../../../src/services/pdf/PageRotationNormalizer";
import {
    DEFAULT_MARGIN_ZONE,
    bboxFromXYWH,
    type RawPageData,
    type RawLine,
    type RawBlock,
} from "../../../src/services/pdf/types";

// ---------------------------------------------------------------------------
// dirToRotation — oracle values from real MuPDF detailed walk on the
// sample pages. Captured from
//   /Users/jlegewie/Zotero beaver-dev/storage/G7TTJKFH/...page index 1
//   /Users/jlegewie/Zotero beaver-dev/storage/KPK583ZF/...page index 13, 20
// using `stext.walk → beginLine(_, _, dir)`.
// ---------------------------------------------------------------------------

describe("dirToRotation (oracle values from real PDFs)", () => {
    it("maps dir=[1,0] (upright) → 0", () => {
        // Observed: KPK583ZF p0 every body line; KPK583ZF p13 bottom JSTOR
        // watermark; KPK583ZF p20 horizontal figure caption.
        expect(dirToRotation(1, 0)).toBe(0);
    });

    it("maps dir=[0,1] (writes downward in y-down frame) → 90", () => {
        // Observed: G7TTJKFH p1 every body line (`/Rotate 90` page);
        // KPK583ZF p20 vertical JSTOR watermarks on landscape page.
        expect(dirToRotation(0, 1)).toBe(90);
    });

    it("maps dir=[-1,0] → 180", () => {
        expect(dirToRotation(-1, 0)).toBe(180);
    });

    it("maps dir=[0,-1] (writes upward in y-down frame) → 270", () => {
        // Observed: KPK583ZF p13 figure caption (4 lines, all
        // dir=[0,-1]) — a side-rotated caption next to a portrait
        // figure on an otherwise un-rotated portrait page.
        expect(dirToRotation(0, -1)).toBe(270);
    });

    it("snaps near-cardinal vectors to the nearest cardinal", () => {
        expect(dirToRotation(0.99, 0.01)).toBe(0);
        expect(dirToRotation(-0.01, 1.0)).toBe(90);
        expect(dirToRotation(0.001, -1.0)).toBe(270);
    });

    it("returns 0 for degenerate (0,0) vectors", () => {
        // Some MuPDF builds emit [0,0] for empty / zero-glyph lines.
        expect(dirToRotation(0, 0)).toBe(0);
        expect(dirToRotation(0.1, 0.1)).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// aspectRatioRotation — JSON-pass fallback when `dir` is absent
// ---------------------------------------------------------------------------

describe("aspectRatioRotation (fallback when dir is unavailable)", () => {
    it("flags tall-narrow bboxes as rotated 90", () => {
        // h >= 2*w  →  vertical strip
        expect(aspectRatioRotation(bboxFromXYWH(0, 0, 10, 200, "top-left"))).toBe(90);
        expect(aspectRatioRotation(bboxFromXYWH(0, 0, 10, 20, "top-left"))).toBe(90);
    });

    it("returns 0 for normal wide-short body lines", () => {
        expect(aspectRatioRotation(bboxFromXYWH(0, 0, 200, 12, "top-left"))).toBe(0);
    });

    it("returns 0 for ambiguous (near-square) bboxes", () => {
        expect(aspectRatioRotation(bboxFromXYWH(0, 0, 12, 12, "top-left"))).toBe(0);
        expect(aspectRatioRotation(bboxFromXYWH(0, 0, 10, 19, "top-left"))).toBe(0);
    });

    it("returns 0 for degenerate bboxes (zero w or h)", () => {
        expect(aspectRatioRotation(bboxFromXYWH(0, 0, 0, 100, "top-left"))).toBe(0);
        expect(aspectRatioRotation(bboxFromXYWH(0, 0, 100, 0, "top-left"))).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// detectDominantTextOrientation — page-level voting
// ---------------------------------------------------------------------------

function line(opts: {
    x: number;
    y: number;
    w: number;
    h: number;
    text: string;
    rotation?: 0 | 90 | 180 | 270;
}): RawLine {
    return {
        wmode: 0,
        bbox: bboxFromXYWH(opts.x, opts.y, opts.w, opts.h, "top-left"),
        font: { name: "T", family: "T", weight: "normal", style: "normal", size: 10 },
        x: opts.x,
        y: opts.y,
        text: opts.text,
        rotation: opts.rotation ?? 0,
    };
}

function page(width: number, height: number, lines: RawLine[]): RawPageData {
    const block: RawBlock = {
        type: "text",
        bbox: bboxFromXYWH(0, 0, width, height, "top-left"),
        lines,
    };
    return {
        pageIndex: 0,
        pageNumber: 1,
        width,
        height,
        blocks: [block],
    };
}

const FIFTY_CHARS = "x".repeat(50);
const HUNDRED_CHARS = "x".repeat(100);

describe("detectDominantTextOrientation", () => {
    it("returns 0 for a normal upright page", () => {
        // 5 horizontal body lines; nothing rotated.
        const lines = Array.from({ length: 5 }, (_, i) =>
            line({ x: 100, y: 100 + i * 20, w: 400, h: 12, text: HUNDRED_CHARS, rotation: 0 }),
        );
        expect(detectDominantTextOrientation(page(612, 792, lines), DEFAULT_MARGIN_ZONE)).toBe(0);
    });

    it("classifies a /Rotate-90 page (≥80% rotation 90) as 90", () => {
        // Mimics G7TTJKFH p1: 8 body lines all rotation=90, in the
        // page interior (well outside the marginZone).
        const lines = Array.from({ length: 8 }, (_, i) =>
            line({
                x: 200 + i * 20,
                y: 100,
                w: 12,
                h: 200,
                text: HUNDRED_CHARS,
                rotation: 90,
            }),
        );
        expect(detectDominantTextOrientation(page(612, 792, lines), DEFAULT_MARGIN_ZONE)).toBe(90);
    });

    it("classifies a side-caption page (≥80% rotation 270) as 270", () => {
        // Mimics KPK583ZF p13 caption only (no JSTOR marginalia).
        const lines = Array.from({ length: 4 }, (_, i) =>
            line({
                x: 200 + i * 20,
                y: 200,
                w: 10,
                h: 400,
                text: HUNDRED_CHARS,
                rotation: 270,
            }),
        );
        expect(detectDominantTextOrientation(page(474, 718, lines), DEFAULT_MARGIN_ZONE)).toBe(270);
    });

    it("excludes marginZone lines when voting", () => {
        // 4 rotated body lines in the interior + 2 horizontal JSTOR
        // watermarks at the bottom edge (within marginZone). The
        // watermarks must NOT pull the page off the rotation
        // classification. Mirrors KPK583ZF p13.
        const body = Array.from({ length: 4 }, (_, i) =>
            line({
                x: 200 + i * 20,
                y: 200,
                w: 10,
                h: 400,
                text: HUNDRED_CHARS,
                rotation: 270,
            }),
        );
        const watermarks = [
            // Bottom-of-page (within bottom marginZone of 80pt).
            line({ x: 100, y: 700, w: 200, h: 6, text: FIFTY_CHARS, rotation: 0 }),
            line({ x: 100, y: 710, w: 150, h: 6, text: FIFTY_CHARS, rotation: 0 }),
        ];
        expect(
            detectDominantTextOrientation(page(474, 718, [...body, ...watermarks]), DEFAULT_MARGIN_ZONE),
        ).toBe(270);
    });

    it("does NOT classify sparse mixed pages (sparse rotated label on horizontal body)", () => {
        // 3 horizontal body lines (heavy text) + 1 rotated label.
        // The horizontal text exceeds the maxNonDominantShare, so the
        // page stays unrotated — protects sparse figure pages with a
        // single rotated tick label from getting globally rotated.
        const horizontal = Array.from({ length: 3 }, (_, i) =>
            line({
                x: 100,
                y: 200 + i * 20,
                w: 400,
                h: 12,
                text: HUNDRED_CHARS,
                rotation: 0,
            }),
        );
        const rotatedLabel = line({
            x: 200,
            y: 200,
            w: 10,
            h: 80,
            text: "Number of Genes",
            rotation: 90,
        });
        expect(
            detectDominantTextOrientation(page(612, 792, [...horizontal, rotatedLabel]), DEFAULT_MARGIN_ZONE),
        ).toBe(0);
    });

    it("returns 0 when total non-marginal text is below the 200-char threshold", () => {
        // One short rotated line (50 chars) — below the floor.
        const lines = [
            line({
                x: 200,
                y: 200,
                w: 10,
                h: 200,
                text: FIFTY_CHARS,
                rotation: 90,
            }),
        ];
        expect(detectDominantTextOrientation(page(612, 792, lines), DEFAULT_MARGIN_ZONE)).toBe(0);
    });

    it("does NOT exclude long body lines whose center stays in the page interior", () => {
        // Rotated body lines in the page center, extending toward the
        // raw left/right edges. Center is in the interior so they
        // survive the marginZone filter and the page classifies
        // correctly. Guard against accidentally dropping body content
        // that straddles edges on rotated pages.
        const lines = Array.from({ length: 4 }, (_, i) =>
            line({
                // Center near page middle (x=300 on a 612-wide page),
                // bbox span x=80..520 hugs the left/right edges (raw
                // marginZone is 60pt left, 60pt right).
                x: 80,
                y: 200 + i * 30,
                w: 440,
                h: 100,
                text: HUNDRED_CHARS,
                rotation: 90,
            }),
        );
        expect(detectDominantTextOrientation(page(612, 792, lines), DEFAULT_MARGIN_ZONE)).toBe(90);
    });

    it("returns 0 for an empty page", () => {
        expect(detectDominantTextOrientation(page(612, 792, []), DEFAULT_MARGIN_ZONE)).toBe(0);
    });
});

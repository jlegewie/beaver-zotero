/**
 * Unit tests for margin-text exclusion in `DocumentAnalyzer`.
 *
 * The OCR detector measures text density to decide whether a document needs
 * OCR. Margin furniture — publisher watermarks ("Downloaded from …"), browser
 * print banners, running headers/footers, page numbers — must not count as
 * page text: a scanned document whose only text layer is a repeated margin
 * stamp would otherwise pass the gate as successfully extracted.
 *
 * `analyzePage` therefore counts a line only when its bounding box overlaps
 * the page body region (the page inset by `DEFAULT_MARGIN_ZONE`).
 *
 * These tests exercise `DocumentAnalyzer` through its `RawPageProvider` seam,
 * so they need neither MuPDF nor WASM.
 */
import { describe, it, expect } from "vitest";

import { DocumentAnalyzer } from "../../../src/beaver-extract/DocumentAnalyzer";
import type { RawPageProvider } from "../../../src/beaver-extract/DocumentAnalyzer";
import type {
    BoundingBox,
    RawBlock,
    RawFont,
    RawLine,
    RawPageData,
} from "../../../src/beaver-extract/types";

const PAGE_W = 600;
const PAGE_H = 800;

// Body region for a 600×800 page given DEFAULT_MARGIN_ZONE (60/80/60/80):
// [60, 80, 540, 720]. Boxes below are placed relative to it.
function box(l: number, t: number, r: number, b: number): BoundingBox {
    return { l, t, r, b, origin: "top-left" };
}

const BODY_BOX = box(70, 200, 530, 220);
const LEFT_MARGIN_BOX = box(5, 100, 45, 700); // rotated-watermark column
const RIGHT_MARGIN_BOX = box(555, 100, 595, 700);
const TOP_MARGIN_BOX = box(80, 15, 520, 45);
const BOTTOM_MARGIN_BOX = box(80, 755, 520, 785); // print/footer banner
const BODY_BLEED_BOX = box(20, 300, 580, 320); // body line bleeding into margins

function makeFont(): RawFont {
    return { name: "TestFont", family: "TestFont", weight: "normal", style: "normal", size: 10 };
}

interface LineSpec {
    text: string;
    bbox: BoundingBox;
}

function makePage(pageIndex: number, lines: LineSpec[]): RawPageData {
    const rawLines: RawLine[] = lines.map((l) => ({
        wmode: 0,
        bbox: l.bbox,
        font: makeFont(),
        x: l.bbox.l,
        y: l.bbox.t,
        text: l.text,
    }));
    const blocks: RawBlock[] = [
        { type: "text", bbox: box(0, 0, PAGE_W, PAGE_H), lines: rawLines },
    ];
    return { pageIndex, pageNumber: pageIndex + 1, width: PAGE_W, height: PAGE_H, blocks };
}

function makeProvider(pages: RawPageData[]): RawPageProvider {
    return {
        getPageCount: () => pages.length,
        extractRawPage: (i: number) => pages[i],
    };
}

function nonWs(s: string): number {
    return s.replace(/\s+/g, "").length;
}

/** A publisher watermark — long enough to clear every per-page text gate. */
const watermark =
    "Downloaded from http://pubs.example.org/journal/article-pdf/162/4/637/637.pdf " +
    "by Example University Library user on 2024-01-01";

/** An ordinary body paragraph. */
const bodyText = "The quick brown fox jumps over the lazy dog. ".repeat(12);

describe("DocumentAnalyzer margin-text exclusion", () => {
    it("excludes a left-margin watermark from the text measurement", () => {
        // Every page carries only a rotated left-edge watermark column. Without
        // margin exclusion its ~120 characters count as page text and the
        // document passes; with it the body is empty and OCR is required.
        const pages = Array.from({ length: 10 }, (_, i) =>
            makePage(i, [{ text: watermark, bbox: LEFT_MARGIN_BOX }]),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.pageAnalyses[0].textLength).toBe(0);
        expect(result.needsOCR).toBe(true);
    });

    it("excludes watermarks in every margin edge", () => {
        const pages = Array.from({ length: 8 }, (_, i) =>
            makePage(i, [
                { text: watermark, bbox: TOP_MARGIN_BOX },
                { text: watermark, bbox: BOTTOM_MARGIN_BOX },
                { text: watermark, bbox: LEFT_MARGIN_BOX },
                { text: watermark, bbox: RIGHT_MARGIN_BOX },
            ]),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.pageAnalyses[0].textLength).toBe(0);
        expect(result.needsOCR).toBe(true);
    });

    it("counts body text and ignores a co-located margin watermark", () => {
        // Each page has a real paragraph plus a margin watermark; only the
        // paragraph is measured, and the document passes as text-bearing.
        const pages = Array.from({ length: 10 }, (_, i) =>
            makePage(i, [
                { text: bodyText, bbox: BODY_BOX },
                { text: watermark, bbox: BOTTOM_MARGIN_BOX },
            ]),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.pageAnalyses[0].textLength).toBe(nonWs(bodyText));
        expect(result.needsOCR).toBe(false);
    });

    it("keeps a body line that bleeds into the side margins", () => {
        // A wide body line overlapping the body region is kept even though its
        // bbox extends past the left/right margin boundaries.
        const pages = Array.from({ length: 10 }, (_, i) =>
            makePage(i, [{ text: bodyText, bbox: BODY_BLEED_BOX }]),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.pageAnalyses[0].textLength).toBe(nonWs(bodyText));
        expect(result.needsOCR).toBe(false);
    });
});

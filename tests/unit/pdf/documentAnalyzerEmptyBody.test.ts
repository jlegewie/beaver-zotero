/**
 * Unit tests for the per-page "no body text" check in `DocumentAnalyzer`.
 *
 * `analyzePage` Check 1 only fires `no_text_blocks` when a page has *zero*
 * text blocks. A page whose text blocks all fall in the margin zone —
 * running headers/footers, page numbers, a printer's imposition mark — still
 * has text blocks, so Check 1 stays silent, yet its body is empty.
 *
 * Without a per-page signal, such a page is only caught by the document-wide
 * near-empty mean guard, which a handful of content-rich pages (front matter)
 * can pull above the threshold. A corrupt or partially-scanned book whose
 * body pages render no text then passes the OCR gate and extraction silently
 * returns near-empty content.
 *
 * The `no_body_text` issue closes that gap: any sampled page with text blocks
 * but zero body text is flagged on its own, independent of the document mean.
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
// [60, 80, 540, 720].
function box(l: number, t: number, r: number, b: number): BoundingBox {
    return { l, t, r, b, origin: "top-left" };
}

const BODY_BOX = box(70, 200, 530, 240);
const TOP_MARGIN_BOX = box(80, 15, 520, 45);
// A small image well under the 0.65 large-image coverage threshold.
const SMALL_IMAGE_BOX = box(70, 300, 230, 420);

function makeFont(): RawFont {
    return { name: "TestFont", family: "TestFont", weight: "normal", style: "normal", size: 10 };
}

interface LineSpec {
    text: string;
    bbox: BoundingBox;
}

function makePage(
    pageIndex: number,
    lines: LineSpec[],
    imageBox?: BoundingBox,
): RawPageData {
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
    if (imageBox) {
        blocks.push({ type: "image", bbox: imageBox });
    }
    return { pageIndex, pageNumber: pageIndex + 1, width: PAGE_W, height: PAGE_H, blocks };
}

function makeProvider(pages: RawPageData[]): RawPageProvider {
    return {
        getPageCount: () => pages.length,
        extractRawPage: (i: number) => pages[i],
    };
}

/** A printer's imposition mark — the filename + timestamp stamped in the
 *  top margin of every page. Long enough to clear every per-page text gate
 *  if it were ever counted as body text. */
const printerMark = "SomeBook_chapter_2_p9-40   12/12/05, 11:47 am   10";

/** An ordinary body paragraph. */
const bodyText = "The quick brown fox jumps over the lazy dog. ".repeat(12);

describe("DocumentAnalyzer per-page no-body-text check", () => {
    it("flags a page whose only text is a margin printer's mark", () => {
        const pages = Array.from({ length: 8 }, (_, i) =>
            makePage(i, [{ text: printerMark, bbox: TOP_MARGIN_BOX }]),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.pageAnalyses[0].textLength).toBe(0);
        expect(result.pageAnalyses[0].issues).toContain("no_body_text");
        expect(result.needsOCR).toBe(true);
        expect(result.primaryReason).toBe("missing_text_content");
    });

    it("flags a body-empty page even when its image is too small to count as a large image", () => {
        // The page draws a sub-threshold image, so the `insufficient_text` +
        // `large_image_coverage` path does not fire — only `no_body_text` does.
        const pages = Array.from({ length: 8 }, (_, i) =>
            makePage(i, [{ text: printerMark, bbox: TOP_MARGIN_BOX }], SMALL_IMAGE_BOX),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.pageAnalyses[0].issues).toEqual(["no_body_text"]);
        expect(result.needsOCR).toBe(true);
    });

    it("routes a document to OCR even when a few content-rich pages keep the mean high", () => {
        // Page index 1 carries a full paragraph; every other page has only a
        // margin printer's mark. The near-empty guard averages text across the
        // sample, so one content-rich page lifts the mean far above
        // `minMeanTextPerPage` — the per-page `no_body_text` check is what
        // catches the empty body pages here.
        const pages: RawPageData[] = [];
        for (let i = 0; i < 60; i++) {
            pages.push(
                i === 1
                    ? makePage(i, [
                          { text: bodyText, bbox: BODY_BOX },
                          { text: printerMark, bbox: TOP_MARGIN_BOX },
                      ])
                    : makePage(i, [{ text: printerMark, bbox: TOP_MARGIN_BOX }]),
            );
        }
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        // The single content-rich page alone keeps the sampled mean above the
        // 24-char near-empty threshold, proving the verdict comes from the
        // per-page check rather than the document-wide guard.
        const sampledMean =
            result.pageAnalyses.reduce((sum, p) => sum + p.textLength, 0) /
            result.pageAnalyses.length;
        expect(sampledMean).toBeGreaterThan(24);

        expect(result.issueBreakdown.no_body_text).toBeGreaterThan(0);
        expect(result.needsOCR).toBe(true);
        expect(result.primaryReason).toBe("missing_text_content");
    });

    it("does not route a healthy document to OCR for a single empty body page", () => {
        // One blank-bodied page among many text pages is ordinary (a part
        // divider, a full-page figure): it must not trip the OCR gate.
        const pages = Array.from({ length: 30 }, (_, i) =>
            i === 7
                ? makePage(i, [{ text: printerMark, bbox: TOP_MARGIN_BOX }])
                : makePage(i, [{ text: bodyText, bbox: BODY_BOX }]),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.needsOCR).toBe(false);
        expect(result.primaryReason).toBe("text_extraction_acceptable");
    });
});

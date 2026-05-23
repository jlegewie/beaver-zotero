/**
 * Unit tests for the document-level near-empty guard in `DocumentAnalyzer`.
 *
 * The per-page `insufficient_text` issue only fires when a sparse page ALSO
 * carries a large image. Scanned documents that expose only a stray
 * incidental text layer — a running header, a figure label, a lone citation
 * line — without a detectable large image therefore slip past every per-page
 * check and are reported as successfully extracted with near-empty content.
 *
 * The near-empty guard closes that gap: when the mean extractable text across
 * the sampled pages falls below `minMeanTextPerPage`, the document is routed
 * to OCR regardless of the per-page issue ratio.
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

function makeBox(): BoundingBox {
    return { l: 50, t: 50, r: 550, b: 750, origin: "top-left" };
}

function makeFont(): RawFont {
    return { name: "TestFont", family: "TestFont", weight: "normal", style: "normal", size: 10 };
}

/**
 * A text page carrying `text` on a single line. When `imageBox` is given, an
 * image block of that size is added — used to make `hasImages` true without
 * necessarily crossing the large-image coverage threshold.
 */
function makeTextPage(
    pageIndex: number,
    text: string,
    imageBox?: BoundingBox,
): RawPageData {
    const line: RawLine = {
        wmode: 0,
        bbox: makeBox(),
        font: makeFont(),
        x: 50,
        y: 60,
        text,
    };
    const blocks: RawBlock[] = [{ type: "text", bbox: makeBox(), lines: [line] }];
    if (imageBox) {
        blocks.push({ type: "image", bbox: imageBox });
    }
    return {
        pageIndex,
        pageNumber: pageIndex + 1,
        width: 600,
        height: 800,
        blocks,
    };
}

function makeProvider(pages: RawPageData[]): RawPageProvider {
    return {
        getPageCount: () => pages.length,
        extractRawPage: (i: number) => pages[i],
    };
}

/** A short stray text layer — a running header — ~10 non-whitespace chars. */
const strayHeader = "Header line";

/** A small image well under the 0.65 large-image coverage threshold. */
const smallImageBox: BoundingBox = { l: 50, t: 50, r: 200, b: 150, origin: "top-left" };

/** Ordinary prose — hundreds of characters per page. */
const proseText = "The quick brown fox jumps over the lazy dog. ".repeat(20);

describe("DocumentAnalyzer document-level near-empty guard", () => {
    it("flags a stray-text-layer document with no detectable large image", () => {
        // Every sampled page carries only a running header and no image, so no
        // per-page issue fires — without the document-level guard this passes
        // as a successful extraction with near-empty content.
        const pages = Array.from({ length: 10 }, (_, i) => makeTextPage(i, strayHeader));
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.issueRatio).toBe(0);
        expect(result.needsOCR).toBe(true);
    });

    it("flags a near-empty document whose pages carry sub-threshold images", () => {
        // Images present but each below the large-image coverage threshold, so
        // the per-page `insufficient_text` + `large_image_coverage` checks do
        // not fire; only the document-level guard catches it.
        const pages = Array.from({ length: 10 }, (_, i) =>
            makeTextPage(i, strayHeader, smallImageBox),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.issueRatio).toBe(0);
        expect(result.needsOCR).toBe(true);
    });

    it("does not flag ordinary prose documents", () => {
        const pages = Array.from({ length: 10 }, (_, i) => makeTextPage(i, proseText));
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.needsOCR).toBe(false);
    });

    it("does not flag a document whose mean text is just above the threshold", () => {
        // 30 non-whitespace characters per page — sparse but above the default
        // `minMeanTextPerPage` of 24, so the guard stays silent.
        const pages = Array.from({ length: 10 }, (_, i) =>
            makeTextPage(i, "a".repeat(30)),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.needsOCR).toBe(false);
    });

    it("respects a raised minMeanTextPerPage threshold", () => {
        // The same 30-char-per-page document is flagged once the threshold is
        // raised above its mean — proving the guard, not a per-page check, is
        // what decides the verdict here.
        const pages = Array.from({ length: 10 }, (_, i) =>
            makeTextPage(i, "a".repeat(30)),
        );
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds({
            minMeanTextPerPage: 100,
        });

        expect(result.needsOCR).toBe(true);
    });

    it("can be disabled with minMeanTextPerPage = 0", () => {
        const pages = Array.from({ length: 10 }, (_, i) => makeTextPage(i, strayHeader));
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds({
            minMeanTextPerPage: 0,
        });

        expect(result.needsOCR).toBe(false);
    });

    it("does not fire on 1-2 page documents (page-count gate)", () => {
        // A short near-empty PDF is more likely a cover / part-divider than a
        // scanned document missing its text layer, so the guard stays silent.
        for (const length of [1, 2]) {
            const pages = Array.from({ length }, (_, i) => makeTextPage(i, strayHeader));
            const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();
            expect(result.needsOCR).toBe(false);
        }
    });

    it("fires once the document has at least 3 pages", () => {
        const pages = Array.from({ length: 3 }, (_, i) => makeTextPage(i, strayHeader));
        const result = new DocumentAnalyzer(makeProvider(pages)).analyzeOCRNeeds();

        expect(result.needsOCR).toBe(true);
    });
});

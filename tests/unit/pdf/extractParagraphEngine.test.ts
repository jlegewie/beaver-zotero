/**
 * Unit tests for the paragraph engine branch in `runExtraction`.
 *
 * Hermetic — synthetic RawPageData fed in via a mocked
 * `extractRawPageFromDoc`. The DocumentLike stub only needs to satisfy the
 * `countPages` and metadata calls reached during this test; everything that
 * actually reads page content goes through the mocked helper.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    bboxFromXYWH,
    DEFAULT_EXTRACTION_SETTINGS,
    type RawBlock,
    type RawLine,
    type RawPageData,
} from "@beaver/agent-core/extract/types";

// Mock the doc-helpers walker BEFORE importing the module under test so the
// import sees the mocked binding. We hand-build RawPageData per page index.
vi.mock("../../../src/beaver-extract/worker/docHelpers", async () => {
    const actual = await vi.importActual<
        typeof import("../../../src/beaver-extract/worker/docHelpers")
    >("../../../src/beaver-extract/worker/docHelpers");
    return {
        ...actual,
        extractRawPageFromDoc: (_doc: unknown, pageIndex: number) =>
            getSyntheticPage(pageIndex),
    };
});

import {
    runExtraction,
    type ExtractionEngine,
} from "../../../src/beaver-extract/pipeline/extract";
import { PageWalkCache } from "../../../src/beaver-extract/pipeline/documentAnalysis";
import { CURRENT_PDF_EXTRACTION_PRESET } from "../../../src/beaver-extract/schema/presets";
import type { DocumentLike } from "../../../src/beaver-extract/worker/mupdfApi";

// ---------------------------------------------------------------------------
// Synthetic page builder
// ---------------------------------------------------------------------------

const PAGE_W = 612;
const PAGE_H = 792;
const BODY_SIZE = 12;
const HEADER_SIZE = 18;

function makeLine(
    text: string,
    yTop: number,
    xStart = 80,
    size: number = BODY_SIZE,
    fontName: string = "Body",
    weight: "normal" | "bold" = "normal",
): RawLine {
    return {
        wmode: 0,
        bbox: bboxFromXYWH(xStart, yTop, text.length * 6, size, "top-left"),
        font: {
            name: fontName,
            family: fontName,
            weight,
            style: "normal",
            size,
        },
        x: xStart,
        y: yTop,
        text,
    };
}

function makePage(pageIndex: number, lines: RawLine[]): RawPageData {
    const left = lines.length ? Math.min(...lines.map((l) => l.bbox.l)) : 0;
    const top = lines.length ? Math.min(...lines.map((l) => l.bbox.t)) : 0;
    const blocks: RawBlock[] = lines.length
        ? [
              {
                  type: "text",
                  bbox: bboxFromXYWH(left, top, PAGE_W, PAGE_H, "top-left"),
                  lines,
              },
          ]
        : [];
    return {
        pageIndex,
        pageNumber: pageIndex + 1,
        width: PAGE_W,
        height: PAGE_H,
        blocks,
    };
}

// One header followed by two body paragraphs separated by a vertical gap.
// The paragraph detector splits on the gap between lines 4 and 5 because
// the second paragraph starts with an indent and a clear vertical break.
function getSyntheticPage(pageIndex: number): RawPageData {
    return makePage(pageIndex, [
        makeLine(
            "Section Title",
            120,
            80,
            HEADER_SIZE,
            "Header",
            "bold",
        ),
        makeLine("First paragraph line one continues normally here.", 160),
        makeLine("First paragraph line two continues to the right.", 178),
        makeLine("First paragraph line three concludes the thought.", 196),
        makeLine("    Second paragraph starts after a clear gap.", 240, 100),
        makeLine("Second paragraph line two extends here too.", 258),
    ]);
}

// Bare-minimum DocumentLike. The test path never actually touches these
// methods because `extractRawPageFromDoc` is mocked, but the parameter is
// typed so we provide a structural stub.
function makeDocStub(): DocumentLike {
    return {
        pointer: 0,
        needsPassword: () => false,
        countPages: () => 1,
        getMetadata: () => undefined,
        loadPage: () => {
            throw new Error("loadPage should not be called in this test");
        },
        destroy: () => {},
    };
}

/** `runExtraction` over the synthetic pages with the current schema's preset. */
function extractPages(
    engine: ExtractionEngine,
    targetIndices: number[],
    pageCount: number,
) {
    const doc = makeDocStub();
    const preset = CURRENT_PDF_EXTRACTION_PRESET;
    return runExtraction(doc, {
        engine,
        preset,
        pageCache: new PageWalkCache(doc, undefined, preset),
        opts: { ...DEFAULT_EXTRACTION_SETTINGS },
        requestedRepeatThreshold: undefined,
        targetIndices,
        analysisIndices: targetIndices,
        pageCount,
        pageLabels: {},
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runExtraction: paragraph engine", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("emits markdown-shaped pageContent with `## ` for the header", () => {
        const result = extractPages("paragraph", [0], 1);
        expect(result.pages).toHaveLength(1);
        const page = result.pages[0];
        expect(page.content).toContain("## Section Title");
        expect(page.content).toContain("\n\n");
        expect(page.lines).toBeUndefined();
    });

    it("preserves the same InternalExtractionResult shape as the block engine", () => {

        const blockResult = extractPages("block", [0], 1);
        const paragraphResult = extractPages("paragraph", [0], 1);

        // Same top-level keys.
        expect(Object.keys(paragraphResult).sort()).toEqual(
            Object.keys(blockResult).sort(),
        );
        // Per-page identity fields match between engines.
        expect(blockResult.pages[0].index).toBe(paragraphResult.pages[0].index);
        expect(blockResult.pages[0].width).toBe(paragraphResult.pages[0].width);
        expect(blockResult.pages[0].height).toBe(
            paragraphResult.pages[0].height,
        );
        // Paragraph engine produces non-empty content for this synthetic page.
        // (Block engine's content depends on column detection succeeding on
        // the synthetic input; that's not what this test is exercising.)
        expect(paragraphResult.pages[0].content.length).toBeGreaterThan(0);
    });

    it("produces fullText by joining per-page paragraph content", () => {
        const result = extractPages("paragraph", [0, 1], 2);
        expect(result.pages).toHaveLength(2);
        // fullText is page contents joined with blank lines.
        expect(result.fullText).toContain(result.pages[0].content);
        expect(result.fullText).toContain(result.pages[1].content);
        expect(result.fullText.split("\n\n").length).toBeGreaterThan(2);
    });
});

describe("BeaverExtractor.extract: argument guards", () => {
    it("rejects mode='structured' with markdown.engine set", async () => {
        const { BeaverExtractor } = await import(
            "../../../src/beaver-extract/index"
        );
        const fakeData = new Uint8Array([0]);
        await expect(
            new BeaverExtractor().extract(fakeData, {
                mode: "structured",
                markdown: { engine: "paragraph" },
            }),
        ).rejects.toThrow(
            /markdown\.engine is not applicable when mode='structured'/,
        );
    });

});

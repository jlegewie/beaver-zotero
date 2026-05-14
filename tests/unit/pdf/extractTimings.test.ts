/**
 * Unit tests for `metadata.timings` and `metadata.engine` populated by
 * `runExtractFromIndices`.
 *
 * Hermetic — same synthetic-page mock pattern as `extractParagraphEngine.test.ts`.
 * `docOpenMs` is only populated by `opExtract` (which has the doc-cache call);
 * here we test the helper-owned phases (`walkMs`, `analysisMs`, `perPageMs`,
 * `totalMs`) and the `engine` field.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    bboxFromXYWH,
    DEFAULT_EXTRACTION_SETTINGS,
    type RawBlock,
    type RawLine,
    type RawPageData,
} from "../../../src/services/pdf/types";

vi.mock("../../../src/services/pdf/worker/docHelpers", async () => {
    const actual = await vi.importActual<
        typeof import("../../../src/services/pdf/worker/docHelpers")
    >("../../../src/services/pdf/worker/docHelpers");
    return {
        ...actual,
        extractRawPageFromDoc: (_doc: unknown, pageIndex: number) =>
            getSyntheticPage(pageIndex),
    };
});

import { runExtractFromIndices } from "../../../src/services/pdf/worker/ops";
import type { DocumentLike } from "../../../src/services/pdf/worker/mupdfApi";

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
        font: { name: fontName, family: fontName, weight, style: "normal", size },
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

function getSyntheticPage(pageIndex: number): RawPageData {
    return makePage(pageIndex, [
        makeLine("Section Title", 120, 80, HEADER_SIZE, "Header", "bold"),
        makeLine("First paragraph line one continues normally here.", 160),
        makeLine("First paragraph line two continues to the right.", 178),
        makeLine("Second paragraph starts after a clear gap.", 240, 100),
    ]);
}

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

describe("runExtractFromIndices: metadata.timings + metadata.engine", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it.each([
        ["block", "block"],
        ["paragraph", "paragraph"],
    ] as const)(
        "records engine=%s → metadata.engine=%s",
        (engine, expectedEngine) => {
            const doc = makeDocStub();
            const opts = { ...DEFAULT_EXTRACTION_SETTINGS };
            const result = runExtractFromIndices(
                doc,
                opts as any,
                undefined,
                [0],
                [0],
                1,
                {},
                engine,
            );
            expect(result.metadata.engine).toBe(expectedEngine);
        },
    );

    it("populates metadata.timings with non-negative phase deltas", () => {
        const doc = makeDocStub();
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS };
        const result = runExtractFromIndices(
            doc,
            opts as any,
            undefined,
            [0],
            [0],
            1,
            {},
            "paragraph",
        );
        const t = result.metadata.timings!;
        expect(t).toBeDefined();
        expect(t.totalMs).toBeGreaterThanOrEqual(0);
        expect(t.walkMs).toBeGreaterThanOrEqual(0);
        expect(t.analysisMs).toBeGreaterThanOrEqual(0);
        // `docOpenMs` is owned by `opExtract`; the helper writes 0 as a placeholder.
        expect(t.docOpenMs).toBe(0);
    });

    it("perPageMs has one entry per emitted page", () => {
        const doc = makeDocStub();
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS };
        const result = runExtractFromIndices(
            doc,
            opts as any,
            undefined,
            [0, 1, 2],
            [0, 1, 2],
            3,
            {},
            "paragraph",
        );
        expect(result.pages).toHaveLength(3);
        expect(result.metadata.timings!.perPageMs).toHaveLength(3);
        for (const ms of result.metadata.timings!.perPageMs) {
            expect(ms).toBeGreaterThanOrEqual(0);
        }
    });

    it("totalMs is at least the sum of helper-owned phases", () => {
        const doc = makeDocStub();
        const opts = { ...DEFAULT_EXTRACTION_SETTINGS };
        const result = runExtractFromIndices(
            doc,
            opts as any,
            undefined,
            [0, 1],
            [0, 1],
            2,
            {},
            "paragraph",
        );
        const t = result.metadata.timings!;
        const phasesSum =
            t.walkMs +
            t.analysisMs +
            t.perPageMs.reduce((s, n) => s + n, 0);
        // `totalMs` measured around the whole helper body should bound the
        // sum of measured phases (small Date.now/perf.now jitter aside).
        expect(t.totalMs).toBeGreaterThanOrEqual(phasesSum - 1);
    });
});

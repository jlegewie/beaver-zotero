import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { projectTracePage } from "../../../src/beaver-extract/debug/traceProjection";
import { readFixture, readSharedPdf } from "../../../src/beaver-extract/cli/fixture/fixtureFile";
import {
    extractPdf,
    structuredExtractWithDebug,
} from "../../../src/beaver-extract/node/api";
import type {
    ExtractionDebug,
    StructuredExtractResult,
} from "../../../src/beaver-extract/schema";

describe("structured trace projection", () => {
    it("matches a full structured extract page through the Node worker path", async () => {
        const fixtureRoot = join(process.cwd(), "tests/fixtures/pdfs/extract-public");
        const fixture = readFixture(fixtureRoot, "legewie-fagan__p0");
        const pdfData = readSharedPdf(fixtureRoot, fixture.pdfSha256);
        const pageIndex = fixture.config.pageIndices[0];

        const structured = await extractPdf({
            pdfData,
            mode: "structured",
            structured: { splitterConfig: fixture.config.splitterConfig },
            settings: fixture.config.settings,
            paragraphSettings: fixture.config.paragraphSettings,
        });
        expect(structured.mode).toBe("structured");
        if (structured.mode !== "structured") throw new Error("expected structured result");

        const trace = await structuredExtractWithDebug({
            pdfData,
            mode: "structured",
            capturePages: [pageIndex],
            debugMode: "full",
            structured: { splitterConfig: fixture.config.splitterConfig },
            settings: fixture.config.settings,
            paragraphSettings: fixture.config.paragraphSettings,
        });

        const structuredPage = structured.document.pages.find(
            (page) => page.index === pageIndex,
        );
        const tracePage = trace.result.document.pages.find(
            (page) => page.index === pageIndex,
        );
        expect(tracePage).toEqual(structuredPage);

        const debugPage = trace.debug.pages?.[String(pageIndex)];
        expect(debugPage?.items).toEqual(structuredPage?.items);
        expect(
            debugPage?.sentences?.map((sentence) => {
                const { id, order, text, bboxes, joinWithNext } = sentence;
                return {
                    id,
                    order,
                    text,
                    bboxes,
                    ...(joinWithNext ? { joinWithNext } : {}),
                };
            }),
        ).toEqual(
            structuredPage?.items.flatMap((item) =>
                "sentences" in item ? (item.sentences ?? []) : [],
            ),
        );
    });

    it("surfaces full debug fields for a captured page", () => {
        const result: StructuredExtractResult = {
            mode: "structured",
            schemaVersion: "4",
            document: {
                pageCount: 1,
                bboxOrigin: "top-left",
                bboxPrecision: 1,
                pages: [
                    {
                        index: 0,
                        width: 100,
                        height: 100,
                        items: [
                            {
                                id: "p1",
                                kind: "text",
                                pageIndex: 0,
                                order: 0,
                                bbox: [0, 0, 50, 10],
                                text: "Hello.",
                                sentences: [
                                    {
                                        id: "s1",
                                        order: 0,
                                        text: "Hello.",
                                        bboxes: [[0, 0, 50, 10]],
                                    },
                                ],
                            },
                        ],
                    },
                ],
                citationIndex: {
                    p1: { id: "p1", kind: "item", pageIndex: 0, itemId: "p1" },
                    s1: {
                        id: "s1",
                        kind: "sentence",
                        pageIndex: 0,
                        itemId: "p1",
                        sentenceId: "s1",
                    },
                },
            },
        };
        const debug: ExtractionDebug = {
            pages: {
                "0": {
                    pageIndex: 0,
                    width: 100,
                    height: 100,
                    counts: { items: 1, sentences: 1, columns: 1, lines: 1 },
                    columns: [[0, 0, 50, 100]],
                    lines: [{ id: "p1:l0", text: "Hello.", bbox: [0, 0, 50, 10] }],
                    items: result.document.pages[0].items,
                    sentences: [
                        {
                            id: "s1",
                            itemId: "p1",
                            order: 0,
                            text: "Hello.",
                            bboxes: [[0, 0, 50, 10]],
                            fragments: [{ lineIndex: 0, text: "Hello.", bbox: [0, 0, 50, 10] }],
                        },
                    ],
                    sentenceFragments: [{ lineIndex: 0, text: "Hello.", bbox: [0, 0, 50, 10] }],
                    styleProfile: { primaryBodyStyle: { size: 12 } },
                    marginCandidates: [{ text: "1", position: "bottom" }],
                },
            },
        };

        const full = projectTracePage(result, debug, 0, "full");
        expect(full.raw_lines).toHaveLength(1);
        expect(full.columns).toHaveLength(1);
        expect(full.style_profile).toBeTruthy();
        expect(full.smart_removal.candidates).toHaveLength(1);
        expect(full.sentence_stats).toEqual({ count: 1, degraded: 0, fragments: 1 });

        const triage = projectTracePage(result, debug, 0, "triage");
        expect(triage.raw_lines).toEqual([]);
        expect(triage.page.lines).toBeUndefined();
    });
});

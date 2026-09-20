import { describe, expect, it } from "vitest";

import { bboxToRect, rectToBBox } from "../../../src/beaver-extract/schema/bbox";
import { assignDocumentIds } from "../../../src/beaver-extract/schema/ids";
import {
    buildCitationIndex,
    resolveCitation,
} from "../../../src/beaver-extract/schema/citationIndex";
import { projectStructuredPage } from "../../../src/beaver-extract/schema/canonicalProjection";
import { BeaverExtractor, ExtractionError, ExtractionErrorCode } from "../../../src/beaver-extract";
import { extractPdf } from "../../../src/beaver-extract/node/api";
import { opExtract } from "../../../src/beaver-extract/worker/ops";
import {
    SCHEMA_VERSION,
    type StructuredPage,
} from "../../../src/beaver-extract/schema";
import { DEFAULT_EXTRACTION_SETTINGS } from "@beaver/agent-core/extract/types";

describe("canonical extraction schema helpers", () => {
    it("rounds top-left bboxes to tuple rects and rejects other origins", () => {
        const rect = bboxToRect(
            { l: 1.234, t: 2.345, r: 3.456, b: 4.567, origin: "top-left" },
            1,
        );
        expect(rect).toEqual([1.2, 2.3, 3.5, 4.6]);
        expect(rectToBBox(rect)).toEqual({
            l: 1.2,
            t: 2.3,
            r: 3.5,
            b: 4.6,
            origin: "top-left",
        });
        expect(() =>
            bboxToRect({ l: 0, t: 0, r: 1, b: 1, origin: "bottom-left" }),
        ).toThrow(/top-left/);
    });

    it("assigns deterministic document-wide ids and citation entries", () => {
        const pages: StructuredPage[] = [
            {
                index: 0,
                width: 100,
                height: 100,
                viewBox: [0, 0, 100, 100],
                rotation: 0,
                items: [
                    {
                        id: "old",
                        kind: "section_header",
                        pageIndex: 0,
                        order: 0,
                        text: "Intro",
                        level: 1,
                        bbox: [0, 0, 10, 10],
                    },
                    {
                        id: "old2",
                        kind: "text",
                        pageIndex: 0,
                        order: 1,
                        text: "A sentence.",
                        bbox: [0, 10, 80, 20],
                        sentences: [
                            {
                                id: "tmp",
                                order: 0,
                                text: "A sentence.",
                                bboxes: [[0, 10, 80, 20]],
                            },
                        ],
                    },
                ],
            },
        ];
        assignDocumentIds(pages);
        expect(pages[0].items[0].id).toBe("heading1");
        expect(pages[0].items[1].id).toBe("p1");
        const sentence = pages[0].items[1];
        expect("sentences" in sentence ? sentence.sentences?.[0].id : "").toBe("s1");

        const doc = {
            pageCount: 1,
            bboxOrigin: "top-left" as const,
            bboxPrecision: 1,
            pages,
            citationIndex: buildCitationIndex(pages),
        };
        expect(doc.citationIndex.heading1.kind).toBe("item");
        expect(doc.citationIndex.s1.kind).toBe("sentence");
        expect(resolveCitation(doc, "s1")?.bboxes).toEqual([[0, 10, 80, 20]]);
    });

    it("clips overflow locators without changing page geometry or text", () => {
        const page = projectStructuredPage({
            index: 0, width: 612, height: 792, viewBox: [10, 20, 622, 812], rotation: 0,
            items: [{ id: 'p0:i0', kind: 'text', pageIndex: 0, index: 0,
                bbox: { l: -5, t: 10, r: 731, b: 810, origin: 'top-left' },
                columnIndex: 0, text: 'A sentence.', lines: [] }],
            sentences: [{ parentId: 'p0:i0', index: 0, text: 'A sentence.',
                bboxes: [{ l: 20, t: 10, r: 731, b: 30, origin: 'top-left' }] }],
        });
        expect(page.viewBox).toEqual([10, 20, 622, 812]);
        expect(page.items[0]).toMatchObject({ text: 'A sentence.', bbox: [0, 10, 612, 792],
            sentences: [{ text: 'A sentence.', bboxes: [[20, 10, 612, 30]] }] });
    });

    it("projects internal text, section headers, and margin items", () => {
        const page = projectStructuredPage({
            index: 0,
            width: 100,
            height: 100,
            viewBox: [0, 0, 100, 100],
            rotation: 0,
            items: [
                {
                    id: "p0:i0",
                    kind: "text",
                    pageIndex: 0,
                    index: 0,
                    bbox: { l: 0, t: 0, r: 50, b: 10, origin: "top-left" },
                    columnIndex: 0,
                    text: "Text.",
                    lines: [],
                },
                {
                    id: "p0:i1",
                    kind: "margin",
                    pageIndex: 0,
                    index: 1,
                    bbox: { l: 0, t: 90, r: 50, b: 100, origin: "top-left" },
                    columnIndex: 0,
                    text: "Footer",
                    lines: [],
                },
            ],
            sentences: [
                {
                    parentId: "p0:i0",
                    index: 0,
                    text: "Text.",
                    bboxes: [{ l: 0, t: 0, r: 50, b: 10, origin: "top-left" }],
                },
            ],
        });
        expect(page.items.map((item) => item.kind)).toEqual(["text", "margin"]);
        const textItem = page.items[0];
        expect("sentences" in textItem ? textItem.sentences?.[0].text : "").toBe("Text.");
        expect(SCHEMA_VERSION).toBe("4");
    });

    it("rejects page selection for structured extraction at public layers", async () => {
        const bytes = new Uint8Array();
        await expect(
            new BeaverExtractor().extract(bytes, {
                mode: "structured",
                pageIndices: [0],
            }),
        ).rejects.toMatchObject({
            code: ExtractionErrorCode.STRUCTURED_PAGE_SELECTION_REJECTED,
        } satisfies Partial<ExtractionError>);
        await expect(
            extractPdf({
                pdfData: bytes,
                mode: "structured",
                pageRange: { startIndex: 0, maxPages: 1 },
            }),
        ).rejects.toMatchObject({
            code: ExtractionErrorCode.STRUCTURED_PAGE_SELECTION_REJECTED,
        } satisfies Partial<ExtractionError>);
        await expect(
            opExtract({
                pdfData: bytes,
                mode: "structured",
                pageIndices: [0],
            }),
        ).rejects.toMatchObject({
            code: ExtractionErrorCode.STRUCTURED_PAGE_SELECTION_REJECTED,
        });
    });
});

describe("reference items", () => {
    it("defaults the item classifier to 'off'", () => {
        expect(DEFAULT_EXTRACTION_SETTINGS.itemClassifier).toBe("off");
    });

    it("projects internal reference items with their text and sentences", () => {
        const page = projectStructuredPage({
            index: 0,
            width: 100,
            height: 100,
            viewBox: [0, 0, 100, 100],
            rotation: 0,
            items: [
                {
                    id: "p0:i0",
                    kind: "reference",
                    pageIndex: 0,
                    index: 0,
                    bbox: { l: 0, t: 0, r: 90, b: 20, origin: "top-left" },
                    columnIndex: 0,
                    text: "Smith, J. (2020). A paper. Journal, 1(2), 3-4.",
                    lines: [],
                },
            ],
            sentences: [
                {
                    parentId: "p0:i0",
                    index: 0,
                    text: "Smith, J. (2020).",
                    bboxes: [{ l: 0, t: 0, r: 40, b: 20, origin: "top-left" }],
                },
            ],
        });
        expect(page.items[0]).toMatchObject({
            kind: "reference",
            text: "Smith, J. (2020). A paper. Journal, 1(2), 3-4.",
            sentences: [{ text: "Smith, J. (2020).", bboxes: [[0, 0, 40, 20]] }],
        });
    });

    it("assigns the 'ref' id prefix and indexes reference sentences", () => {
        const pages: StructuredPage[] = [
            {
                index: 0,
                width: 100,
                height: 100,
                viewBox: [0, 0, 100, 100],
                rotation: 0,
                items: [
                    {
                        id: "old",
                        kind: "reference",
                        pageIndex: 0,
                        order: 0,
                        text: "Smith, J. (2020).",
                        bbox: [0, 0, 90, 20],
                        sentences: [
                            {
                                id: "tmp",
                                order: 0,
                                text: "Smith, J. (2020).",
                                bboxes: [[0, 0, 90, 20]],
                            },
                        ],
                    },
                    {
                        id: "old2",
                        kind: "reference",
                        pageIndex: 0,
                        order: 1,
                        text: "Doe, A. (2021).",
                        bbox: [0, 20, 90, 40],
                    },
                ],
            },
        ];
        assignDocumentIds(pages);
        expect(pages[0].items.map((item) => item.id)).toEqual(["ref1", "ref2"]);

        const citationIndex = buildCitationIndex(pages);
        expect(citationIndex.ref1.kind).toBe("item");
        expect(citationIndex.s1).toMatchObject({ kind: "sentence", itemId: "ref1" });
    });
});

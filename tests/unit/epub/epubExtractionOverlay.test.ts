import { describe, expect, it } from "vitest";

import { OVERLAY_COLORS } from "../../../src/beaver-extract/debug/overlayBuilders";
import type { EpubDocument } from "../../../src/services/documentExtraction/epub";
import {
    buildEpubItemOverlay,
    buildEpubSentenceOverlay,
    colorForItemKind,
} from "../../../react/utils/epubVisualizer/epubExtractionOverlay";

describe("epubExtractionOverlay", () => {
    it("uses the shared item kind colors and preserves document order", () => {
        const out = buildEpubItemOverlay(baseDocument());

        expect(out.descriptors.map((descriptor) => descriptor.itemKind)).toEqual([
            "section_header",
            "text",
            "list_item",
            "caption",
            "footnote",
            "table",
        ]);
        expect(out.descriptors.map((descriptor) => descriptor.color)).toEqual([
            OVERLAY_COLORS.itemSectionHeader,
            OVERLAY_COLORS.itemText,
            OVERLAY_COLORS.itemList,
            OVERLAY_COLORS.itemCaption,
            OVERLAY_COLORS.itemFootnote,
            OVERLAY_COLORS.itemTable,
        ]);
        expect(out.stats).toMatchObject({
            items: 6,
            sentences: 0,
            unsupportedPictures: 1,
        });
        expect(out.descriptors[1]).toMatchObject({
            label: "P2",
            annotationComment: "section 1, item P1, text\nFirst sentence. Second sentence.",
        });
    });

    it("alternates sentence colors and skips picture items", () => {
        const out = buildEpubSentenceOverlay(baseDocument());
        const sentenceDescriptors = out.descriptors.flatMap((descriptor) =>
            descriptor.sentences ?? [],
        );

        expect(sentenceDescriptors.map((sentence) => sentence.color)).toEqual([
            OVERLAY_COLORS.sentence[0],
            OVERLAY_COLORS.sentence[1],
            OVERLAY_COLORS.sentence[0],
            OVERLAY_COLORS.sentence[1],
            OVERLAY_COLORS.sentence[0],
        ]);
        expect(sentenceDescriptors.map((sentence) => sentence.label)).toEqual([
            "S1",
            "S2",
            "S3",
            "S4",
            "S5",
        ]);
        expect(sentenceDescriptors[0]).toMatchObject({
            sentenceId: "S1",
            annotationComment: "section 1, item P1, S1\nFirst sentence.",
        });
        expect(out.descriptors.some((descriptor) => descriptor.itemKind === "picture")).toBe(false);
        expect(out.stats).toMatchObject({
            sentences: 5,
            unsupportedPictures: 1,
        });
    });

    it("exposes a kind color helper for every drawable EPUB kind", () => {
        expect(colorForItemKind("text")).toBe(OVERLAY_COLORS.itemText);
        expect(colorForItemKind("section_header")).toBe(OVERLAY_COLORS.itemSectionHeader);
        expect(colorForItemKind("list_item")).toBe(OVERLAY_COLORS.itemList);
        expect(colorForItemKind("caption")).toBe(OVERLAY_COLORS.itemCaption);
        expect(colorForItemKind("footnote")).toBe(OVERLAY_COLORS.itemFootnote);
        expect(colorForItemKind("table")).toBe(OVERLAY_COLORS.itemTable);
    });
});

function baseDocument(): EpubDocument {
    return {
        content_kind: "epub",
        schemaVersion: "1",
        sectionCount: 2,
        citationIndex: {},
        sections: [
            {
                index: 0,
                rawHref: "EPUB/chapter1.xhtml",
                items: [
                    {
                        id: "H1",
                        kind: "section_header",
                        sectionIndex: 0,
                        order: 0,
                        text: "Chapter 1",
                        level: 1,
                    },
                    {
                        id: "P1",
                        kind: "text",
                        sectionIndex: 0,
                        order: 1,
                        text: "First sentence. Second sentence.",
                        sentences: [
                            { id: "S1", text: "First sentence." },
                            { id: "S2", text: "Second sentence." },
                        ],
                    },
                    {
                        id: "L1",
                        kind: "list_item",
                        sectionIndex: 0,
                        order: 2,
                        text: "List sentence.",
                        sentences: [{ id: "S3", text: "List sentence." }],
                    },
                    {
                        id: "I1",
                        kind: "picture",
                        sectionIndex: 0,
                        order: 3,
                        text: "Decorative image",
                    },
                ],
            },
            {
                index: 1,
                rawHref: "EPUB/chapter2.xhtml",
                items: [
                    {
                        id: "C1",
                        kind: "caption",
                        sectionIndex: 1,
                        order: 4,
                        text: "Caption sentence.",
                        sentences: [{ id: "S4", text: "Caption sentence." }],
                    },
                    {
                        id: "F1",
                        kind: "footnote",
                        sectionIndex: 1,
                        order: 5,
                        text: "Footnote sentence.",
                        sentences: [{ id: "S5", text: "Footnote sentence." }],
                    },
                    {
                        id: "T1",
                        kind: "table",
                        sectionIndex: 1,
                        order: 6,
                        text: "Cell A Cell B",
                    },
                ],
            },
        ],
    };
}

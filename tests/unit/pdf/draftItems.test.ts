import { describe, expect, it } from "vitest";

import { bboxFromXYWH, type RawLineDetailed, type RawPageDataDetailed } from "@beaver/agent-core/extract/types";
import { extractPageSentences } from "../../../src/beaver-extract/ParagraphSentenceMapper";
import { simpleRegexSentenceSplit } from "../../../src/beaver-extract/SentenceMapper";
import type { PageLine } from "../../../src/beaver-extract/LineDetector";
import type { PageParagraphResult } from "../../../src/beaver-extract/ParagraphDetector";
import {
    draftItemsFromParagraphs,
    draftPageFromParagraphs,
    publicItemText,
} from "../../../src/beaver-extract/pipeline/draftItems";

function detailedLine(text: string, y: number): RawLineDetailed {
    const charWidth = 5;
    const bbox = bboxFromXYWH(72, y, text.length * charWidth, 12, "top-left");
    return {
        text,
        bbox,
        wmode: 0,
        x: 72,
        y,
        font: {
            name: "Test",
            family: "Test",
            size: 12,
            weight: "normal",
            style: "normal",
        },
        chars: Array.from(text).map((c, i) => {
            const charBox = bboxFromXYWH(
                72 + i * charWidth,
                y,
                charWidth,
                12,
                "top-left",
            );
            return {
                c,
                bbox: charBox,
                quad: [
                    charBox.l,
                    charBox.t,
                    charBox.r,
                    charBox.t,
                    charBox.l,
                    charBox.b,
                    charBox.r,
                    charBox.b,
                ],
            };
        }),
    };
}

function pageLine(line: RawLineDetailed): PageLine {
    return {
        text: line.text,
        bbox: line.bbox,
        bboxes: [line.bbox],
        fontSize: line.font.size,
        spans: [
            {
                text: line.text,
                bbox: line.bbox,
                lineBBox: line.bbox,
                size: line.font.size,
                fontName: line.font.name,
                fontWeight: line.font.weight,
                fontStyle: line.font.style,
            },
        ],
    };
}

function page(): { detailedPage: RawPageDataDetailed; paragraphResult: PageParagraphResult } {
    const heading = detailedLine("Section Title", 96);
    const body = detailedLine("First sentence. Second sentence.", 132);
    const detailedPage: RawPageDataDetailed = {
        pageIndex: 2,
        pageNumber: 3,
        width: 612,
        height: 792,
        viewBox: [0, 0, 612, 792],
        rotation: 0,
        blocks: [{ type: "text", bbox: bboxFromXYWH(72, 96, 240, 48, "top-left"), lines: [heading, body] }],
    };
    const item = (type: "header" | "paragraph", text: string, line: RawLineDetailed, index: number) => ({
        type,
        idx: index,
        docIdx: index,
        start: 0,
        end: text.length,
        text,
        id: "",
        bbox: line.bbox,
        columnIndex: 0,
    });
    const paragraphResult: PageParagraphResult = {
        pageIndex: 2,
        width: 612,
        height: 792,
        pageContent: "## Section Title\n\nFirst sentence. Second sentence.",
        items: [item("header", "## Section Title", heading, 0), item("paragraph", body.text, body, 1)],
        paragraphCount: 1,
        headerCount: 1,
        itemLines: [[pageLine(heading)], [pageLine(body)]],
    };
    return { detailedPage, paragraphResult };
}

describe("draft items", () => {
    it("carry the kind as a field and drop the detector's heading marker", () => {
        const { paragraphResult } = page();
        const draft = draftPageFromParagraphs(paragraphResult);
        expect(draft).toMatchObject({ pageIndex: 2, width: 612, height: 792 });
        expect(draft.items.map((item) => [item.kind, item.text])).toEqual([
            ["section_header", "Section Title"],
            ["text", "First sentence. Second sentence."],
        ]);
        expect(draft.items.map((item) => item.roles)).toEqual([[null], [null]]);
        expect(draft.items.map(publicItemText)).toEqual(paragraphResult.items.map((item) => item.text));
    });

    it("map to items whose public heading text keeps the marker, unlike a heading relabeled as a reference", () => {
        const { detailedPage, paragraphResult } = page();
        const items = draftItemsFromParagraphs(paragraphResult);
        const asHeading = extractPageSentences(detailedPage, {
            splitter: simpleRegexSentenceSplit,
            precomputed: { items },
        });
        expect(asHeading.items.map((item) => [item.kind, "text" in item ? item.text : undefined])).toEqual([
            ["section_header", "## Section Title"],
            ["text", "First sentence. Second sentence."],
        ]);
        const asReference = extractPageSentences(detailedPage, {
            splitter: simpleRegexSentenceSplit,
            precomputed: { items: [{ ...items[0], kind: "reference" }, items[1]] },
        });
        expect(asReference.items[0]).toMatchObject({ kind: "reference", text: "Section Title" });
        expect(asReference.sentences.map((s) => s.parentId)).toEqual(["p2:i1", "p2:i1"]);
    });
});

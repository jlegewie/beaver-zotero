import { describe, expect, it } from "vitest";

import {
    extractPageSentences,
    simpleRegexSentenceSplit,
    type InternalProcessedPage,
    type RawLineDetailed,
    type RawPageDataDetailed,
} from "../../../src/beaver-extract";
import { bboxFromXYWH } from "../../../src/beaver-extract/types";
import type { PageLine } from "../../../src/beaver-extract/LineDetector";
import type {
    ContentItem,
    PageParagraphResult,
} from "../../../src/beaver-extract/ParagraphDetector";

const PAGE_W = 612;
const PAGE_H = 792;

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

function contentItem(
    type: ContentItem["type"],
    text: string,
    bbox: RawLineDetailed["bbox"],
    index: number,
): ContentItem {
    return {
        type,
        idx: index,
        docIdx: index,
        start: 0,
        end: text.length,
        text,
        id: `legacy-${index}`,
        bbox,
        columnIndex: 0,
    };
}

function buildPage(): {
    detailedPage: RawPageDataDetailed;
    paragraphResult: PageParagraphResult;
} {
    const heading = detailedLine("Section Title", 96);
    const body = detailedLine("First sentence. Second sentence.", 132);
    const detailedPage: RawPageDataDetailed = {
        pageIndex: 0,
        pageNumber: 1,
        width: PAGE_W,
        height: PAGE_H,
        blocks: [
            {
                type: "text",
                bbox: bboxFromXYWH(72, 96, 240, 48, "top-left"),
                lines: [heading, body],
            },
        ],
    };
    const paragraphResult: PageParagraphResult = {
        pageIndex: 0,
        width: PAGE_W,
        height: PAGE_H,
        pageContent: "## Section Title\n\nFirst sentence. Second sentence.",
        items: [
            contentItem("header", heading.text, heading.bbox, 0),
            contentItem("paragraph", body.text, body.bbox, 1),
        ],
        paragraphCount: 1,
        headerCount: 1,
        itemLines: [[pageLine(heading)], [pageLine(body)]],
    };
    return { detailedPage, paragraphResult };
}

describe("processed page sentence view", () => {
    it("keeps item sentences authoritative and page.sentences as the flat view", () => {
        const { detailedPage, paragraphResult } = buildPage();
        const result = extractPageSentences(detailedPage, {
            splitter: simpleRegexSentenceSplit,
            precomputed: { paragraphResult },
        });
        const page: InternalProcessedPage = {
            index: result.pageIndex,
            width: result.width,
            height: result.height,
            content: paragraphResult.pageContent,
            columns: [],
            items: result.items,
            sentences: result.sentences,
            degradation: result.degradation,
        };

        expect(page.items).toHaveLength(2);
        expect(page.items[0].kind).toBe("section_header");
        expect("sentences" in page.items[0]).toBe(false);

        const textItem = page.items[1];
        expect(textItem.kind).toBe("text");
        if (textItem.kind !== "text") throw new Error("expected text item");
        expect(textItem.sentences).toHaveLength(2);
        expect(page.sentences).toHaveLength(2);

        expect(page.sentences![0]).toBe(textItem.sentences![0]);
        expect(page.sentences![1]).toBe(textItem.sentences![1]);

        page.sentences![0].joinWithNext = true;
        expect(textItem.sentences![0].joinWithNext).toBe(true);

        const serialized = JSON.parse(JSON.stringify(page)) as InternalProcessedPage;
        for (const sentence of serialized.sentences ?? []) {
            const parent = serialized.items.find((item) => item.id === sentence.parentId);
            expect(parent?.kind).toBe("text");
            if (parent?.kind !== "text") continue;
            const itemSentence = parent.sentences?.[sentence.index];
            expect(itemSentence).toEqual(sentence);
        }
    });
});

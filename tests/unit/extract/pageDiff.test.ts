import { describe, expect, it } from "vitest";

import {
    diffMarkdownPages,
    diffStructuredPages,
} from "../../../src/beaver-extract/cli/fixture/pageDiff";
import type { MarkdownPage, StructuredPage } from "../../../src/beaver-extract/schema";

function structuredPage(): StructuredPage {
    return {
        index: 0,
        width: 100,
        height: 200,
        viewBox: [0, 0, 100, 200],
        rotation: 0,
        items: [
            {
                id: "p0",
                kind: "text",
                pageIndex: 0,
                order: 0,
                bbox: [10, 10, 50, 20],
                text: "Hello world.",
                sentences: [
                    {
                        id: "s0",
                        order: 0,
                        text: "Hello world.",
                        bboxes: [[10, 10, 50, 20]],
                    },
                ],
            },
        ],
    };
}

function markdownPage(markdown = "Hello world."): MarkdownPage {
    return {
        index: 0,
        width: 100,
        height: 200,
        viewBox: [0, 0, 100, 200],
        rotation: 0,
        markdown,
    };
}

describe("pageDiff", () => {
    it("uses absolute bbox tolerance per coordinate", () => {
        const expected = [structuredPage()];
        const within = [structuredPage()];
        within[0].items[0].bbox = [10.4, 10, 50, 20];
        expect(diffStructuredPages(expected, within, { bboxAbsPt: 0.5 })).toEqual([]);

        const outside = [structuredPage()];
        outside[0].items[0].bbox = [10.6, 10, 50, 20];
        const diffs = diffStructuredPages(expected, outside, { bboxAbsPt: 0.5 });
        expect(diffs).toHaveLength(1);
        expect(diffs[0]).toMatchObject({
            kind: "tolerance",
            path: "pages[0].items[0].bbox",
        });
        expect(diffs[0].note).toContain("0.600pt");
    });

    it("normalizes markdown whitespace but reports substantive changes", () => {
        expect(
            diffMarkdownPages(
                [markdownPage("Hello   world.\n\nNext")],
                [markdownPage("Hello world. Next")],
            ),
        ).toEqual([]);

        const diffs = diffMarkdownPages(
            [markdownPage("Hello world.")],
            [markdownPage("Different world.")],
        );
        expect(diffs).toMatchObject([
            { kind: "changed", path: "pages[0].markdown" },
        ]);
    });

    it("ignores extra trailing actual margin items only", () => {
        const expected = [structuredPage()];
        const actualMargin = [structuredPage()];
        actualMargin[0].items.push({
            id: "margin1",
            kind: "margin",
            pageIndex: 0,
            order: 1,
            bbox: [0, 190, 100, 200],
            text: "Footer",
        });
        expect(diffStructuredPages(expected, actualMargin, { bboxAbsPt: 0.5 })).toEqual([]);

        const actualText = [structuredPage()];
        actualText[0].items.push({
            id: "p1",
            kind: "text",
            pageIndex: 0,
            order: 1,
            bbox: [0, 30, 100, 40],
            text: "Extra",
        });
        const diffs = diffStructuredPages(expected, actualText, { bboxAbsPt: 0.5 });
        expect(diffs.some((d) => d.kind === "extra")).toBe(true);
    });

    it("reports page-level scalar mismatches before item diffs", () => {
        const expected = [structuredPage()];
        const actual = [structuredPage()];
        actual[0].width = 101;
        const diffs = diffStructuredPages(expected, actual, { bboxAbsPt: 0.5 });
        expect(diffs[0]).toMatchObject({
            kind: "changed",
            path: "pages[0].width",
            expected: 100,
            actual: 101,
        });
    });
});

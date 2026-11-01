/**
 * Per-glyph style runs recorded by the detailed walk (`RawLine.styleRuns`).
 *
 * MuPDF reports a line's font from its first glyph; the detailed walk also
 * records which font and size every visible glyph uses, so heading detection
 * can judge a line by its majority styling.
 */

import { describe, expect, it } from "vitest";

import type { RawLineDetailed } from "@beaver/agent-core/extract/types";

import { type DetailedWalkExtras, extractRawPageDetailedFromDoc } from "../../../src/beaver-extract/worker/docHelpers";
import type {
    DocumentLike,
    FontApi,
    PageLike,
    QuadTuple,
    StructuredTextLike,
    StructuredTextWalker,
} from "../../../src/beaver-extract/worker/mupdfApi";

const BOLD_PTR = 1;
const REGULAR_PTR = 2;

const FONT_API: FontApi = {
    getName: (ptr) => (ptr === BOLD_PTR ? "ABCDEF+Sans-Bold" : "ABCDEF+Sans"),
    isBold: (ptr) => ptr === BOLD_PTR,
    isItalic: () => false,
};

/** One glyph segment of the fake line: text set in one font at one size. */
interface Segment {
    text: string;
    fontPtr: number;
    size: number;
    /** Baseline shift upward (a superscript), in points. */
    rise?: number;
}

function fakeDoc(segments: Segment[]): DocumentLike {
    const glyphs = segments.flatMap((s) =>
        Array.from(s.text).map((rune) => ({ rune, fontPtr: s.fontPtr, size: s.size, rise: s.rise ?? 0 })),
    );
    const stext = (): StructuredTextLike => ({
        pointer: 1,
        asText: () => "",
        asJSON: () => "{}",
        walk: (walker: StructuredTextWalker) => {
            walker.beginTextBlock?.([10, 10, 310, 20]);
            walker.beginLine?.([10, 10, 310, 20], 0, [1, 0]);
            walker.onLineFont?.(glyphs[0].fontPtr, glyphs[0].size);
            glyphs.forEach((g, i) => {
                const x = 10 + i * 4;
                // Glyph box 10–20 with its baseline at 18, raised by `rise`.
                const quad: QuadTuple = [x, 10 - g.rise, x + 4, 10 - g.rise, x, 20 - g.rise, x + 4, 20 - g.rise];
                walker.onCharFont?.(g.fontPtr, g.size);
                walker.onCharOrigin?.(x, 18 - g.rise);
                walker.onChar?.(g.rune, quad);
            });
            walker.endLine?.();
            walker.endTextBlock?.();
        },
        destroy: () => {},
    });
    const page = {
        pointer: 1,
        getBounds: () => [0, 0, 600, 800],
        getRotation: () => 0,
        getViewBox: () => [0, 0, 600, 800],
        getLabel: () => undefined,
        toStructuredText: () => stext(),
        destroy: () => {},
    } as unknown as PageLike;
    return {
        pointer: 1,
        needsPassword: () => false,
        countPages: () => 1,
        getMetadata: () => undefined,
        loadPage: () => page,
        destroy: () => {},
    } as DocumentLike;
}

const RUN_IN_LABEL: Segment[] = [
    { text: "Keywords: ", fontPtr: BOLD_PTR, size: 9.96 },
    { text: "policing; education 2022", fontPtr: REGULAR_PTR, size: 9.96 },
];

function firstLine(
    doc: DocumentLike,
    styleRuns: boolean,
    fontApi: FontApi | undefined,
    extras: DetailedWalkExtras = {},
) {
    const page = extractRawPageDetailedFromDoc(doc, 0, false, fontApi, true, { ...extras, styleRuns });
    return page.blocks[0].lines![0] as RawLineDetailed;
}

describe("detailed-walk style runs", () => {
    it("records one run per font, counting visible glyphs and letters", () => {
        const line = firstLine(fakeDoc(RUN_IN_LABEL), true, FONT_API);
        expect(line.font.name).toBe("ABCDEF+Sans-Bold");
        expect(line.styleRuns).toEqual([
            {
                font: { name: "ABCDEF+Sans-Bold", family: "ABCDEF+Sans", weight: "bold", style: "normal", size: 9 },
                exactSize: 9.96,
                chars: 9,
                letters: 8,
            },
            {
                font: { name: "ABCDEF+Sans", family: "ABCDEF+Sans", weight: "normal", style: "normal", size: 9 },
                exactSize: 9.96,
                chars: 22,
                letters: 17,
            },
        ]);
    });

    it("starts a new run when the size changes within one font", () => {
        const line = firstLine(
            fakeDoc([
                { text: "I", fontPtr: REGULAR_PTR, size: 10 },
                { text: "NTRODUCTION", fontPtr: REGULAR_PTR, size: 8 },
            ]),
            true,
            FONT_API,
        );
        expect(line.styleRuns!.map((r) => [r.font.size, r.chars])).toEqual([
            [10, 1],
            [8, 11],
        ]);
    });

    it("does not split a run at a whitespace glyph set in another font", () => {
        const line = firstLine(
            fakeDoc([
                { text: "Group", fontPtr: REGULAR_PTR, size: 6 },
                { text: " ", fontPtr: BOLD_PTR, size: 6 },
                { text: "two", fontPtr: REGULAR_PTR, size: 6 },
            ]),
            true,
            FONT_API,
        );
        expect(line.styleRuns!.map((r) => [r.font.name, r.chars])).toEqual([["ABCDEF+Sans", 8]]);
    });

    it("records the baseline, ascent and descent of the visible glyphs per size", () => {
        const line = firstLine(
            fakeDoc([
                { text: "x squared", fontPtr: REGULAR_PTR, size: 9.96 },
                { text: "2", fontPtr: REGULAR_PTR, size: 6, rise: 4 },
                { text: " here", fontPtr: REGULAR_PTR, size: 9.96 },
            ]),
            true,
            FONT_API,
        );
        expect(line.glyphMetrics).toEqual([
            { size: 10, glyphs: 12, baseline: 18, top: 10, bottom: 20 },
            { size: 6, glyphs: 1, baseline: 14, top: 6, bottom: 16 },
        ]);
    });

    it("records no runs when the preset disables them (schema 4)", () => {
        const line = firstLine(fakeDoc(RUN_IN_LABEL), false, FONT_API);
        expect(line.styleRuns).toBeUndefined();
        expect(line.glyphMetrics).toBeUndefined();
    });

    it("records no runs without the font API", () => {
        expect(firstLine(fakeDoc(RUN_IN_LABEL), true, undefined).styleRuns).toBeUndefined();
    });

    it("records style runs and region font spans together in one walk", () => {
        const line = firstLine(fakeDoc(RUN_IN_LABEL), true, FONT_API, { fontSpans: true });
        expect(line.styleRuns!.map((r) => [r.font.weight, r.chars])).toEqual([
            ["bold", 9],
            ["normal", 22],
        ]);
        expect(line.spans!.map((s) => [s.start, s.font.weight, s.font.size])).toEqual([
            [0, "bold", 9.96],
            [10, "normal", 9.96],
        ]);
    });

    it("records font spans without style runs when only regions ask for them", () => {
        const line = firstLine(fakeDoc(RUN_IN_LABEL), false, FONT_API, { fontSpans: true });
        expect(line.styleRuns).toBeUndefined();
        expect(line.spans).toHaveLength(2);
    });
});

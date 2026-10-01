/**
 * Sentence terminators inside a run of unmapped glyphs.
 *
 * Text repair can map the period of an otherwise unmappable font while its
 * digits stay U+FFFD, so a hidden figure number reads "�.����". Left alone,
 * the splitter ends a sentence at each of those periods. Schema-5 walks fold
 * such terminators back into the unmapped run; schema-4 walks are untouched.
 */

import { describe, expect, it } from "vitest";

import {
    extractRawPageDetailedFromDoc,
    extractRawPageFromDoc,
    maskTerminatorsInUnmappedRuns,
} from "../../../src/beaver-extract/worker/docHelpers";
import type {
    DocumentLike,
    PageLike,
    QuadTuple,
    StructuredTextLike,
    StructuredTextWalker,
} from "../../../src/beaver-extract/worker/mupdfApi";
import type { RawLine, RawLineDetailed } from "@beaver/agent-core/extract/types";

const R = "�";

function mask(text: string): string {
    const chars = Array.from(text);
    maskTerminatorsInUnmappedRuns(chars);
    return chars.join("");
}

describe("maskTerminatorsInUnmappedRuns", () => {
    it("folds a period between unmapped glyphs into the run", () => {
        expect(mask(`4.7 ${R}.${R}${R}${R}${R} ${R}.${R}${R}${R}${R}`)).toBe(
            `4.7 ${R.repeat(6)} ${R.repeat(6)}`,
        );
    });

    it("folds a run of several terminators", () => {
        expect(mask(`${R}?!${R}`)).toBe(R.repeat(4));
        expect(mask(`${R}。${R}`)).toBe(R.repeat(3));
    });

    it("keeps a terminator with readable text on either side", () => {
        for (const text of [
            `equals ${R}.`,
            `${R}. Next`,
            `${R}.5`,
            `1.${R}`,
            `${R} . ${R}`,
            `(${R}).`,
        ]) {
            expect(mask(text)).toBe(text);
        }
    });

    it("keeps other punctuation between unmapped glyphs", () => {
        const text = `${R},${R} ${R}-${R} (${R})`;
        expect(mask(text)).toBe(text);
    });

    it("reports whether anything changed", () => {
        expect(maskTerminatorsInUnmappedRuns(Array.from(`${R}.${R}`))).toBe(true);
        expect(maskTerminatorsInUnmappedRuns(Array.from("a.b"))).toBe(false);
    });
});

// A single-line page. Plenty of readable text keeps the page below the
// unmapped-text-layer threshold, so no recovery re-walk happens.
const LINE = `Readable caption text for the figure panel ${R}.${R}${R} end.`;

function fakeDoc(text: string): { doc: DocumentLike; options: string[] } {
    const options: string[] = [];
    const runes = Array.from(text);
    const stext = (): StructuredTextLike => ({
        pointer: 1,
        asText: () => text,
        asJSON: () =>
            JSON.stringify({
                blocks: [
                    {
                        type: "text",
                        bbox: { x: 10, y: 10, w: 300, h: 10 },
                        lines: [
                            {
                                wmode: 0,
                                bbox: { x: 10, y: 10, w: 300, h: 10 },
                                font: { name: "F", family: "F", weight: "normal", style: "normal", size: 10 },
                                x: 10,
                                y: 18,
                                text,
                            },
                        ],
                    },
                ],
            }),
        walk: (walker: StructuredTextWalker) => {
            walker.beginTextBlock?.([10, 10, 310, 20]);
            walker.beginLine?.([10, 10, 310, 20], 0, [1, 0]);
            walker.onLineFont?.(0, 10);
            runes.forEach((rune, i) => {
                const x = 10 + i * 4;
                const quad: QuadTuple = [x, 10, x + 4, 10, x, 20, x + 4, 20];
                walker.onChar?.(rune, quad);
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
        toStructuredText: (opts?: string) => {
            options.push(opts ?? "");
            return stext();
        },
        destroy: () => {},
    } as unknown as PageLike;
    const doc = {
        pointer: 1,
        needsPassword: () => false,
        countPages: () => 1,
        getMetadata: () => undefined,
        loadPage: () => page,
        destroy: () => {},
    } as DocumentLike;
    return { doc, options };
}

const MASKED = `Readable caption text for the figure panel ${R.repeat(4)} end.`;

describe("page walks", () => {
    it("mask terminators in the detailed walk with text repair, keeping chars in lockstep", () => {
        const { doc, options } = fakeDoc(LINE);
        const page = extractRawPageDetailedFromDoc(doc, 0, false, undefined, true);
        const line = page.blocks[0].lines![0] as RawLineDetailed;
        expect(options).toHaveLength(1);
        expect(line.text).toBe(MASKED);
        expect(line.chars.map((c) => c.c).join("")).toBe(MASKED);
    });

    it("mask terminators in the JSON walk with text repair", () => {
        const { doc } = fakeDoc(LINE);
        const page = extractRawPageFromDoc(doc, 0, { textRepair: true });
        expect((page.blocks[0].lines![0] as RawLine).text).toBe(MASKED);
    });

    it("leave schema-4 walks untouched", () => {
        const detailed = extractRawPageDetailedFromDoc(fakeDoc(LINE).doc, 0, false, undefined, false);
        const detailedLine = detailed.blocks[0].lines![0] as RawLineDetailed;
        expect(detailedLine.text).toBe(LINE);
        expect(detailedLine.chars.map((c) => c.c).join("")).toBe(LINE);

        const plain = extractRawPageFromDoc(fakeDoc(LINE).doc, 0, { textRepair: false });
        expect((plain.blocks[0].lines![0] as RawLine).text).toBe(LINE);
    });
});

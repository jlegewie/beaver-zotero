import { describe, it, expect } from "vitest";
import {
    isUnmappedTextLayer,
    recoveredTextIsAcceptable,
    collectPageText,
    GLYPH_NAME_RECOVERY,
} from "../../../src/beaver-extract/glyphNameRecovery";
import type { RawBlock } from "../../../src/beaver-extract/types";

// Minimal page builder — the recovery helpers only read block.type,
// block.lines and line.text.
function page(lines: string[], type: "text" | "image" = "text") {
    const block = {
        type,
        bbox: { l: 0, t: 0, r: 0, b: 0, origin: "top-left" },
        lines: lines.map((text) => ({
            wmode: 0,
            bbox: { l: 0, t: 0, r: 0, b: 0, origin: "top-left" },
            font: { name: "", family: "", weight: "normal", style: "normal", size: 10 },
            x: 0,
            y: 0,
            text,
        })),
    } as unknown as RawBlock;
    return { blocks: [block] };
}

const FFFD = "�";
const rep = (n: number) => FFFD.repeat(n);

describe("glyphNameRecovery", () => {
    describe("collectPageText", () => {
        it("concatenates text-block line text and skips image blocks", () => {
            const p = { blocks: [...page(["ab", "cd"]).blocks, ...page([], "image").blocks] };
            expect(collectPageText(p)).toBe("abcd");
        });
    });

    describe("isUnmappedTextLayer", () => {
        it("flags a page that is overwhelmingly U+FFFD with real glyph volume", () => {
            expect(isUnmappedTextLayer(page([rep(200)]))).toBe(true);
        });

        it("does NOT flag a normal page with a few unknown symbols (case 2)", () => {
            // Mostly good text, one stray unmappable symbol — far below threshold.
            const body = "The quick brown fox jumps over the lazy dog. ".repeat(5);
            expect(isUnmappedTextLayer(page([body + FFFD + "40"]))).toBe(false);
        });

        it("does NOT flag a blank / image-only page (too few glyphs)", () => {
            expect(isUnmappedTextLayer(page([rep(10)]))).toBe(false);
            expect(isUnmappedTextLayer(page([], "image"))).toBe(false);
        });

        it("ignores whitespace when measuring volume and ratio", () => {
            // 60 U+FFFD interleaved with spaces — still an unmapped layer.
            const spaced = rep(60).split("").join(" ");
            expect(isUnmappedTextLayer(page([spaced]))).toBe(true);
        });

        it("respects the configured thresholds at the boundary", () => {
            // Exactly at minGlyphs with ratio exactly at threshold.
            const total = GLYPH_NAME_RECOVERY.minGlyphs;
            const replCount = Math.ceil(total * GLYPH_NAME_RECOVERY.replacementRatioToRetry);
            const text = rep(replCount) + "a".repeat(total - replCount);
            expect(isUnmappedTextLayer(page([text]))).toBe(true);
        });
    });

    describe("recoveredTextIsAcceptable", () => {
        it("accepts recovered natural-language text", () => {
            const recovered = "Management of risks, uncertainties and opportunities on projects".repeat(3);
            expect(recoveredTextIsAcceptable(page([recovered]))).toBe(true);
        });

        it("rejects text that still has many U+FFFD (recovery failed)", () => {
            const half = "word ".repeat(20) + rep(120);
            expect(recoveredTextIsAcceptable(page([half]))).toBe(false);
        });

        it("rejects digit/punctuation soup (glyph-index misdecode)", () => {
            // Few letters — a wrong C<n> decode produces numbers/symbols.
            const soup = "640 73-9 12.5 88% (4) 6/40 ".repeat(10);
            expect(recoveredTextIsAcceptable(page([soup]))).toBe(false);
        });

        it("rejects an empty page", () => {
            expect(recoveredTextIsAcceptable(page([]))).toBe(false);
        });
    });
});

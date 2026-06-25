import { describe, it, expect } from "vitest";
import {
    isUnmappedTextLayer,
    recoveredTextIsAcceptable,
    collectPageText,
    UNMAPPED_GLYPH_RECOVERY,
} from "../../../src/beaver-extract/unmappedGlyphRecovery";
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

describe("unmappedGlyphRecovery", () => {
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

        it("flags a SPARSE fully-unmapped page (short title/divider)", () => {
            // A short title page from a CID-fallback font is all U+FFFD. It
            // must still recover — the glyph floor only excludes no-text pages.
            expect(isUnmappedTextLayer(page([rep(8)]))).toBe(true);
        });

        it("does NOT flag a page with no text layer (blank / image-only)", () => {
            expect(isUnmappedTextLayer(page([]))).toBe(false);
            expect(isUnmappedTextLayer(page([], "image"))).toBe(false);
            expect(isUnmappedTextLayer(page(["   \n  "]))).toBe(false);
        });

        it("ignores whitespace when measuring volume and ratio", () => {
            // 60 U+FFFD interleaved with spaces — still an unmapped layer.
            const spaced = rep(60).split("").join(" ");
            expect(isUnmappedTextLayer(page([spaced]))).toBe(true);
        });

        it("respects the replacement-ratio threshold at the boundary", () => {
            // 10 chars, exactly at the ratio threshold → flagged.
            const replCount = Math.ceil(10 * UNMAPPED_GLYPH_RECOVERY.replacementRatioToRetry);
            const atThreshold = rep(replCount) + "a".repeat(10 - replCount);
            expect(isUnmappedTextLayer(page([atThreshold]))).toBe(true);
            // Just under the ratio threshold → not flagged.
            const underThreshold = rep(replCount - 1) + "a".repeat(10 - replCount + 1);
            expect(isUnmappedTextLayer(page([underThreshold]))).toBe(false);
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

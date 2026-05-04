/**
 * Unit tests for the sentence post-processing pipeline.
 *
 * These exercise `mergeLabelSentences` (the only step right now) by
 * feeding it hand-constructed `SentenceRange[]` that simulate what
 * sentencex returns when it (incorrectly) splits a label off from its
 * following sentence.
 *
 * Hermetic — no WASM, no Zotero, just pure functions.
 */

import { describe, it, expect } from "vitest";
import {
    applyPostProcessing,
    mergeLabelSentences,
} from "../../../src/services/pdf/sentencePostprocess";
import type { SentenceRange } from "../../../src/services/pdf/SentenceMapper";

/**
 * Build `SentenceRange[]` by walking pre-split chunks from left to
 * right. Each chunk corresponds to one range; the trailing whitespace
 * between chunks is consumed by the splitter (i.e. NOT part of any
 * range), matching the simpleRegexSentenceSplit / sentencex contract.
 */
function rangesFromChunks(
    text: string,
    chunks: ReadonlyArray<string>,
): SentenceRange[] {
    const ranges: SentenceRange[] = [];
    let cursor = 0;
    for (const chunk of chunks) {
        const idx = text.indexOf(chunk, cursor);
        if (idx === -1) {
            throw new Error(`chunk not found in text: ${JSON.stringify(chunk)}`);
        }
        ranges.push({ start: idx, end: idx + chunk.length });
        cursor = idx + chunk.length;
    }
    return ranges;
}

function slice(text: string, ranges: SentenceRange[]): string[] {
    return ranges.map((r) => text.slice(r.start, r.end));
}

describe("applyPostProcessing", () => {
    it("returns [] for empty input", () => {
        expect(applyPostProcessing([], "")).toEqual([]);
    });

    it("is a no-op when no labels are present", () => {
        const text = "First sentence. Second sentence.";
        const ranges = rangesFromChunks(text, [
            "First sentence.",
            "Second sentence.",
        ]);
        expect(slice(text, applyPostProcessing(ranges, text))).toEqual([
            "First sentence.",
            "Second sentence.",
        ]);
    });
});

describe("mergeLabelSentences", () => {
    it("merges 'Figure 1.' with the following sentence", () => {
        const text =
            "Figure 1. Effect of Operation Impact on English Language Arts.";
        const ranges = rangesFromChunks(text, [
            "Figure 1.",
            "Effect of Operation Impact on English Language Arts.",
        ]);
        const out = mergeLabelSentences(ranges, text);
        expect(slice(text, out)).toEqual([
            "Figure 1. Effect of Operation Impact on English Language Arts.",
        ]);
    });

    it("merges a bare numeric '2.' with the following sentence", () => {
        const text = "2. Research Method";
        const ranges = rangesFromChunks(text, ["2.", "Research Method"]);
        const out = mergeLabelSentences(ranges, text);
        expect(slice(text, out)).toEqual(["2. Research Method"]);
    });

    it("merges multi-segment numeric labels like '3.1.'", () => {
        const text = "3.1. Subsection title here.";
        const ranges = rangesFromChunks(text, [
            "3.1.",
            "Subsection title here.",
        ]);
        expect(slice(text, mergeLabelSentences(ranges, text))).toEqual([
            "3.1. Subsection title here.",
        ]);
    });

    it("merges German label 'Abbildung 4.'", () => {
        const text =
            "Abbildung 4. Effekt der Operation auf die Testergebnisse.";
        const ranges = rangesFromChunks(text, [
            "Abbildung 4.",
            "Effekt der Operation auf die Testergebnisse.",
        ]);
        expect(slice(text, mergeLabelSentences(ranges, text))).toEqual([
            "Abbildung 4. Effekt der Operation auf die Testergebnisse.",
        ]);
    });

    it("merges French label 'Tableau 5.'", () => {
        const text = "Tableau 5. Résultats principaux.";
        const ranges = rangesFromChunks(text, [
            "Tableau 5.",
            "Résultats principaux.",
        ]);
        expect(slice(text, mergeLabelSentences(ranges, text))).toEqual([
            "Tableau 5. Résultats principaux.",
        ]);
    });

    it("merges a CJK label '图 1' followed by content", () => {
        const text = "图 1 概述。";
        const ranges = rangesFromChunks(text, ["图 1", "概述。"]);
        expect(slice(text, mergeLabelSentences(ranges, text))).toEqual([
            "图 1 概述。",
        ]);
    });

    it("does NOT merge 'OK.' with the following sentence", () => {
        const text = "OK. This is fine.";
        const ranges = rangesFromChunks(text, ["OK.", "This is fine."]);
        expect(slice(text, mergeLabelSentences(ranges, text))).toEqual([
            "OK.",
            "This is fine.",
        ]);
    });

    it("does NOT merge 'Yes. No.'", () => {
        const text = "Yes. No.";
        const ranges = rangesFromChunks(text, ["Yes.", "No."]);
        expect(slice(text, mergeLabelSentences(ranges, text))).toEqual([
            "Yes.",
            "No.",
        ]);
    });

    it("leaves a trailing label alone (nothing to merge into)", () => {
        // Single-range input where the only range looks like a label.
        // Should be left as-is — dropping it would lose offsets, and
        // bare labels can occur as legitimate captions in their own
        // paragraph.
        const text = "Figure 1.";
        const ranges = rangesFromChunks(text, ["Figure 1."]);
        expect(slice(text, mergeLabelSentences(ranges, text))).toEqual([
            "Figure 1.",
        ]);
    });

    it("merges multiple sequential numeric items in order", () => {
        // sentencex tends to split list items into [label, content,
        // label, content, ...]. Verify each label binds to its own
        // content rather than chaining across items.
        const text = "1. First. 2. Second. 3. Third.";
        const ranges = rangesFromChunks(text, [
            "1.",
            "First.",
            "2.",
            "Second.",
            "3.",
            "Third.",
        ]);
        expect(slice(text, mergeLabelSentences(ranges, text))).toEqual([
            "1. First.",
            "2. Second.",
            "3. Third.",
        ]);
    });

    it("does NOT match a long range that happens to start with 'Figure 1.'", () => {
        // The label regex is anchored on the trimmed range text. A
        // single splitter range that starts with "Figure 1." but is
        // long won't match the pattern and won't be treated as a
        // label.
        const text =
            "Figure 1. Effect of Operation Impact on English Language Arts. Following content.";
        const ranges = rangesFromChunks(text, [
            // Simulate sentencex correctly keeping the caption together
            "Figure 1. Effect of Operation Impact on English Language Arts.",
            "Following content.",
        ]);
        const out = mergeLabelSentences(ranges, text);
        // Already correctly split — post-processor should be a no-op.
        expect(slice(text, out)).toEqual([
            "Figure 1. Effect of Operation Impact on English Language Arts.",
            "Following content.",
        ]);
    });

    it("collapses two consecutive labels into one merged range", () => {
        // Pathological: 'Figure 1.' followed immediately by '2.'
        // followed by content. Both labels should bind to the trailing
        // content, producing one merged range covering all three.
        const text = "Figure 1. 2. Content here.";
        const ranges = rangesFromChunks(text, [
            "Figure 1.",
            "2.",
            "Content here.",
        ]);
        expect(slice(text, mergeLabelSentences(ranges, text))).toEqual([
            "Figure 1. 2. Content here.",
        ]);
    });

    it("returns an empty array for empty input", () => {
        expect(mergeLabelSentences([], "")).toEqual([]);
    });
});

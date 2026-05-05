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
    splitOnEnumeratedListAfterColon,
    splitTrailingNumericSubsectionLabel,
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

function paragraphFromLines(lines: ReadonlyArray<string>): {
    text: string;
    source: Array<{ lineIndex: number; charIndex: number } | null>;
} {
    const textParts: string[] = [];
    const source: Array<{ lineIndex: number; charIndex: number } | null> = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        if (lineIndex > 0) {
            textParts.push(" ");
            source.push(null);
        }
        const line = lines[lineIndex];
        for (let charIndex = 0; charIndex < line.length; charIndex++) {
            textParts.push(line[charIndex]);
            source.push({ lineIndex, charIndex });
        }
    }
    return { text: textParts.join(""), source };
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

describe("splitOnEnumeratedListAfterColon", () => {
    it("splits at ': (1) The...' when sentencex did not break there", () => {
        const text =
            "The NLS are surveys of men and women: (1) The NLSY97 consists of a sample.";
        const ranges = rangesFromChunks(text, [
            "The NLS are surveys of men and women: (1) The NLSY97 consists of a sample.",
        ]);
        expect(slice(text, splitOnEnumeratedListAfterColon(ranges, text))).toEqual(
            [
                "The NLS are surveys of men and women:",
                "(1) The NLSY97 consists of a sample.",
            ],
        );
    });

    it("splits at every ': (N) <Uppercase>' occurrence in a range", () => {
        const text =
            "We saw two patterns: (1) Apple is red. (2) Banana is yellow. Closing: (3) Cherry is dark.";
        const ranges = rangesFromChunks(text, [
            "We saw two patterns: (1) Apple is red.",
            "(2) Banana is yellow.",
            "Closing: (3) Cherry is dark.",
        ]);
        expect(slice(text, splitOnEnumeratedListAfterColon(ranges, text))).toEqual(
            [
                "We saw two patterns:",
                "(1) Apple is red.",
                "(2) Banana is yellow.",
                "Closing:",
                "(3) Cherry is dark.",
            ],
        );
    });

    it("does NOT split inline lists with lowercase items", () => {
        // Conventional inline list — items are short phrases starting
        // lowercase. Keeping them as one sentence is correct.
        const text =
            "We have three options: (1) the first, (2) the second, and (3) the third.";
        const ranges = rangesFromChunks(text, [
            "We have three options: (1) the first, (2) the second, and (3) the third.",
        ]);
        expect(slice(text, splitOnEnumeratedListAfterColon(ranges, text))).toEqual(
            [
                "We have three options: (1) the first, (2) the second, and (3) the third.",
            ],
        );
    });

    it("does NOT split when the parenthesized item contains non-digits", () => {
        // `(i)` Roman numerals and `(a)` alphabetic labels are common but
        // less reliable as sentence-break signals — keep the rule narrow.
        const text =
            "We have two options: (i) The first one. (ii) The second one.";
        const ranges = rangesFromChunks(text, [
            "We have two options: (i) The first one. (ii) The second one.",
        ]);
        expect(slice(text, splitOnEnumeratedListAfterColon(ranges, text))).toEqual(
            ["We have two options: (i) The first one. (ii) The second one."],
        );
    });

    it("does NOT split when there is no colon before the enumerator", () => {
        const text = "He said (1) The first. (2) The second.";
        // Pretend sentencex already split correctly on the periods.
        const ranges = rangesFromChunks(text, [
            "He said (1) The first.",
            "(2) The second.",
        ]);
        expect(slice(text, splitOnEnumeratedListAfterColon(ranges, text))).toEqual(
            ["He said (1) The first.", "(2) The second."],
        );
    });

    it("is a no-op when no enumerator pattern is present", () => {
        const text = "First sentence. Second sentence.";
        const ranges = rangesFromChunks(text, [
            "First sentence.",
            "Second sentence.",
        ]);
        expect(slice(text, splitOnEnumeratedListAfterColon(ranges, text))).toEqual(
            ["First sentence.", "Second sentence."],
        );
    });

    it("handles colon followed by a newline before the enumerator", () => {
        // Multi-line paragraph text uses `" "` line fillers, but the rule
        // should also be robust to other whitespace runs.
        const text =
            "Two cohorts:\n(1) The younger group consists of 5083 women.";
        const ranges = rangesFromChunks(text, [
            "Two cohorts:\n(1) The younger group consists of 5083 women.",
        ]);
        expect(slice(text, splitOnEnumeratedListAfterColon(ranges, text))).toEqual(
            ["Two cohorts:", "(1) The younger group consists of 5083 women."],
        );
    });

    it("returns an empty array for empty input", () => {
        expect(splitOnEnumeratedListAfterColon([], "")).toEqual([]);
    });
});

describe("splitTrailingNumericSubsectionLabel", () => {
    it("splits a trailing '4.1.' off when the next range is a heading title", () => {
        // Two heading lines collapsed into one paragraph — sentencex
        // splits at the colon-less period and leaves the label glued to
        // the previous heading.
        const { text, source } = paragraphFromLines([
            "4. Discussion",
            "4.1.",
            "Academic Performance in Pennsylvania Schools",
        ]);
        const ranges = rangesFromChunks(text, [
            "4. Discussion 4.1.",
            "Academic Performance in Pennsylvania Schools",
        ]);
        expect(
            slice(
                text,
                splitTrailingNumericSubsectionLabel(ranges, text, { source }),
            ),
        ).toEqual([
            "4. Discussion",
            "4.1.",
            "Academic Performance in Pennsylvania Schools",
        ]);
    });

    it("integrates with the full pipeline to merge label and title", () => {
        const { text, source } = paragraphFromLines([
            "4. Discussion",
            "4.1.",
            "Academic Performance in Pennsylvania Schools",
        ]);
        const ranges = rangesFromChunks(text, [
            "4. Discussion 4.1.",
            "Academic Performance in Pennsylvania Schools",
        ]);
        expect(
            slice(text, applyPostProcessing(ranges, text, { source })),
        ).toEqual([
            "4. Discussion",
            "4.1. Academic Performance in Pennsylvania Schools",
        ]);
    });

    it("handles deeper labels like '1.2.3.'", () => {
        const { text, source } = paragraphFromLines([
            "Background",
            "1.2.3.",
            "Sub Sub Section Title",
        ]);
        const ranges = rangesFromChunks(text, [
            "Background 1.2.3.",
            "Sub Sub Section Title",
        ]);
        expect(
            slice(
                text,
                splitTrailingNumericSubsectionLabel(ranges, text, { source }),
            ),
        ).toEqual(["Background", "1.2.3.", "Sub Sub Section Title"]);
    });

    it("does NOT split same-line prose ending in a decimal before a title-like range", () => {
        const { text, source } = paragraphFromLines([
            "The estimated value was 1.5. Robustness Checks",
        ]);
        const ranges = rangesFromChunks(text, [
            "The estimated value was 1.5.",
            "Robustness Checks",
        ]);
        expect(
            slice(
                text,
                splitTrailingNumericSubsectionLabel(ranges, text, { source }),
            ),
        ).toEqual(["The estimated value was 1.5.", "Robustness Checks"]);
    });

    it("does NOT split when the next range ends with a period", () => {
        // Real prose: "...version 1.5." followed by a normal sentence.
        const text = "We use version 1.5. The new release adds telemetry.";
        const ranges = rangesFromChunks(text, [
            "We use version 1.5.",
            "The new release adds telemetry.",
        ]);
        expect(
            slice(text, splitTrailingNumericSubsectionLabel(ranges, text)),
        ).toEqual([
            "We use version 1.5.",
            "The new release adds telemetry.",
        ]);
    });

    it("does NOT split when the next range is a regular prose continuation", () => {
        // No terminal punct on next, but the next range isn't Title-Cased.
        const text =
            "Then we did test 1.1. After completing the test we moved on";
        const ranges = rangesFromChunks(text, [
            "Then we did test 1.1.",
            "After completing the test we moved on",
        ]);
        expect(
            slice(text, splitTrailingNumericSubsectionLabel(ranges, text)),
        ).toEqual([
            "Then we did test 1.1.",
            "After completing the test we moved on",
        ]);
    });

    it("does NOT split a single-segment trailing number ('4.')", () => {
        // Bare-trailing-numeric is too risky (collides with `version 4.`,
        // step counters, etc.) — only multi-segment labels are recognized.
        const text = "Discussion 4. Some Heading Like Words";
        const ranges = rangesFromChunks(text, [
            "Discussion 4.",
            "Some Heading Like Words",
        ]);
        expect(
            slice(text, splitTrailingNumericSubsectionLabel(ranges, text)),
        ).toEqual(["Discussion 4.", "Some Heading Like Words"]);
    });

    it("does NOT split when this is the last range (nothing to merge into)", () => {
        const text = "Conclusion 4.1.";
        const ranges = rangesFromChunks(text, ["Conclusion 4.1."]);
        expect(
            slice(text, splitTrailingNumericSubsectionLabel(ranges, text)),
        ).toEqual(["Conclusion 4.1."]);
    });

    it("returns an empty array for empty input", () => {
        expect(splitTrailingNumericSubsectionLabel([], "")).toEqual([]);
    });
});

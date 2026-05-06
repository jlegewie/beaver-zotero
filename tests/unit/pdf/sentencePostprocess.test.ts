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
    findReferenceBoundaries,
    hasReferenceStart,
    hasReferenceTail,
    isReferenceParagraph,
    mergedRangesValid,
    mergeLabelSentences,
    mergeReferenceListSentences,
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

// ---------------------------------------------------------------------------
// Reference-list collapse / re-split
// ---------------------------------------------------------------------------

describe("isReferenceParagraph (A∧B classifier)", () => {
    // Each positive must hit BOTH a reference-start (A1–A4) and a
    // reference-tail (B1–B5). Comments tag the rule firing.
    it("APA-style: Surname, Initials. (year). Title. Journal v(i). DOI", () => {
        // A2 + B1 + B2
        const text =
            "Aldoseri, A., Al-Khalifa, K. N., & Hamouda, A. M. (2023). " +
            "Re-thinking data strategy and integration for artificial " +
            "intelligence: Concepts, opportunities, and challenges. " +
            "Applied Sciences, 13(12), 7082. " +
            "https://doi.org/10.3390/app13127082";
        expect(isReferenceParagraph(text)).toBe(true);
    });

    it("Tibshirani-style: Surname, R.J. (year) Title. Journal Series, V: pages.", () => {
        // A2 + B3
        const text =
            "Tibshirani, R.J. (1996) \"Regression Shrinkage and Selection " +
            "Via the LASSO.\" Journal of the Royal Statistical Society, " +
            "Series B, 25: 267–288.";
        expect(isReferenceParagraph(text)).toBe(true);
    });

    it("ASR-style: Surname, FirstName, and FirstName Surname. year. Title. Journal V(I):pages.", () => {
        // A2 + B2
        const text =
            "Brunson, Rod K., and Jody Miller. 2006. \"Young Black Men " +
            "and Urban Policing in the United States.\" British Journal " +
            "of Criminology 46(4):613–40.";
        expect(isReferenceParagraph(text)).toBe(true);
    });

    it("FirstName-Surname-year-Title-Pp.: A4 + B4", () => {
        const text =
            "Patrick Sharkey. 2011. \"Converging Evidence for Neighborhood " +
            "Effects on Children's Test Scores: An Experimental, Quasi-" +
            "Experimental, and Observational Comparison.\" Pp. 255–76 in " +
            "Whither Opportunity: Rising Inequality, Schools, and " +
            "Children's Life Chances, edited by G. J. Duncan and R. J. " +
            "Murnane.";
        expect(isReferenceParagraph(text)).toBe(true);
    });

    it("Numbered list: [12] Surname, Initial. (year). Title. Journal v(i), pages. DOI", () => {
        // A1 + B1 + B2
        const text =
            "[12] Lee, J. (2018). Some study title here. Journal Name " +
            "9(2), 100-110. https://doi.org/10.1234/abc";
        expect(isReferenceParagraph(text)).toBe(true);
    });

    it("Science-style numbered with bare DOI prefix and PMID: A1 + B1 + B6", () => {
        // Real-world shape from 7552DIBA / 2HWTUN94 page 11. The DOI
        // is written `doi: 10.1038/...` (no `doi.org/`); the PMID is a
        // strong biomedical reference signal.
        const text =
            "1. B. F. C. Kafsack et al., A transcriptional switch underlies " +
            "commitment to sexual development in malaria parasites. Nature " +
            "507, 248–252 (2014). doi: 10.1038/nature12920; pmid: 24572369";
        expect(isReferenceParagraph(text)).toBe(true);
    });

    it("Initials-Surname (no comma): T.M. and E.J. Atkinson...", () => {
        // A3 + B5 (Technical Report keyword in tail)
        const text =
            "T.M. and E.J. Atkinson (1997) \"An Introduction to Recursive " +
            "Partitioning Using the RPART Routines.\" Technical Report " +
            "# 61, Mayo Foundation.";
        expect(isReferenceParagraph(text)).toBe(true);
    });

    it("Book reference with University Press tail: A2 + B5", () => {
        const text =
            "Bourgois, Philippe. 2003. In Search of Respect: Selling Crack " +
            "in El Barrio. Cambridge, UK: Cambridge University Press.";
        expect(isReferenceParagraph(text)).toBe(true);
    });

    // Negatives: each must NOT be classified as a reference paragraph.
    it("does NOT classify normal prose with one inline citation", () => {
        const text =
            "Recent work by Smith et al. (2023) demonstrates that frontier " +
            "effects persist across regions, although Jones (2021) reports " +
            "null results in coastal samples.";
        expect(isReferenceParagraph(text)).toBe(false);
    });

    it("does NOT classify an acknowledgments paragraph", () => {
        const text =
            "We thank J. Smith, K. Jones, and the seminar participants at " +
            "NYU for comments. This work was supported by NSF grant " +
            "2017–01234.";
        expect(isReferenceParagraph(text)).toBe(false);
    });

    it("does NOT classify a cover-page author block", () => {
        const text =
            "Sunil Kumar Dogga, Jesse C. Rop, Juliana Cudini, Elias Farr, " +
            "Antoine Dara, Dinkorma Ouologuem";
        expect(isReferenceParagraph(text)).toBe(false);
    });

    it("does NOT classify methods text mentioning year & DOI but not reference-shaped", () => {
        const text =
            "We retrieved the corpus on 2023-01-12 from " +
            "https://example.org/data, then filtered to the 1997 cohort. " +
            "Standard errors are clustered at the school level.";
        expect(isReferenceParagraph(text)).toBe(false);
    });

    it("does NOT classify narrative beginning with formal-looking citation but no tail", () => {
        const text =
            "Smith, J. (2023). This study examines how teachers respond " +
            "to gradebook visibility in real classrooms across the country.";
        expect(isReferenceParagraph(text)).toBe(false);
    });

    it("does NOT classify prose that contains a colon-separated number pair", () => {
        // B3 must require an explicit page range; a bare `Vol:Page` form
        // could otherwise come from prose like ratios, time-of-day,
        // scores, or threshold values. Without the range guard, a
        // narrative paragraph beginning with an A2-shaped citation could
        // hit B3 spuriously and be collapsed.
        const text =
            "Smith, J. argues that the relevant threshold is 12:34 in " +
            "this analysis, and Jones (2021) confirms the result holds " +
            "across cohorts at every observation level we examined.";
        expect(isReferenceParagraph(text)).toBe(false);
    });

    it("does NOT classify a stub paragraph", () => {
        expect(isReferenceParagraph("See [12].")).toBe(false);
    });

    it("hasReferenceStart returns true for A2 with R.J. (no space)", () => {
        expect(hasReferenceStart("Tibshirani, R.J. (1996) ...")).toBe(true);
    });

    it("hasReferenceStart matches hyphenated surnames (Durán-Narucki)", () => {
        // Hyphenated compound surnames must match A2 — the second
        // component can start with an uppercase letter.
        expect(
            hasReferenceStart(
                "Durán-Narucki, Valkiria. 2008. \"School Building Condition...\"",
            ),
        ).toBe(true);
    });

    it("hasReferenceStart still rejects all-caps regions like 'Princeton, NJ:'", () => {
        // Regression guard for the NAME_TAIL change. `Princeton, NJ`
        // must not match A2 — `NJ` is all-caps after the comma.
        expect(hasReferenceStart("Princeton, NJ: Princeton University")).toBe(
            false,
        );
    });

    it("hasReferenceStart matches all-caps surnames (BOTTOMS, A.E)", () => {
        // European-style references (e.g. 2YWA8DTZ p17) typeset author
        // surnames in ALL CAPS. The 3+ caps SURNAME alternative must
        // match.
        expect(
            hasReferenceStart(
                "BOTTOMS, A.E & P. WILES (2002), Environmental Criminology.",
            ),
        ).toBe(true);
        expect(
            hasReferenceStart(
                "BUTLER, T. & G. ROBSON (2001), Social Capital.",
            ),
        ).toBe(true);
        expect(
            hasReferenceStart(
                "BRANTINGHAM, P. J., G. E. TITA, M. B. SHORT (2012)",
            ),
        ).toBe(true);
    });

    it("hasReferenceStart matches D'Augustino-style apostrophe surnames", () => {
        // UCZSE63I p30: 'D'Augustino, Ralph B. 1998. ...' — the surname
        // is Cap+apostrophe+Cap+lower, which the mixed-case alternative
        // accepts because the trailing 'ugustino' is lowercase.
        expect(
            hasReferenceStart("D’Augustino, Ralph B. 1998."),
        ).toBe(true);
        expect(
            hasReferenceStart("O’Neil, James. 2010."),
        ).toBe(true);
    });

    it("isReferenceParagraph fires on European all-caps style refs", () => {
        const text =
            "BOTTOMS, A.E & P. WILES (2002), Environmental Criminology. " +
            "In: M. Maguire, R. Morgan & R. Reiner, eds., The Oxford " +
            "Handbook of Criminology, Oxford: Oxford University Press, " +
            "pp. 620–656.";
        // A2 (BOTTOMS surname-comma-initial) + B5 (University Press in tail)
        expect(isReferenceParagraph(text)).toBe(true);
    });

    it("hasReferenceTail B2 fires with optional space between volume and parens", () => {
        // PZXKV348 p37: 'Statistical 84 (408): 862–74.' — the relaxed
        // B2 must match the spaced form.
        expect(hasReferenceTail("Statistical 84 (408): 862–74.")).toBe(true);
        // No-space form (Pediatrics-style) must continue to match.
        expect(
            hasReferenceTail("British Journal of Criminology 46(4):613–40."),
        ).toBe(true);
    });

    it("isReferenceParagraph fires on space-(Issue) APA-style refs", () => {
        const text =
            "Heckman, James J., Hidehiko Ichimura, Jeffrey Smith, and " +
            "Petra Todd. 1998. \"Characterizing Selection Bias Using " +
            "Experimental Data.\" Econometrica 66 (5): 1017–1098.";
        expect(isReferenceParagraph(text)).toBe(true);
    });

    it("does NOT classify acronym-led organization prose with URL tail", () => {
        // The all-caps SURNAME alternative looked like a citation entry
        // when paired with a full given name, e.g. `NASA, Johnson Space
        // Center`. Combined with a URL tail (B1), this would falsely
        // collapse normal prose into one reference. The fix: A2 requires
        // **initial-only** post-comma for all-caps surnames.
        const nasa =
            "NASA, Johnson Space Center provides extensive flight " +
            "training for new astronauts and continues to operate the " +
            "International Space Station; see https://www.nasa.gov/jsc/ " +
            "for current programs.";
        expect(hasReferenceStart(nasa)).toBe(false);
        expect(isReferenceParagraph(nasa)).toBe(false);

        // Variants with DOI in tail must also stay rejected.
        const cdc =
            "CDC, Atlanta Field Office released the new guidelines on " +
            "respiratory infection control in 2024; the formal report " +
            "is at https://doi.org/10.15585/mmwr.example with full " +
            "supplemental tables.";
        expect(hasReferenceStart(cdc)).toBe(false);
        expect(isReferenceParagraph(cdc)).toBe(false);

        // Acronym + acronym (e.g. `CDC, MMWR`) must also not match A2 —
        // the all-caps post-comma token isn't an initial.
        const cdcMmwr =
            "CDC, MMWR Quick Stats reports new findings on the rates " +
            "of seasonal influenza and pneumococcal disease; see the " +
            "interactive dashboard at https://www.cdc.gov/mmwr/.";
        expect(hasReferenceStart(cdcMmwr)).toBe(false);
        expect(isReferenceParagraph(cdcMmwr)).toBe(false);
    });

    it("still fires on real all-caps reference entries (initial post-comma)", () => {
        // Regression guard: the all-caps SURNAME path must still work
        // when the post-comma token is an initial pattern.
        expect(
            hasReferenceStart("BOTTOMS, A.E & P. WILES (2002), ..."),
        ).toBe(true);
        expect(
            hasReferenceStart("BUTLER, T. & G. ROBSON (2001), ..."),
        ).toBe(true);
        expect(
            hasReferenceStart("BRANTINGHAM, P. J., G. E. TITA, ..."),
        ).toBe(true);
    });

    it("hasReferenceStart returns false on a lowercase continuation paragraph", () => {
        expect(
            hasReferenceStart(
                "artificial intelligence: Concepts, opportunities, and challenges.",
            ),
        ).toBe(false);
    });

    it("hasReferenceTail B5 only fires in the trailing window", () => {
        // "Press" appears in normal prose far from the end — should NOT
        // count as a reference tail.
        const longProse = "We pressed Press release Z.".padEnd(400, "x");
        expect(hasReferenceTail(longProse)).toBe(false);
        // But a real publisher tail at the end should fire.
        const reference =
            "Bourgois, Philippe. 2003. In Search of Respect. Cambridge: " +
            "Cambridge University Press.";
        expect(hasReferenceTail(reference)).toBe(true);
    });
});

describe("findReferenceBoundaries", () => {
    it("finds the 3 boundaries inside a 4-references-merged paragraph (NLNMPWNQ p25 para_p25_1)", () => {
        const text =
            "Angrist, Joshua D., and Jörn-Steffen Pischke. 2008. Mostly " +
            "Harmless Econometrics: An Empiricist's Companion. Princeton, " +
            "NJ: Princeton University Press. " +
            "Athey, Susan, and Guido W. Imbens. 2017. \"The State of " +
            "Applied Econometrics: Causality and Policy Evaluation.\" " +
            "Journal of Economic Perspectives 31(2):3–32. " +
            "Barrett, John Q. 1998. \"Deciding the Stop and Frisk " +
            "Cases: A Look Inside the Supreme Court's Conference.\" " +
            "St. John's Law Review 72(3):749–844. " +
            "Beck, Brenden. 2019. \"Broken Windows in the Cul-de-Sac? " +
            "Race/Ethnicity and Quality-of-Life Policing in the Changing " +
            "Suburbs.\" Crime & Delinquency 65(2):270–92.";
        const boundaries = findReferenceBoundaries(text);
        // Each boundary is the offset of the first character of the
        // *next* reference's opening token.
        expect(boundaries).toEqual([
            text.indexOf("Athey, Susan"),
            text.indexOf("Barrett, John"),
            text.indexOf("Beck, Brenden"),
        ]);
    });

    it("returns [] for a single-reference paragraph", () => {
        const text =
            "Aldoseri, A., Al-Khalifa, K. N., & Hamouda, A. M. (2023). " +
            "Re-thinking. Applied Sciences, 13(12), 7082. " +
            "https://doi.org/10.3390/app13127082";
        expect(findReferenceBoundaries(text)).toEqual([]);
    });

    it("finds a URL-ending boundary (no period before next reference)", () => {
        const text =
            "...corpora. https://doi.org/10.3390/app13127082 Smith, J. (2024). Title.";
        const boundaries = findReferenceBoundaries(text);
        expect(boundaries).toEqual([text.indexOf("Smith")]);
    });

    it("finds a URL-ending boundary with bare doi.org", () => {
        const text =
            "First reference body. doi.org/10.1234/abc Jones, K., & Lee, M. (2024). Title.";
        const boundaries = findReferenceBoundaries(text);
        expect(boundaries).toEqual([text.indexOf("Jones")]);
    });

    it("returns [] on negative-control prose", () => {
        const text = "...wonderfully written. New England, however, was different.";
        expect(findReferenceBoundaries(text)).toEqual([]);
    });

    it("non-numbered: in-reference middle-initial author lists do NOT split", () => {
        // Real shape from NLNMPWNQ p25 para_p25_3 (Bor reference): the
        // author list contains `Atheendar S. Venkataramani` where `S.`
        // is a middle initial. Without the lookbehind, the boundary
        // detector would split at `S. Venkataramani, David` (A2-like)
        // even though it's mid-author-list, not a reference boundary.
        const text =
            "Bor, Jacob, Atheendar S. Venkataramani, David R. Williams, " +
            "and Alexander C. Tsai. 2018. \"Police Killings and Their " +
            "Spillover Effects on the Mental Health of Black Americans: " +
            "A Population-Based, Quasi-Experimental Study.\" The Lancet " +
            "392(10144):302–10. " +
            "Bourgois, Philippe. 2003. In Search of Respect. Cambridge: " +
            "Cambridge University Press.";
        const boundaries = findReferenceBoundaries(text);
        // Only one boundary expected: between Bor's reference (ends at
        // 392(10144):302–10.) and Bourgois's reference.
        expect(boundaries).toEqual([text.indexOf("Bourgois, Philippe")]);
    });

    it("non-numbered: short middle-initial like 'Brame ... Michael G. Turner' does NOT split", () => {
        const text =
            "Brame, Robert, Michael G. Turner, Raymond Paternoster, and " +
            "Shawn D. Bushway. 2012. \"Cumulative Prevalence of Arrest " +
            "from Ages 8 to 23 in a National Sample.\" Pediatrics 129(1):21–27.";
        // Single reference; should produce no boundaries internally.
        expect(findReferenceBoundaries(text)).toEqual([]);
    });

    it("returns [] for empty input", () => {
        expect(findReferenceBoundaries("")).toEqual([]);
    });

    it("Science-style numbered references with PMID-then-number transitions", () => {
        // Real shape from 7552DIBA / 2HWTUN94 page 11: numbered refs where
        // each entry ends in `pmid: NNNNNNNN` (no period) and the next
        // entry starts with `<digit>. <Initial>. <Surname>...`.
        const text =
            "1. B. F. C. Kafsack et al., A transcriptional switch underlies " +
            "commitment to sexual development in malaria parasites. Nature " +
            "507, 248–252 (2014). doi: 10.1038/nature12920; pmid: 24572369 " +
            "2. A. Sinha et al., A cascade of DNA-binding proteins for " +
            "sexual commitment and development in Plasmodium. Nature 507, " +
            "253–257 (2014). doi: 10.1038/nature12970; pmid: 24572359 " +
            "3. N. M. B. Brancucci et al., Lysophosphatidylcholine.";
        const boundaries = findReferenceBoundaries(text);
        expect(boundaries).toEqual([
            text.indexOf("2. A. Sinha"),
            text.indexOf("3. N. M. B."),
        ]);
    });

    it("numbered-style paragraph: in-reference author lists do NOT split", () => {
        // Real shape from 7552DIBA p10 para_p10_X (ref 24): a numbered
        // reference whose author list has multiple `<Surname>, <Initial>.`
        // tokens internally. The boundary detector must NOT split inside
        // the author list — only at the next numbered marker.
        const text =
            "23. T. Nessel et al., EXP1 is required for organisation. " +
            "Cell. Microbiol. 22, e13168 (2020). doi: 10.1111/cmi.13168; " +
            "pmid: 31990132 " +
            "24. R. L. Coppel, S. Lustigman, L. Murray, R. F. Anders, " +
            "MESA is a Plasmodium falciparum phosphoprotein associated " +
            "with the erythrocyte membrane skeleton. Mol. Biochem. " +
            "Parasitol. 31, 223–231 (1988). doi: 10.1016/0166-6851(88)" +
            "90152-1; pmid: 3065643";
        const boundaries = findReferenceBoundaries(text);
        // Only one boundary expected: between ref 23 and ref 24.
        expect(boundaries).toEqual([text.indexOf("24. R. L. Coppel")]);
    });

    it("does NOT use the looser numbered-boundary on a non-numbered paragraph", () => {
        // A paragraph whose first reference starts with "Author, X." (not a
        // numbered list) should not trigger the loose `\s+ N. Capital`
        // pattern, so an in-text "see 12. Some" doesn't fire.
        const text =
            "Smith, John D. (2023). A study of effects, see 12. Some " +
            "results were observed in the second cohort. Applied " +
            "Sciences, 13(12), 7082. https://doi.org/10.3390/abc";
        // No reference boundary should be detected — the paragraph has
        // exactly one reference and is not numbered-style.
        expect(findReferenceBoundaries(text)).toEqual([]);
    });
});

describe("mergeReferenceListSentences", () => {
    it("non-reference ranges pass through unchanged", () => {
        const text =
            "Recent work by Smith et al. (2023) demonstrates the effect. " +
            "Jones (2021) reports null results.";
        const input = rangesFromChunks(text, [
            "Recent work by Smith et al. (2023) demonstrates the effect.",
            "Jones (2021) reports null results.",
        ]);
        const out = mergeReferenceListSentences(input, text);
        expect(out).toBe(input);
        expect(slice(text, out)).toEqual(slice(text, input));
    });

    it("para_p5_3 alone — A2 fires but no B-tail → unchanged", () => {
        // The first line of an APA reference, before the title/journal/DOI
        // continuation lands in a separate paragraph.
        const text =
            "Aldoseri, A., Al-Khalifa, K. N., & Hamouda, A. M. (2023). " +
            "Re-thinking data strategy and integration for";
        const input = rangesFromChunks(text, [
            "Aldoseri, A., Al-Khalifa, K. N., & Hamouda, A. M. (2023).",
            "Re-thinking data strategy and integration for",
        ]);
        const out = mergeReferenceListSentences(input, text);
        expect(out).toBe(input);
    });

    it("para_p5_4 alone — no A-pattern → unchanged", () => {
        // The continuation lines of an APA reference; starts lowercase.
        const text =
            "artificial intelligence: Concepts, opportunities, and " +
            "challenges. Applied Sciences, 13(12), 7082. " +
            "https://doi.org/10.3390/app13127082";
        const input = rangesFromChunks(text, [
            "artificial intelligence: Concepts, opportunities, and challenges.",
            "Applied Sciences, 13(12), 7082.",
            "https://doi.org/10.3390/app13127082",
        ]);
        const out = mergeReferenceListSentences(input, text);
        expect(out).toBe(input);
    });

    it("synthetic single-paragraph reference collapses to 1 range", () => {
        const text =
            "Aldoseri, A., Al-Khalifa, K. N., & Hamouda, A. M. (2023). " +
            "Re-thinking data strategy and integration for artificial " +
            "intelligence: Concepts, opportunities, and challenges. " +
            "Applied Sciences, 13(12), 7082. " +
            "https://doi.org/10.3390/app13127082";
        // Simulate sentencex's over-split.
        const input = rangesFromChunks(text, [
            "Aldoseri, A., Al-Khalifa, K. N., & Hamouda, A. M. (2023).",
            "Re-thinking data strategy and integration for artificial intelligence: Concepts, opportunities, and challenges.",
            "Applied Sciences, 13(12), 7082.",
            "https://doi.org/10.3390/app13127082",
        ]);
        const out = mergeReferenceListSentences(input, text);
        expect(out).toHaveLength(1);
        expect(slice(text, out)).toEqual([text.trim()]);
    });

    it("multi-reference paragraph splits into N ranges at boundaries", () => {
        const text =
            "Angrist, Joshua D., and Jörn-Steffen Pischke. 2008. Mostly " +
            "Harmless Econometrics: An Empiricist's Companion. Princeton, " +
            "NJ: Princeton University Press. " +
            "Athey, Susan, and Guido W. Imbens. 2017. \"The State of " +
            "Applied Econometrics: Causality and Policy Evaluation.\" " +
            "Journal of Economic Perspectives 31(2):3–32. " +
            "Barrett, John Q. 1998. \"Deciding the Stop and Frisk " +
            "Cases.\" St. John's Law Review 72(3):749–844. " +
            "Beck, Brenden. 2019. \"Broken Windows in the Cul-de-Sac?\" " +
            "Crime & Delinquency 65(2):270–92.";
        // Pretend sentencex over-split into many fragments.
        const input = rangesFromChunks(text, [
            "Angrist, Joshua D., and Jörn-Steffen Pischke.",
            "2008. Mostly Harmless Econometrics: An Empiricist's Companion.",
            "Princeton, NJ: Princeton University Press.",
            "Athey, Susan, and Guido W. Imbens.",
            "2017. \"The State of Applied Econometrics: Causality and Policy Evaluation.\"",
            "Journal of Economic Perspectives 31(2):3–32.",
            "Barrett, John Q. 1998.",
            "\"Deciding the Stop and Frisk Cases.\"",
            "St. John's Law Review 72(3):749–844.",
            "Beck, Brenden.",
            "2019. \"Broken Windows in the Cul-de-Sac?\"",
            "Crime & Delinquency 65(2):270–92.",
        ]);
        const out = mergeReferenceListSentences(input, text);
        expect(out).toHaveLength(4);
        const sliced = slice(text, out);
        expect(sliced[0].startsWith("Angrist, Joshua D.")).toBe(true);
        expect(sliced[0].endsWith("Princeton University Press.")).toBe(true);
        expect(sliced[1].startsWith("Athey, Susan")).toBe(true);
        expect(sliced[1].endsWith("31(2):3–32.")).toBe(true);
        expect(sliced[2].startsWith("Barrett, John Q.")).toBe(true);
        expect(sliced[2].endsWith("72(3):749–844.")).toBe(true);
        expect(sliced[3].startsWith("Beck, Brenden")).toBe(true);
        expect(sliced[3].endsWith("65(2):270–92.")).toBe(true);
    });

    it("URL-ending reference boundary splits into 2 ranges", () => {
        const text =
            "Smith, J. (2023). Title One. doi.org/10.1234/abc " +
            "Jones, K., & Lee, M. (2024). Title Two. " +
            "https://example.org/xyz";
        // sentencex would split on every period.
        const input = rangesFromChunks(text, [
            "Smith, J. (2023).",
            "Title One.",
            "doi.org/10.1234/abc Jones, K., & Lee, M. (2024).",
            "Title Two.",
            "https://example.org/xyz",
        ]);
        const out = mergeReferenceListSentences(input, text);
        expect(out).toHaveLength(2);
        const sliced = slice(text, out);
        expect(sliced[0].startsWith("Smith, J.")).toBe(true);
        expect(sliced[0]).toContain("doi.org/10.1234/abc");
        expect(sliced[1].startsWith("Jones, K.")).toBe(true);
    });

    it("returns input unchanged when paragraph is too short", () => {
        const text = "See [12].";
        const input = rangesFromChunks(text, ["See [12]."]);
        const out = mergeReferenceListSentences(input, text);
        expect(out).toBe(input);
    });

    it("integrates through applyPostProcessing for a single-reference paragraph", () => {
        const text =
            "Aldoseri, A., Al-Khalifa, K. N., & Hamouda, A. M. (2023). " +
            "Re-thinking. Applied Sciences, 13(12), 7082. " +
            "https://doi.org/10.3390/app13127082";
        const input = rangesFromChunks(text, [
            "Aldoseri, A., Al-Khalifa, K. N., & Hamouda, A. M. (2023).",
            "Re-thinking.",
            "Applied Sciences, 13(12), 7082.",
            "https://doi.org/10.3390/app13127082",
        ]);
        const out = applyPostProcessing(input, text);
        expect(out).toHaveLength(1);
        expect(slice(text, out)).toEqual([text.trim()]);
    });
});

describe("mergedRangesValid (sanity invariant for the fallback path)", () => {
    // The reference text used for these ranges is a real
    // multi-reference paragraph; the test cases craft different
    // candidate `newRanges` arrays to drive each failure mode.
    const text =
        "Smith, J. (2023). Title One. Applied Sciences, 13(12), 7082-7090. " +
        "https://doi.org/10.1234/abc " +
        "Jones, K. (2024). Title Two. Applied Sciences, 14(1), 8000-8010. " +
        "https://doi.org/10.5678/xyz";

    it("accepts well-formed reference ranges", () => {
        const start1 = 0;
        const end1 = text.indexOf("Jones, K.") - 1; // before the boundary space
        const start2 = text.indexOf("Jones, K.");
        const end2 = text.length;
        expect(
            mergedRangesValid(
                [
                    { start: start1, end: end1 },
                    { start: start2, end: end2 },
                ],
                text,
            ),
        ).toBe(true);
    });

    it("rejects an empty range (end <= start)", () => {
        // Second range collapsed to zero length.
        expect(
            mergedRangesValid(
                [
                    { start: 0, end: 10 },
                    { start: 50, end: 50 },
                ],
                text,
            ),
        ).toBe(false);
    });

    it("rejects out-of-order ranges (overlap with previous)", () => {
        // Third range starts inside the second.
        const end1 = text.indexOf("Jones, K.") - 1;
        const start2 = text.indexOf("Jones, K.");
        expect(
            mergedRangesValid(
                [
                    { start: 0, end: end1 },
                    { start: start2, end: text.length },
                    { start: start2 + 5, end: text.length }, // overlaps with previous
                ],
                text,
            ),
        ).toBe(false);
    });

    it("rejects a range whose text does not start with a reference-start", () => {
        // Cover the text starting at "Title One" (mid-reference; no
        // A-pattern matches "Title One.").
        const titleStart = text.indexOf("Title One");
        expect(
            mergedRangesValid(
                [{ start: titleStart, end: titleStart + 30 }],
                text,
            ),
        ).toBe(false);
    });

    it("rejects an empty list of ranges as trivially valid? — no, accepts (no checks fire)", () => {
        // Documenting current behaviour: an empty list passes the
        // invariant. The callers don't rely on this branch (they
        // bail earlier with `if (newRanges.length === 0) return
        // ranges as SentenceRange[]`).
        expect(mergedRangesValid([], text)).toBe(true);
    });
});

describe("mergeReferenceListSentences fallback path", () => {
    // End-to-end: when the boundary detector finds a boundary but the
    // resulting first segment somehow doesn't start with a reference-
    // start, the step must return the original splitter ranges
    // unchanged. We construct a paragraph that triggers detection
    // (A2 + B1) but whose only viable boundary partition would put a
    // non-reference-start fragment first, exercising the fallback.
    //
    // In practice this is hard to trigger from real input — the
    // boundary regex is left-anchored on a reference-start prefix, and
    // the first range starts at the (already-reference-shaped)
    // paragraph trim-start. So the fallback is defense-in-depth, and
    // we mostly verify it via `mergedRangesValid` above. The
    // end-to-end test below at least confirms a clean pass-through on
    // a normal-prose input that doesn't trigger detection.
    it("leaves normal prose unchanged (detection fails)", () => {
        const text =
            "Recent work by Smith et al. (2023) demonstrates that frontier " +
            "effects persist across regions, although Jones (2021) reports " +
            "null results in coastal samples.";
        const input = rangesFromChunks(text, [
            "Recent work by Smith et al. (2023) demonstrates that frontier effects persist across regions, although Jones (2021) reports null results in coastal samples.",
        ]);
        const out = mergeReferenceListSentences(input, text);
        // Should be the exact same array (no detection → early return).
        expect(out).toBe(input);
    });
});

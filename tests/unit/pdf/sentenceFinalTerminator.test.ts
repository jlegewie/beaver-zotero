/**
 * Unit tests for `hasSentenceFinalTerminator` in `SentenceMapper.ts`.
 *
 * The helper backs gate 6 of the column-continuation hint producer
 * (`annotateColumnContinuations`). Behavior must match the gate's intent:
 * accept ASCII / Unicode sentence terminators, walk back through trailing
 * closing punctuation, and ignore terminators buried mid-string.
 */
import { describe, it, expect } from "vitest";
import { hasSentenceFinalTerminator } from "../../../src/services/pdf/SentenceMapper";

describe("hasSentenceFinalTerminator", () => {
    it("returns true for ASCII period, exclamation, question", () => {
        expect(hasSentenceFinalTerminator("Done.")).toBe(true);
        expect(hasSentenceFinalTerminator("Wow!")).toBe(true);
        expect(hasSentenceFinalTerminator("Really?")).toBe(true);
    });

    it("returns true for unicode ellipsis and three-dot ellipsis", () => {
        expect(hasSentenceFinalTerminator("waiting…")).toBe(true);
        expect(hasSentenceFinalTerminator("waiting...")).toBe(true);
    });

    it("returns true for Myanmar full stop (။)", () => {
        expect(hasSentenceFinalTerminator("စာ။")).toBe(true);
    });

    it("returns true for every member of UNAMBIGUOUS_SENTENCE_TERMINATORS", () => {
        expect(hasSentenceFinalTerminator("文。")).toBe(true);   // CJK full stop
        expect(hasSentenceFinalTerminator("やった！")).toBe(true); // fullwidth !
        expect(hasSentenceFinalTerminator("そう？")).toBe(true);  // fullwidth ?
        expect(hasSentenceFinalTerminator("ماذا؟")).toBe(true);  // Arabic ?
        expect(hasSentenceFinalTerminator("वाक्य।")).toBe(true);   // Devanagari danda
        expect(hasSentenceFinalTerminator("वाक्य॥")).toBe(true);   // Devanagari double danda
        expect(hasSentenceFinalTerminator("ዓረፍተ ነገር።")).toBe(true); // Ethiopic
    });

    it("walks back through closing punctuation after a terminator", () => {
        expect(hasSentenceFinalTerminator(`said "ok."`)).toBe(true); // close ASCII straight quote
        expect(hasSentenceFinalTerminator(`(saw the report.)`)).toBe(true);
        expect(hasSentenceFinalTerminator(`[done.]`)).toBe(true);
        expect(hasSentenceFinalTerminator(`{wow!}`)).toBe(true);
        expect(hasSentenceFinalTerminator("said 'ok.'")).toBe(true);
        expect(hasSentenceFinalTerminator("noted.”")).toBe(true);
        expect(hasSentenceFinalTerminator("noted.’")).toBe(true);
        expect(hasSentenceFinalTerminator("dit.»")).toBe(true);
        expect(hasSentenceFinalTerminator("dit.›")).toBe(true);
        expect(hasSentenceFinalTerminator("見た。」")).toBe(true);
        expect(hasSentenceFinalTerminator("見た。』")).toBe(true);
    });

    it("walks back through stacked / mixed closers", () => {
        expect(hasSentenceFinalTerminator(`said "(ok.)"`)).toBe(true);
        expect(hasSentenceFinalTerminator("見た。』」")).toBe(true);
        expect(hasSentenceFinalTerminator(`said "the report.")`)).toBe(true);
    });

    it("ignores trailing whitespace before / between closers", () => {
        expect(hasSentenceFinalTerminator("Done.   ")).toBe(true);
        expect(hasSentenceFinalTerminator(`Done." `)).toBe(true);
        expect(hasSentenceFinalTerminator(`Done. " `)).toBe(true);
    });

    it("returns false for plain text without a terminator", () => {
        expect(hasSentenceFinalTerminator("examine changes in violent and property")).toBe(false);
        expect(hasSentenceFinalTerminator("trailing comma,")).toBe(false);
        expect(hasSentenceFinalTerminator("trailing colon:")).toBe(false);
        expect(hasSentenceFinalTerminator("trailing dash—")).toBe(false);
    });

    it("returns false for empty / whitespace-only input", () => {
        expect(hasSentenceFinalTerminator("")).toBe(false);
        expect(hasSentenceFinalTerminator("   ")).toBe(false);
    });

    it("returns false for closers without a preceding terminator", () => {
        expect(hasSentenceFinalTerminator("just a closer)")).toBe(false);
        expect(hasSentenceFinalTerminator(`a quote "`)).toBe(false);
        expect(hasSentenceFinalTerminator("guillemet»")).toBe(false);
    });

    it("returns false when a terminator is buried mid-string with non-closer text after it", () => {
        // The trailing position is a letter; terminators earlier in the
        // string don't count.
        expect(hasSentenceFinalTerminator("ok. continued"))
            .toBe(false);
        expect(hasSentenceFinalTerminator("ver. 1.5 release"))
            .toBe(false);
    });
});

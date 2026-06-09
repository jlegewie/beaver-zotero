import { normalizeText } from "./domWalk";
import type { DomExtractionDiagnostics, DomSection } from "./schema";

/** Visible-text character count of a parsed section body (whitespace-normalized). */
export function measureSectionSourceText(doc: XMLDocument | Document): number {
    const body = doc.body ?? doc.querySelector("body");
    return normalizeText(body?.textContent ?? "").length;
}

/** Total characters across all extracted item text in the given sections. */
export function sumExtractedTextChars(sections: DomSection[]): number {
    let total = 0;
    for (const section of sections) {
        for (const item of section.items) {
            total += (item.text ?? "").length;
        }
    }
    return total;
}

/**
 * Build the document text-coverage diagnostic from the extracted sections and the
 * accumulated source-body text length. `textCoverage` is rounded to three places
 * and is `null` when the source had no visible text (e.g. an image-only book).
 */
export function buildDomDiagnostics(
    sections: DomSection[],
    sourceTextChars: number,
): DomExtractionDiagnostics {
    const extractedTextChars = sumExtractedTextChars(sections);
    const textCoverage = sourceTextChars > 0
        ? Math.round((extractedTextChars / sourceTextChars) * 1000) / 1000
        : null;
    return { extractedTextChars, sourceTextChars, textCoverage };
}

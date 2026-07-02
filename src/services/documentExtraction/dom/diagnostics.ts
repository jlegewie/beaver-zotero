import { NON_CONTENT_SELECTOR, normalizeText } from "./domWalk";
import type { DomExtractionDiagnostics, DomSection } from "./schema";

// NodeFilter.SHOW_TEXT; headless DOMParser documents may lack the global.
const SHOW_TEXT = 0x4;

/**
 * Visible-text character count of a parsed section body (whitespace-normalized,
 * excluding non-content subtrees like style/script that the walk never emits).
 *
 * Uses a tree walk instead of cloning the body, avoiding an extra full-DOM copy.
 */
export function measureSectionSourceText(doc: XMLDocument | Document): number {
    const body = doc.body ?? doc.querySelector("body");
    if (!body) return 0;
    const walker = body.ownerDocument.createTreeWalker(body, SHOW_TEXT);
    let buffer = "";
    let node = walker.nextNode();
    while (node) {
        if (!(node as Text).parentElement?.closest(NON_CONTENT_SELECTOR)) {
            buffer += (node as Text).nodeValue ?? "";
        }
        node = walker.nextNode();
    }
    return normalizeText(buffer).length;
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

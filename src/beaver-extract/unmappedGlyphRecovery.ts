/**
 * Glyph-name recovery for unmapped text layers.
 *
 * Some legacy producers (notably Acrobat Distiller 3.x CFF subsets) name
 * glyphs "C<n>" where <n> is the Unicode codepoint in decimal, with no
 * ToUnicode CMap. MuPDF cannot map these by default, so the page extracts as
 * runs of U+FFFD. The fork-local stext option
 * `use-glyph-name-for-unknown-unicode` decodes such names — but only as a
 * heuristic guess: other producers use "C<n>" as an arbitrary glyph-index
 * name, where the decode yields wrong-but-plausible text that is impossible
 * to detect downstream.
 *
 * Rather than enable the guess unconditionally (which would silently corrupt
 * those files and destroy the U+FFFD signal the OCR gate relies on), the
 * worker extracts with the option OFF, then re-extracts ONLY the pages whose
 * text layer is present but overwhelmingly unmapped — the Distiller
 * signature. A normal page with a handful of unmappable symbol glyphs (e.g.
 * a stray "±") sits far below the retry threshold, so its honest U+FFFD
 * survives and is never silently rewritten.
 *
 * After a retry the recovered text is accepted only if it actually resolved
 * the unknown glyphs AND reads like natural language; a glyph-index
 * misdecode produces digit/punctuation soup that fails the check, so the
 * page falls back to its detectable-U+FFFD form and routes to OCR instead of
 * being accepted as wrong text.
 *
 * Pure and React/Zotero-free so it can be unit tested and used from the
 * worker without pulling in bundle-specific code.
 */
import type { RawBlock } from "./types";

const REPLACEMENT_CHAR_RE = /�/g;
const LETTER_RE = /\p{L}/gu;
const WHITESPACE_RE = /\s+/g;

/** Tunables for the glyph-name recovery retry. */
export const GLYPH_NAME_RECOVERY = {
    /**
     * Minimum number of non-whitespace characters on a page before a retry
     * is considered. Keeps blank and image-only (scanned) pages — which
     * carry no recoverable text layer — out of the retry path.
     */
    minGlyphs: 50,
    /**
     * A page is treated as an unmapped text layer worth retrying only when
     * at least this fraction of its non-whitespace characters are U+FFFD.
     * The Distiller signature is ~all-U+FFFD; a normal page with a few
     * unmappable symbols sits far below this and is never retried.
     */
    replacementRatioToRetry: 0.5,
    /**
     * After a retry, the recovered page is accepted only if the replacement
     * ratio dropped to at most this — i.e. the guess actually resolved the
     * unknown glyphs.
     */
    maxRecoveredReplacementRatio: 0.1,
    /**
     * ...and only if the recovered text reads like natural language: at
     * least this fraction of non-whitespace characters are letters. A
     * glyph-index misdecode produces digit/punctuation soup that fails this
     * check, so the page keeps its detectable-U+FFFD form.
     */
    minRecoveredLetterRatio: 0.5,
} as const;

interface PageLike {
    blocks: readonly RawBlock[];
}

/** Concatenate the text of every text-block line on a page. */
export function collectPageText(page: PageLike): string {
    let out = "";
    for (const block of page.blocks) {
        if (block.type !== "text" || !block.lines) continue;
        for (const line of block.lines) {
            out += line.text;
        }
    }
    return out;
}

function countNonWhitespace(text: string): number {
    return text.replace(WHITESPACE_RE, "").length;
}

function countMatches(text: string, re: RegExp): number {
    const m = text.match(re);
    return m ? m.length : 0;
}

/**
 * True when a page's text layer is present but overwhelmingly unmapped, so
 * it is worth re-extracting with glyph-name recovery enabled. Cheap: a few
 * native string passes, safe to call for every page.
 */
export function isUnmappedTextLayer(page: PageLike): boolean {
    const text = collectPageText(page);
    const nonWs = countNonWhitespace(text);
    if (nonWs < GLYPH_NAME_RECOVERY.minGlyphs) return false;
    return countMatches(text, REPLACEMENT_CHAR_RE) / nonWs >= GLYPH_NAME_RECOVERY.replacementRatioToRetry;
}

/**
 * True when a glyph-name-recovered page should replace the original: the
 * unknown glyphs were resolved AND the result reads like natural language.
 * When false, the caller keeps the original (detectable-U+FFFD) page.
 */
export function recoveredTextIsAcceptable(recoveredPage: PageLike): boolean {
    const text = collectPageText(recoveredPage);
    const nonWs = countNonWhitespace(text);
    if (nonWs === 0) return false;
    if (countMatches(text, REPLACEMENT_CHAR_RE) / nonWs > GLYPH_NAME_RECOVERY.maxRecoveredReplacementRatio) {
        return false;
    }
    return countMatches(text, LETTER_RE) / nonWs >= GLYPH_NAME_RECOVERY.minRecoveredLetterRatio;
}

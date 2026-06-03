/**
 * Recovery for unmapped text layers.
 *
 * When MuPDF cannot resolve a glyph to a Unicode codepoint it emits U+FFFD.
 * Two heuristic stext options can recover such glyphs:
 *   - `use-cid-for-unknown-unicode` — falls back to the character code
 *     (recovers e.g. GNU Ghostscript Type 1C subsets whose code IS the
 *     Latin-1 codepoint).
 *   - `use-glyph-name-for-unknown-unicode` (fork-local) — decodes numeric
 *     "C<n>" glyph names (decimal Unicode codepoint), e.g. Acrobat Distiller
 *     3.x CFF subsets with no ToUnicode CMap.
 *
 * Both are guesses: a CID or a "C<n>" name is not always the real codepoint,
 * so either can yield wrong-but-plausible text that is impossible to detect
 * downstream. Rather than enable them unconditionally (which would silently
 * corrupt such files and destroy the U+FFFD signal the OCR gate relies on),
 * the worker extracts with both options OFF, then re-extracts ONLY the pages
 * whose text layer is present but overwhelmingly unmapped — the signature of
 * a wholly-unmapped font. A normal page with a handful of unmappable symbol
 * glyphs (e.g. a stray "±" or "β") sits far below the retry threshold, so its
 * honest U+FFFD survives and is never silently rewritten.
 *
 * After a retry the recovered text is accepted only if it actually resolved
 * the unknown glyphs AND reads like natural language; a misdecode produces
 * digit/punctuation/control-char soup that fails the check, so the page falls
 * back to its detectable-U+FFFD form and routes to OCR instead of being
 * accepted as wrong text.
 *
 * Pure and React/Zotero-free so it can be unit tested and used from the
 * worker without pulling in bundle-specific code.
 */
import type { RawBlock } from "./types";

const REPLACEMENT_CHAR_RE = /�/g;
const LETTER_RE = /\p{L}/gu;
const WHITESPACE_RE = /\s+/g;

/** Tunables for the unmapped-glyph recovery retry. */
export const UNMAPPED_GLYPH_RECOVERY = {
    /**
     * Minimum non-whitespace characters before a retry is considered. The
     * only goal is to skip pages with NO text layer (blank or image-only/
     * scanned — nothing to recover, left for the OCR gate). It must stay
     * low so genuinely-sparse text pages — short title/divider pages, a lone
     * heading — still recover; the replacement-ratio and acceptance checks,
     * not this floor, are what prevent false recovery.
     */
    minGlyphs: 1,
    /**
     * A page is treated as an unmapped text layer worth retrying only when
     * at least this fraction of its non-whitespace characters are U+FFFD.
     * A wholly-unmapped font is ~all-U+FFFD; a normal page with a few
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
     * misdecode produces digit/punctuation/control-char soup that fails this
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
 * it is worth re-extracting with the recovery options enabled. Cheap: a few
 * native string passes, safe to call for every page.
 */
export function isUnmappedTextLayer(page: PageLike): boolean {
    const text = collectPageText(page);
    const nonWs = countNonWhitespace(text);
    if (nonWs < UNMAPPED_GLYPH_RECOVERY.minGlyphs) return false;
    return countMatches(text, REPLACEMENT_CHAR_RE) / nonWs >= UNMAPPED_GLYPH_RECOVERY.replacementRatioToRetry;
}

/**
 * True when a recovered page should replace the original: the unknown glyphs
 * were resolved AND the result reads like natural language. When false, the
 * caller keeps the original (detectable-U+FFFD) page.
 */
export function recoveredTextIsAcceptable(recoveredPage: PageLike): boolean {
    const text = collectPageText(recoveredPage);
    const nonWs = countNonWhitespace(text);
    if (nonWs === 0) return false;
    if (countMatches(text, REPLACEMENT_CHAR_RE) / nonWs > UNMAPPED_GLYPH_RECOVERY.maxRecoveredReplacementRatio) {
        return false;
    }
    return countMatches(text, LETTER_RE) / nonWs >= UNMAPPED_GLYPH_RECOVERY.minRecoveredLetterRatio;
}

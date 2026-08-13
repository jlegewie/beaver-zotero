import React, { ReactNode } from 'react';

/**
 * Runs of anything that is not a letter or a number separate one search term
 * from the next — the rule the source search's own normalization applies, so a
 * citation-style query ("smith, 2020") yields the terms it actually matched on.
 */
const TERM_SEPARATORS = /[^\p{L}\p{N}]+/u;

/** Combining marks, which NFD splits accented characters into. */
const COMBINING_MARKS = /\p{M}+/gu;

/**
 * The fold used for comparison: lowercase, then diacritics removed, mirroring
 * how the ranking pass normalizes text.
 *
 * NFD stands in for Zotero's `removeDiacritics`, which is not reachable from
 * every context this renders in. The two agree on precomposed accents; a fold
 * only one of them performs costs a highlight, never a misplaced one.
 */
function fold(text: string): string {
    return text.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
}

/**
 * `text` folded for comparison, with each folded code unit carrying the
 * `[start, end)` bounds of the original character that produced it. A match is
 * mapped back through these, so one that begins or ends inside a fold that
 * changed length still covers whole original characters.
 *
 * Lowercasing is done over the whole string, because some mappings are
 * context-sensitive — a Greek capital sigma lowercases to the final form `ς` at
 * the end of a word and `σ` elsewhere, and the ranker sees the whole-string
 * result. Only the *length* each character contributes is taken from the
 * character alone; the content comes from the whole-string lowercase. That
 * holds because the sole conditional mapping in the default case algorithm
 * (final sigma) is length-preserving — and if that ever stops being true, the
 * walk ends out of step with the lowercased string and the caller declines to
 * highlight rather than misplacing one.
 *
 * Returns null when the mapping could not be established.
 */
function foldWithOffsets(text: string): { folded: string; start: number[]; end: number[] } | null {
    const lowered = text.toLowerCase();
    let folded = '';
    const start: number[] = [];
    const end: number[] = [];
    let index = 0;
    let loweredIndex = 0;
    for (const character of text) {
        const next = index + character.length;
        const loweredLength = character.toLowerCase().length;
        const chunk = fold(lowered.slice(loweredIndex, loweredIndex + loweredLength));
        if (chunk.length === 0) {
            // A standalone combining mark folds away entirely. Hold it inside
            // the preceding character's range so a highlight boundary can never
            // fall between a letter and its accent.
            if (end.length > 0) end[end.length - 1] = next;
        } else {
            for (let unit = 0; unit < chunk.length; unit++) {
                start.push(index);
                end.push(next);
            }
            folded += chunk;
        }
        index = next;
        loweredIndex += loweredLength;
    }
    if (loweredIndex !== lowered.length) return null;
    return { folded, start, end };
}

/** Half-open [start, end) character ranges of `text` that the query matched. */
export function queryMatchRanges(text: string, query: string): [number, number][] {
    const terms = query.split(TERM_SEPARATORS).map(fold).filter(Boolean);
    if (terms.length === 0 || text.length === 0) return [];

    const offsets = foldWithOffsets(text);
    if (!offsets) return [];
    const { folded, start, end } = offsets;
    const ranges: [number, number][] = [];
    for (const term of terms) {
        let from = 0;
        for (;;) {
            const index = folded.indexOf(term, from);
            if (index === -1) break;
            ranges.push([start[index], end[index + term.length - 1]]);
            from = index + term.length;
        }
    }

    // Terms can overlap ("art" and "article"), which would otherwise nest one
    // highlight inside another and duplicate the text between them.
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: [number, number][] = [];
    for (const range of ranges) {
        const last = merged[merged.length - 1];
        if (last && range[0] <= last[1]) {
            last[1] = Math.max(last[1], range[1]);
        } else {
            merged.push([range[0], range[1]]);
        }
    }
    return merged;
}

/**
 * Renders `text` with the parts the query matched picked out in the accent
 * color, for menu rows that build their own content instead of using
 * SearchMenu's plain-label rendering.
 *
 * Each term is matched on its own, mirroring how the source search scores
 * results — "smith 2020" matches a creator and a year that are never adjacent
 * in the text on screen.
 */
export function highlightQuery(text: string, query: string): ReactNode {
    const ranges = queryMatchRanges(text, query);
    if (ranges.length === 0) return text;

    const parts: ReactNode[] = [];
    let cursor = 0;
    ranges.forEach(([start, end], index) => {
        if (start > cursor) parts.push(text.slice(cursor, start));
        parts.push(
            <span key={index} className="font-color-accent-blue">{text.slice(start, end)}</span>
        );
        cursor = end;
    });
    if (cursor < text.length) parts.push(text.slice(cursor));
    return <>{parts}</>;
}

import React, { createContext, useContext } from 'react';

/**
 * The find-in-chat seam: the active query, the markup contract for a hit, and
 * the one definition of what "matches" means.
 *
 * Everything that highlights — the plain-text helper, the markdown transformer,
 * the navigation layer — reads its rules from here, so a hit looks and behaves
 * the same wherever it is produced.
 */

/**
 * Queries shorter than this highlight nothing. A one-character query matches
 * almost every message, which is noise rather than a result set.
 */
export const FIND_MIN_QUERY_LENGTH = 2;

/** Class on every highlighted match. Styling lives in the shared stylesheet. */
export const FIND_HIT_CLASS = 'beaver-find-hit';

/** Additional class on the single match the user has navigated to. */
export const FIND_CURRENT_CLASS = 'beaver-find-hit-current';

/**
 * Marker attribute on every hit element. The navigation layer collects hits in
 * document order with `querySelectorAll('mark[data-beaver-find]')`, so the
 * attribute — not the class — is what makes an element addressable.
 */
export const FIND_HIT_ATTR = 'data-beaver-find';

/**
 * A half-open `[start, end)` range of a match within the searched string.
 */
export interface FindMatchRange {
    start: number;
    end: number;
}

/**
 * Locate every non-overlapping, case-insensitive occurrence of `query` in
 * `text`, left to right.
 *
 * Plain substring scanning, never a RegExp: the query is user input, so a
 * regex would both throw on unbalanced input and give metacharacters meaning
 * the user did not intend.
 */
export function findMatchRanges(text: string, query: string): FindMatchRange[] {
    if (!text || !query) return [];

    // `toLowerCase()` can change a string's length for a handful of characters
    // (e.g. 'İ'), which would misalign match offsets with the original text.
    // When that happens, fall back to a case-sensitive scan so the offsets
    // returned always index into `text` correctly.
    const foldedText = text.toLowerCase();
    const foldedQuery = query.toLowerCase();
    const aligned =
        foldedText.length === text.length && foldedQuery.length === query.length;
    const haystack = aligned ? foldedText : text;
    const needle = aligned ? foldedQuery : query;

    const ranges: FindMatchRange[] = [];
    let from = 0;
    let at = haystack.indexOf(needle, from);
    while (at !== -1) {
        ranges.push({ start: at, end: at + needle.length });
        from = at + needle.length;
        at = haystack.indexOf(needle, from);
    }
    return ranges;
}

/**
 * The raw query, as typed. `''` means "nothing is being searched for", which is
 * also the default: content rendered outside a provider (note export through
 * `renderToHTML`, any isolated-store render) highlights nothing.
 */
const FindQueryContext = createContext<string>('');

export interface FindQueryProviderProps {
    /** The raw query, as typed. Gating happens in `useFindQuery`. */
    query: string;
    children?: React.ReactNode;
}

/**
 * Makes `query` visible to every chat renderer below it.
 */
export function FindQueryProvider({ query, children }: FindQueryProviderProps) {
    return <FindQueryContext.Provider value={query}>{children}</FindQueryContext.Provider>;
}

/**
 * The active find query, or `''` when nothing should be highlighted — no
 * provider above, a whitespace-only query, or one shorter than
 * `FIND_MIN_QUERY_LENGTH`.
 *
 * Every consumer goes through this hook, so the gate exists in exactly one
 * place and no renderer can highlight on a query the find bar would consider
 * too short.
 */
export function useFindQuery(): string {
    const query = useContext(FindQueryContext);
    if (!query.trim()) return '';
    return query.length >= FIND_MIN_QUERY_LENGTH ? query : '';
}

import React, { createContext, useContext, useMemo } from 'react';

/**
 * The find seam: the active query, the markup contract for a hit, and the one
 * definition of what "matches" means.
 *
 * Everything that highlights — the plain-text helper, the markdown transformer,
 * the navigation layer — reads its rules from here, so a hit looks and behaves
 * the same wherever it is produced. Find in chat provides one phrase; the
 * research table's search provides its terms, each highlighted on its own.
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
 * What is being found: one phrase, or several terms that each match on their
 * own (`''` or no terms: nothing).
 */
export type FindQuery = string | readonly string[];

/**
 * A half-open `[start, end)` range of a match within the searched string.
 */
export interface FindMatchRange {
    start: number;
    end: number;
}

/**
 * Locate every non-overlapping, case-insensitive occurrence of `query` in
 * `text`, left to right. With several terms, every occurrence of any of them;
 * hits that overlap or touch merge into one range.
 *
 * Plain substring scanning, never a RegExp: the query is user input, so a
 * regex would both throw on unbalanced input and give metacharacters meaning
 * the user did not intend.
 */
export function findMatchRanges(text: string, query: FindQuery): FindMatchRange[] {
    if (typeof query === 'string') return phraseRanges(text, query);
    const all = query
        .flatMap((term) => phraseRanges(text, term))
        .sort((a, b) => a.start - b.start);
    const merged: FindMatchRange[] = [];
    for (const range of all) {
        const last = merged[merged.length - 1];
        if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
        else merged.push({ ...range });
    }
    return merged;
}

function phraseRanges(text: string, query: string): FindMatchRange[] {
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
 * The raw query, as typed (or its terms). `''` means "nothing is being searched
 * for", which is also the default: content rendered outside a provider (note
 * export through `renderToHTML`, any isolated-store render) highlights nothing.
 */
const FindQueryContext = createContext<FindQuery>('');

export interface FindQueryProviderProps {
    /**
     * The raw query, as typed, or its terms. Gating happens in `useFindQuery`.
     * Terms must keep their identity while unchanged: every highlighting
     * renderer re-renders when it changes.
     */
    query: FindQuery;
    children?: React.ReactNode;
}

/**
 * Makes `query` visible to every renderer below it, gated once here: `''` for
 * a whitespace-only query or one shorter than `FIND_MIN_QUERY_LENGTH`; of
 * several terms, only those long enough.
 */
export function FindQueryProvider({ query, children }: FindQueryProviderProps) {
    const active = useMemo<FindQuery>(() => {
        if (typeof query === 'string') return isFindQueryActive(query) ? query : '';
        const terms = query.filter(isFindQueryActive);
        return terms.length ? terms : '';
    }, [query]);
    return <FindQueryContext.Provider value={active}>{children}</FindQueryContext.Provider>;
}

/**
 * Whether a raw query (or one term) is one that should highlight anything.
 *
 * The single definition of the gate. The find bar asks it to decide whether to
 * show a result count, and the provider applies it for every renderer, so the
 * bar can never claim results for a query the renderers ignore.
 */
export function isFindQueryActive(query: string): boolean {
    return query.trim().length > 0 && query.length >= FIND_MIN_QUERY_LENGTH;
}

/**
 * The active find query, or `''` when nothing should be highlighted — no
 * provider above, or a query the provider's gate rejects.
 *
 * Every consumer goes through this hook, so no renderer can highlight on a
 * query the find bar would consider too short.
 */
export function useFindQuery(): FindQuery {
    return useContext(FindQueryContext);
}

/**
 * Ranking for library search results.
 *
 * Shared by the source-picker UI and the agent data provider's quick search, so
 * the same query puts the same item in the same place wherever it is shown.
 *
 * React-free by requirement: the data provider is in the esbuild bundle, which
 * cannot reach `react/*`.
 */

/**
 * Scores a Zotero item against a search query. Higher ranks first; 0 means the
 * ranked text matched no query term.
 *
 * A 0 does not mean "not a match" — Zotero's `quicksearch-titleCreatorYear`
 * also matches publicationTitle, shortTitle, court, citationKey and the item
 * key, none of which the ranked text below covers. Callers must rank zero-score
 * hits last rather than discard them.
 *
 * @param item - The Zotero item to score.
 * @param query - The search query to score the item against.
 * @returns A score for the item based on the search query.
 */
export const scoreSearchResult = (item: Zotero.Item, query: string): number => {
    const normalizedQuery = normalizeSearchText(query);
    const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
    if (queryTerms.length === 0) {
        return 0;
    }

    const searchableText = getRankedMetadataText(item);
    if (!searchableText) {
        return 0;
    }

    const phraseIndex = searchableText.indexOf(normalizedQuery);
    const termIndexes = queryTerms
        .map((term) => searchableText.indexOf(term))
        .filter((index) => index >= 0);

    if (phraseIndex < 0 && termIndexes.length === 0) {
        return 0;
    }

    const allTermsMatched = termIndexes.length === queryTerms.length;
    const bestMatchIndex = phraseIndex >= 0
        ? phraseIndex
        : Math.min(...termIndexes);
    const boundedMatchIndex = Math.min(bestMatchIndex, 100_000);
    const publicationYear = getPublicationYear(item) ?? 0;
    const completenessScore = allTermsMatched ? 2_000_000_000 : termIndexes.length * 10_000_000;
    const positionScore = (100_000 - boundedMatchIndex) * 10_000;
    const itemTypeScore = item.isRegularItem() ? 1 : 0;

    return completenessScore + positionScore + publicationYear + itemTypeScore;
};

/** A quick-search hit with its {@link scoreSearchResult} score. */
export interface RankedSearchResult {
    item: Zotero.Item;
    score: number;
    /** The item's publication year, read once up front; read on demand when absent. */
    year?: number;
}

/**
 * Sort order for scored quick-search hits, best first: by score, then newest
 * first, then library and key, so the order does not depend on the order the
 * libraries were searched in.
 *
 * The year only decides between equal scores. Every zero-score hit (a real
 * Zotero match on a field the scorer does not read, such as a journal name or
 * a citation key) ties at 0, so those list newest first, after every hit the
 * scorer could rank.
 */
export const compareRankedResults = (a: RankedSearchResult, b: RankedSearchResult): number => (
    b.score - a.score
    || (b.year ?? getPublicationYear(b.item) ?? 0) - (a.year ?? getPublicationYear(a.item) ?? 0)
    || a.item.libraryID - b.item.libraryID
    || (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0)
);

/** Orders quick-search hits best first (see {@link compareRankedResults}). */
export const rankSearchResults = (items: Zotero.Item[], query: string): Zotero.Item[] =>
    items
        .map((item) => ({ item, score: scoreSearchResult(item, query), year: getPublicationYear(item) ?? 0 }))
        .sort(compareRankedResults)
        .map(({ item }) => item);

/** A field Zotero's quick search matches that the scorer does not read. */
export type UnrankedMatchField = 'publicationTitle' | 'shortTitle' | 'court' | 'citationKey' | 'key';

const UNRANKED_FIELDS = ['publicationTitle', 'shortTitle', 'court', 'citationKey'] as const;

/**
 * Where a quick-search hit matched `query` when the scorer could not see it:
 * the first field Zotero searches, outside creators, year and title, that
 * holds a query term. Null for a hit the scorer ranks (score above 0) or one
 * whose match it cannot place. The source picker shows it, so a row found
 * only through its journal says so.
 */
export const unrankedMatch = (
    item: Zotero.Item,
    query: string,
): { field: UnrankedMatchField; value: string } | null => {
    if (scoreSearchResult(item, query) > 0) return null;
    const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    for (const field of UNRANKED_FIELDS) {
        const value = readField(item, field);
        const normalizedValue = value ? normalizeSearchText(value) : '';
        if (normalizedValue && terms.some((term) => normalizedValue.includes(term))) {
            return { field, value };
        }
    }
    const key = item.key.toLowerCase();
    return terms.includes(key) ? { field: 'key', value: item.key } : null;
};

/**
 * A field's value, base-mapped like Zotero's search conditions (a book
 * section's book title is its `publicationTitle`, a case's name its `title`).
 * Empty when the item type lacks the field.
 */
const readField = (item: Zotero.Item, field: string): string => {
    try {
        return item.getField(field, false, true) || '';
    } catch {
        return '';
    }
};

/**
 * Builds the ordered metadata text used for source-menu ranking.
 */
const getRankedMetadataText = (item: Zotero.Item): string => {
    const creatorText = item.getCreators()
        .map((creator) => {
            const firstName = creator.firstName || '';
            const lastName = creator.lastName || '';
            return `${lastName} ${firstName} ${firstName} ${lastName}`.trim();
        })
        .filter(Boolean)
        .join(' ');
    const year = getPublicationYear(item)?.toString() || '';
    const title = readField(item, 'title');

    return normalizeSearchText([creatorText, year, title].filter(Boolean).join(' '));
};

/**
 * Normalizes metadata and query text before ranking comparisons.
 */
const normalizeSearchText = (text: string): string => {
    let normalized = text.toLowerCase();
    try {
        normalized = Zotero.Utilities.removeDiacritics(normalized);
    } catch {
        // Some Zotero contexts expose a smaller utility surface.
    }
    return normalized.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
};

/**
 * Extracts the first four-digit year from an item's date field.
 */
const getPublicationYear = (item: Zotero.Item): number | undefined => {
    const date = readField(item, 'date');
    const year = date.match(/\b(\d{4})\b/)?.[1];
    return year ? parseInt(year, 10) : undefined;
};

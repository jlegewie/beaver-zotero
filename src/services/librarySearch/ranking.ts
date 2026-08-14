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
    const title = item.getField('title') || '';

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
    const date = item.getField('date') || '';
    const year = date.match(/\b(\d{4})\b/)?.[1];
    return year ? parseInt(year, 10) : undefined;
};

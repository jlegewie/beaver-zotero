import { getPref, setPref } from '../../src/utils/prefs';
import { LibrarySuggestionsResponse } from '../types/librarySuggestions';

const LIBRARY_SUGGESTIONS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Slim shape persisted to prefs
 */
function toCachedShape(response: LibrarySuggestionsResponse): LibrarySuggestionsResponse {
    return {
        cards: response.cards,
        facts: {
            library_size: response.facts.library_size,
            unfiled_item_count: 0,
            total_tag_count: 0,
            user_collection_count: 0,
        },
        generated_at: response.generated_at,
    };
}

export function readCachedSuggestions(): LibrarySuggestionsResponse | null {
    const raw = getPref('librarySuggestions');
    const generatedAt = getPref('librarySuggestionsGeneratedAt');
    if (!raw || !generatedAt) return null;

    const age = Date.now() - new Date(generatedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age > LIBRARY_SUGGESTIONS_CACHE_TTL_MS) return null;

    try {
        return JSON.parse(raw) as LibrarySuggestionsResponse;
    } catch (err) {
        Zotero.logError(err as Error);
        return null;
    }
}

export function writeCachedSuggestions(response: LibrarySuggestionsResponse): void {
    setPref('librarySuggestions', JSON.stringify(toCachedShape(response)));
    setPref('librarySuggestionsGeneratedAt', new Date().toISOString());
}

export function clearCachedSuggestions(): void {
    setPref('librarySuggestions', '');
    setPref('librarySuggestionsGeneratedAt', '');
}

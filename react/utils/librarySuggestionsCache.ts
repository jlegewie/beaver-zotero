import { getPref, setPref } from '../../src/utils/prefs';
import { CardKind, LibrarySuggestionsResponse } from '../types/librarySuggestions';

const LIBRARY_SUGGESTIONS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Kinds whose backend builders always set `topic_label`. Used by the schema
// guard in `readCachedSuggestions` to invalidate cache entries from before
// the field existed.
const TOPIC_ANCHORED_KINDS: Set<CardKind> = new Set(['literature_review', 'discover_research']);

/**
 * Slim shape persisted to prefs.
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
        const parsed = JSON.parse(raw) as LibrarySuggestionsResponse;
        // Schema guard: pre-segments cache entries are missing description_segments
        // on every card. Treat as a miss so the next call refetches with the new
        // shape, instead of rendering a degraded fallback for up to 24h.
        const hasSegments = parsed.cards.length === 0
            || parsed.cards.every((c) => Array.isArray((c as any).description_segments));
        if (!hasSegments) return null;
        // Cards built before topic_label was added have no `topic_label` field;
        // the topic-anchored followups in NextStepsPanel would silently fall back
        // to generic copy. Invalidate so the next call hydrates the new shape.
        const hasTopicShape = parsed.cards.every(
            (c) => !TOPIC_ANCHORED_KINDS.has(c.kind) || 'topic_label' in (c as any),
        );
        if (!hasTopicShape) return null;
        return parsed;
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

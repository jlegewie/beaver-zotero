import type { MessageFiltersState } from '../atoms/messageComposition';

export interface SanitizedMessageFilters {
    state: MessageFiltersState;
    changed: boolean;
}

/**
 * Removes message search filters that target libraries Beaver cannot search.
 */
export function sanitizeMessageFiltersForSearchableLibraries(
    filters: MessageFiltersState,
    searchableLibraryIds: readonly number[],
): SanitizedMessageFilters {
    const searchable = new Set(searchableLibraryIds);

    const libraryIds = filters.libraryIds.filter((id) => searchable.has(id));
    const collectionIds = filters.collectionIds.filter((id) => {
        try {
            const collection = Zotero.Collections.get(id);
            return !!collection && searchable.has(collection.libraryID);
        } catch {
            return false;
        }
    });
    const tagSelections = filters.tagSelections.filter((tag) => searchable.has(tag.libraryId));

    const changed =
        libraryIds.length !== filters.libraryIds.length ||
        collectionIds.length !== filters.collectionIds.length ||
        tagSelections.length !== filters.tagSelections.length;

    return {
        state: {
            libraryIds,
            collectionIds,
            tagSelections,
        },
        changed,
    };
}

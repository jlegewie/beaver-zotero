export interface RecentChatsItemLookup {
    libraryId: number;
    zoteroKeys: string[];
}

/**
 * Partition Recent Chats cache entries by the current library-access boundary.
 * Sorting keeps the key stable when the same IDs arrive in a different order.
 */
export function buildRecentChatsCacheKey(
    baseKey: string,
    searchableLibraryIds: readonly number[],
): string {
    const libraryAccessKey = [...searchableLibraryIds]
        .sort((a, b) => a - b)
        .join(',');
    return `${baseKey}:libraries:${libraryAccessKey}`;
}

/**
 * Build the item-specific Recent Chats lookup only when the item's library is
 * currently searchable. Returning null is the privacy boundary: callers must
 * fall back to generic recent threads without sending the library or item keys.
 */
export function buildRecentChatsItemLookup(
    libraryId: number | undefined,
    zoteroKeys: readonly string[],
    searchableLibraryIds: readonly number[],
): RecentChatsItemLookup | null {
    if (
        libraryId == null
        || zoteroKeys.length === 0
        || !searchableLibraryIds.includes(libraryId)
    ) {
        return null;
    }

    return { libraryId, zoteroKeys: [...zoteroKeys] };
}

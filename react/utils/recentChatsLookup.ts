export interface RecentChatsItemLookup {
    libraryId: number;
    zoteroKeys: string[];
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

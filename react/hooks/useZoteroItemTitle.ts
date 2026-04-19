/**
 * Pure helper for the (forthcoming) `useZoteroItemTitle` hook.
 *
 * `resolveAndCacheTitle` encapsulates the full resolve-and-cache flow with
 * all collaborators injected, so every async hop — item fetch, optional
 * parent fetch, itemData load, resolver invocation, cache write — is
 * independently mockable in tests.
 *
 * Cancellation: the helper polls `isCancelled()` at up to four points
 * (post-`getItem`, post-parent-fetch, post-`loadItemDataTypes`, post-
 * `resolveTitle`) to eliminate stale cache writes from resolver runs that
 * outlive their component.
 *
 * Parent handling: when the fetched item is non-top-level, we explicitly
 * call `getItemByID(item.parentID)` rather than relying on `item.parentItem`.
 * The real Zotero getter only returns an already-cached parent; for
 * attachments whose parent was not materialized yet, it returns falsy and
 * the parent's `itemData` would remain unloaded — tripping the exact error
 * path this helper exists to prevent.
 *
 * Data types: loads both `itemData` and `note`. Canonical Beaver pattern
 * (see `react/atoms/agentRunAtoms.ts:1551`) requires `note` before calling
 * `getNoteTitle()` on note items. Loading `note` on non-note items is a
 * safe no-op at the SQL level (the per-type loader filters by item type),
 * so including it uniformly keeps the helper's data-type contract simple
 * and covers resolvers that format note titles.
 */

export interface ResolveAndCacheTitleInput {
    libraryId: number;
    zoteroKey: string;
    cacheKey: string;

    /** Convert a Zotero item to a human-readable title. May be sync or async. */
    resolveTitle: (item: Zotero.Item) => string | Promise<string>;

    /** Fetch an item by (libraryId, zoteroKey). Returns undefined when not found. */
    getItem: (libraryId: number, zoteroKey: string) => Promise<Zotero.Item | undefined>;

    /**
     * Fetch an item by ID. Called only when the fetched item is non-top-level
     * and has a parentID; returns null for a deleted/missing parent.
     */
    getItemByID: (id: number) => Promise<Zotero.Item | null>;

    /** Load the named data types on every passed-in item. */
    loadItemDataTypes: (items: Zotero.Item[], types: string[]) => Promise<void>;

    /** Write the resolved title into the cache under `cacheKey`. */
    writeCache: (cacheKey: string, title: string) => void;

    /** Returns true when the caller has been unmounted or the inputs have changed. */
    isCancelled: () => boolean;

    /** Called once with a formatted message when any async step throws. */
    logError: (message: string) => void;
}

export async function resolveAndCacheTitle(input: ResolveAndCacheTitleInput): Promise<void> {
    const {
        libraryId,
        zoteroKey,
        cacheKey,
        resolveTitle,
        getItem,
        getItemByID,
        loadItemDataTypes,
        writeCache,
        isCancelled,
        logError,
    } = input;

    try {
        const item = await getItem(libraryId, zoteroKey);
        if (!item) return;
        if (isCancelled()) return;

        const toLoad: Zotero.Item[] = [item];
        if (!item.isTopLevelItem?.() && typeof item.parentID === 'number') {
            const parent = await getItemByID(item.parentID);
            if (isCancelled()) return;
            if (parent) toLoad.push(parent);
        }

        await loadItemDataTypes(toLoad, ['itemData', 'note']);
        if (isCancelled()) return;

        const title = await resolveTitle(item);
        if (isCancelled()) return;

        writeCache(cacheKey, title);
    } catch (error: any) {
        const message = error?.message ?? String(error);
        logError(`useZoteroItemTitle: lookup failed for ${cacheKey}: ${message}`);
    }
}

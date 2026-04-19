/**
 * `useZoteroItemTitle` — shared item/note title lookup hook for agent-
 * action views. Replaces the duplicated title-fetching `useEffect` blocks
 * in `AgentActionView.tsx` and `EditNoteGroupView.tsx`.
 *
 * `resolveAndCacheTitle` encapsulates the full resolve-and-cache flow with
 * all collaborators injected, so every async hop — item fetch, optional
 * parent fetch, itemData load, resolver invocation, cache write — is
 * independently mockable in tests. The React hook below is a thin wrapper
 * that wires real Zotero APIs, the title-cache atom, and `logger` into it.
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

import { useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { agentActionItemTitlesAtom, setAgentActionItemTitleAtom } from '../atoms/messageUIState';
import { shortItemTitle } from '../../src/utils/zoteroUtils';
import { logger } from '../../src/utils/logger';

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

// ---------------------------------------------------------------------------
// Hook wrapper
// ---------------------------------------------------------------------------

export type ItemTitleResolver = (item: Zotero.Item) => string | Promise<string>;

export interface UseZoteroItemTitleParams {
    libraryId: number | undefined | null;
    zoteroKey: string | undefined | null;
    /**
     * Cache key into `agentActionItemTitlesAtom`. Pass `null` to disable
     * the hook entirely (no fetch, returns `null`).
     */
    cacheKey: string | null;
    /**
     * Defaults to `shortItemTitle`. Held internally in a ref so inline
     * resolvers (new function identity per render) do not destabilize the
     * fetch effect.
     */
    resolveTitle?: ItemTitleResolver;
}

const DEFAULT_RESOLVE_TITLE: ItemTitleResolver = (item) => shortItemTitle(item);

/**
 * Fetches and caches an item title for display in an agent-action header.
 * Returns the cached title (or `null` while loading / when disabled).
 *
 * Gating: the effect fires only when `cacheKey != null`, `libraryId` is a
 * positive number, `zoteroKey` is a non-empty string, and no title is
 * cached yet. This preserves the truthy guards at the original call sites
 * (libraryID 0 has never been a valid Zotero ID; user library is 1).
 */
export function useZoteroItemTitle(params: UseZoteroItemTitleParams): string | null {
    const { libraryId, zoteroKey, cacheKey, resolveTitle } = params;

    const titleMap = useAtomValue(agentActionItemTitlesAtom);
    const setItemTitle = useSetAtom(setAgentActionItemTitleAtom);
    const cachedTitle = cacheKey !== null ? (titleMap[cacheKey] ?? null) : null;

    // Hold the resolver behind a ref so inline resolvers do not force the
    // effect to re-run on every render. Updated on every render so the
    // effect body always calls the latest resolver.
    const resolverRef = useRef<ItemTitleResolver>(resolveTitle ?? DEFAULT_RESOLVE_TITLE);
    resolverRef.current = resolveTitle ?? DEFAULT_RESOLVE_TITLE;

    useEffect(() => {
        if (cacheKey === null) return;
        if (cachedTitle !== null) return;
        if (typeof libraryId !== 'number' || libraryId <= 0) return;
        if (typeof zoteroKey !== 'string' || zoteroKey.length === 0) return;

        let cancelled = false;

        void resolveAndCacheTitle({
            libraryId,
            zoteroKey,
            cacheKey,
            resolveTitle: (item) => resolverRef.current(item),
            getItem: (lib, key) => Zotero.Items.getByLibraryAndKeyAsync(lib, key) as Promise<Zotero.Item | undefined>,
            getItemByID: (id) => Zotero.Items.getAsync(id) as Promise<Zotero.Item | null>,
            loadItemDataTypes: (items, types) => Zotero.Items.loadDataTypes(items, types),
            writeCache: (key, title) => setItemTitle({ key, title }),
            isCancelled: () => cancelled,
            logError: (message) => logger(message, 1),
        });

        return () => {
            cancelled = true;
        };
    }, [libraryId, zoteroKey, cacheKey, cachedTitle, setItemTitle]);

    return cachedTitle;
}

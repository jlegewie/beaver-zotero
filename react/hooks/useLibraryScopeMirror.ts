/**
 * Mirrors the searchable-library scope (local libraries minus the profile's
 * excluded libraries) into the esbuild-readable `Zotero.Beaver` globals, so
 * background code that cannot import Jotai — the background queue dispatcher
 * and the OCR enqueue gate — enforces the same exclusion boundary as the agent
 * data handlers. Readers use `src/services/libraryScope`.
 *
 * The mirror is published from a store subscription rather than a React
 * effect: exclusions change from async callbacks (a preference toggle's server
 * round-trip, a profile refresh), and a passive effect would leave the mirror
 * granting access until React flushed. A background tick landing in that gap
 * would claim a job for a library the user has already excluded, so the mirror
 * must be updated in the same synchronous turn as the store write.
 */

import { useEffect } from 'react';
import type { createStore } from 'jotai';
import {
    libraryScopeInitializedAtom,
    searchableLibraryIdsAtom,
} from '../atoms/profile';
import { store } from '../store';
import { logger } from '../../src/utils/logger';

type JotaiStore = ReturnType<typeof createStore>;

type LibraryScopeMirror = {
    searchableLibraryIds?: number[];
    libraryScopeInitialized?: boolean;
};

/** Last published scope, so equivalent refreshes do not spam the log. */
let lastPublishedKey: string | null = null;

/**
 * Copy the current scope onto `Zotero.Beaver`, then stop any in-flight
 * background job whose library just left the set. Extraction can run for
 * minutes, so revoked access must interrupt work already underway, not only
 * gate the next claim.
 */
export function publishLibraryScope(scopeStore: JotaiStore = store): void {
    const beaver = Zotero.Beaver as LibraryScopeMirror | undefined;
    if (!beaver) return;

    if (!scopeStore.get(libraryScopeInitializedAtom)) {
        // Clear the flag before the ids so a reader can never observe a stale
        // set that still claims to be authoritative.
        beaver.libraryScopeInitialized = false;
        beaver.searchableLibraryIds = undefined;
        if (lastPublishedKey !== null) {
            logger('useLibraryScopeMirror: library scope cleared', 3);
            lastPublishedKey = null;
        }
    } else {
        const searchableLibraryIds = scopeStore.get(searchableLibraryIdsAtom);
        beaver.searchableLibraryIds = [...searchableLibraryIds];
        beaver.libraryScopeInitialized = true;
        const key = searchableLibraryIds.join(',');
        if (lastPublishedKey !== key) {
            logger(`useLibraryScopeMirror: library scope = [${key}]`, 3);
            lastPublishedKey = key;
        }
    }

    Zotero.Beaver?.backgroundExtractor?.abortJobsOutsideScope?.();
    // Whole-library producers (reconciler / watcher) read the same mirror;
    // wake them in the same turn so exclusion and login changes do not wait
    // for the next poll interval.
    Zotero.Beaver?.processingReconciler?.notify();
}

/**
 * Publish the current scope and keep it in sync. Returns an unsubscribe.
 */
export function subscribeLibraryScopeMirror(
    scopeStore: JotaiStore = store,
): () => void {
    publishLibraryScope(scopeStore);
    const unsubscribers = [
        scopeStore.sub(libraryScopeInitializedAtom, () => publishLibraryScope(scopeStore)),
        scopeStore.sub(searchableLibraryIdsAtom, () => publishLibraryScope(scopeStore)),
    ];
    return () => {
        for (const unsubscribe of unsubscribers) unsubscribe();
    };
}

export function useLibraryScopeMirror(): void {
    useEffect(() => {
        // The mirror itself is deliberately not cleared when this unmounts: on
        // macOS the last window can close while the plugin (and the background
        // queue) keeps running, and the scope cannot change without a window to
        // change it in. Logout and account switches clear it through
        // `libraryScopeInitializedAtom` while a window is still open.
        return subscribeLibraryScopeMirror();
    }, []);
}

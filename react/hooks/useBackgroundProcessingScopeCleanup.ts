import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import {
    hasSearchIndexAccessAtom,
    libraryScopeInitializedAtom,
    localZoteroLibrariesAtom,
    searchableLibraryIdsAtom,
} from '../atoms/profile';
import { searchIndexApiClient } from '../../src/services/searchIndex/searchIndexApiClient';
import { BACKGROUND_UNTAG_PRIORITY } from '../../src/services/backgroundProcessing/constants';
import { buildIndexJobPayload } from '../../src/services/backgroundProcessing/utils';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../src/utils/zoteroUtils';
import { logger } from '../../src/utils/logger';

const EXCLUDED_LIBRARY_CLEANUP_RETRY_MS = 15 * 60_000;

/**
 * Enforce Beaver's library-exclusion boundary on derived local state and cloud
 * membership. Unlike the ordinary /refs sweep, this destructive path runs only
 * for libraries the user explicitly excluded.
 */
export function useBackgroundProcessingScopeCleanup(): void {
    const initialized = useAtomValue(libraryScopeInitializedAtom);
    const libraries = useAtomValue(localZoteroLibrariesAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const hasSearchAccess = useAtomValue(hasSearchIndexAccessAtom);
    const allKey = libraries.map((library) => library.library_id).sort((a, b) => a - b).join(',');
    const searchableKey = [...searchableLibraryIds].sort((a, b) => a - b).join(',');

    useEffect(() => {
        if (!initialized) return;
        let cancelled = false;
        const searchable = new Set(searchableLibraryIds);
        const excludedIds = libraries
            .map((library) => library.library_id)
            .filter((libraryId) => !searchable.has(libraryId));
        if (excludedIds.length === 0) return;

        let running = false;
        const completed = new Set<number>();
        let timer: ReturnType<typeof setInterval> | null = null;
        const run = () => {
            if (running || cancelled) return;
            const pending = excludedIds.filter((libraryId) => !completed.has(libraryId));
            if (pending.length === 0) {
                if (timer) clearInterval(timer);
                timer = null;
                return;
            }
            running = true;
            void purgeExcludedLibraries(pending, hasSearchAccess, () => cancelled)
                .then((finished) => {
                    for (const libraryId of finished) completed.add(libraryId);
                })
                .catch((error) => logger(`Background scope cleanup failed: ${error}`, 1))
                .finally(() => {
                    running = false;
                    if (completed.size === excludedIds.length && timer) {
                        clearInterval(timer);
                        timer = null;
                    }
                });
        };
        run();
        timer = setInterval(run, EXCLUDED_LIBRARY_CLEANUP_RETRY_MS);
        return () => {
            cancelled = true;
            if (timer) clearInterval(timer);
        };
    }, [allKey, hasSearchAccess, initialized, searchableKey]);
}

export async function purgeExcludedLibraries(
    libraryIds: number[],
    hasSearchAccess: boolean,
    isCancelled: () => boolean,
): Promise<Set<number>> {
    const completed = new Set<number>();
    const db = Zotero.Beaver?.db;
    if (!db) return completed;
    const { localUserKey } = getZoteroUserIdentifier();

    for (const libraryId of libraryIds) {
        const isStillExcluded = () =>
            !(Zotero.Beaver?.searchableLibraryIds ?? []).includes(libraryId);
        if (isCancelled()) return completed;
        if (!isStillExcluded()) continue;
        const rows = await db.getAttachmentProcessingStatesByLibrary(libraryId);
        const ledgerWasEmpty = rows.length === 0;
        const refs = new Map<string, {
            zoteroKey: string;
            docHash: string;
            contentKind: 'pdf' | 'epub' | 'snapshot';
            itemId: number | null;
        }>();
        for (const row of rows) {
            if (!row.structuredDocumentHash || row.upsertStatus !== 'done') continue;
            refs.set(`${row.zoteroKey}:${row.structuredDocumentHash}`, {
                zoteroKey: row.zoteroKey,
                docHash: row.structuredDocumentHash,
                contentKind: row.contentKind,
                itemId: row.itemId,
            });
        }

        // Cancel all local work before adding the only allowed post-exclusion
        // intent: a remote membership removal that reads no library content.
        await db.deleteBackgroundJobsByLibrary(libraryId);

        let remoteListingComplete = !hasSearchAccess;
        let remoteRefCount = 0;
        if (hasSearchAccess) {
            const scopeRef = getIndexScopeRef(libraryId);
            if (scopeRef) {
                try {
                    let cursor: string | null = null;
                    do {
                        const page = await searchIndexApiClient.listRefs({
                            scopeRef,
                            zoteroLocalId: localUserKey,
                            cursor,
                        });
                        for (const ref of page.refs) {
                            remoteRefCount += 1;
                            const key = `${ref.zotero_key}:${ref.doc_hash}`;
                            if (!refs.has(key)) {
                                refs.set(key, {
                                    zoteroKey: ref.zotero_key,
                                    docHash: ref.doc_hash,
                                    contentKind: 'pdf',
                                    itemId: null,
                                });
                            }
                        }
                        cursor = page.next_cursor;
                    } while (cursor && !isCancelled());
                    remoteListingComplete = !isCancelled();
                } catch (error) {
                    // Ledger-known refs below are still durably queued. A later
                    // scope refresh/app start retries discovery of any others.
                    logger(`Excluded-library remote listing failed for ${libraryId}: ${error}`, 2);
                }
            } else {
                remoteListingComplete = true;
            }
        }

        if (!isStillExcluded()) continue;
        if (hasSearchAccess && refs.size > 0 && !isCancelled()) {
            await db.enqueueBackgroundJobs([...refs.values()].map((ref) => ({
                jobType: 'fulltext_untag' as const,
                libraryId,
                itemId: ref.itemId,
                zoteroKey: ref.zoteroKey,
                contentKind: ref.contentKind,
                payloadKind: 'structured' as const,
                priority: BACKGROUND_UNTAG_PRIORITY,
                payload: buildIndexJobPayload(ref.contentKind, {
                    indexAction: 'untag',
                    docHash: ref.docHash,
                }),
                now: Date.now(),
            })));
        }

        await Zotero.Beaver?.documentCache?.invalidateByLibrary(libraryId);
        await db.deleteAttachmentProcessingStatesByLibrary(libraryId);
        await db.deleteProcessingIndexState(libraryId);
        Zotero.Beaver?.backgroundExtractor?.notify();
        if (ledgerWasEmpty && remoteListingComplete && remoteRefCount === 0) {
            completed.add(libraryId);
        }
    }
    return completed;
}

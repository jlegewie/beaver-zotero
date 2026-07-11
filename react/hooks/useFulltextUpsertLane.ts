import { useEffect } from 'react';
import { useAtomValue } from 'jotai';
import {
    hasSearchIndexAccessAtom,
    libraryScopeInitializedAtom,
    searchableLibraryIdsAtom,
} from '../atoms/profile';
import { FulltextUpsertExecutor } from '../../src/services/backgroundQueue/fulltextUpsertExecutor';
import { searchIndexApiClient } from '../../src/services/searchIndex/searchIndexApiClient';
import {
    BACKGROUND_UPSERT_PRIORITY,
    EXPECTED_SEARCH_INDEX_VERSION,
    INDEX_RECONCILE_INTERVAL_MS,
} from '../../src/services/backgroundProcessing/constants';
import {
    buildIndexJobPayload,
    backgroundProcessingEnabled,
    isBackgroundProcessingLibraryEnabled,
} from '../../src/services/backgroundProcessing/utils';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../src/utils/zoteroUtils';
import { logger } from '../../src/utils/logger';

const INDEX_LANE_MAX_IN_FLIGHT = 2;
const UNTAG_REDRIVE_INTERVAL_MS = 6 * 60 * 60_000;

export function useFulltextUpsertLane(): void {
    const hasAccess = useAtomValue(hasSearchIndexAccessAtom);
    const scopeInitialized = useAtomValue(libraryScopeInitializedAtom);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const scopeKey = scopeInitialized
        ? [...searchableLibraryIds].sort((a, b) => a - b).join(',')
        : null;

    useEffect(() => {
        if (!hasAccess || scopeKey === null) return;
        let cancelled = false;
        let registrationTimer: ReturnType<typeof setInterval> | null = null;
        const executor = new FulltextUpsertExecutor();
        const untagExecutor = new FulltextUpsertExecutor(
            searchIndexApiClient,
            'fulltext_untag',
        );
        const register = () => {
            const dispatcher = Zotero.Beaver?.backgroundExtractor;
            if (!dispatcher) return false;
            dispatcher.registerExecutor(executor, { maxInFlight: INDEX_LANE_MAX_IN_FLIGHT });
            dispatcher.registerExecutor(untagExecutor, { maxInFlight: 1 });
            return true;
        };
        if (!register()) {
            registrationTimer = setInterval(() => {
                if (cancelled) return;
                if (register() && registrationTimer) {
                    clearInterval(registrationTimer);
                    registrationTimer = null;
                }
            }, 1_000);
        }

        const runSweep = () => void reconcileRemoteRefs(searchableLibraryIds, () => cancelled)
            .catch((error) => logger(`useFulltextUpsertLane: ref reconcile failed: ${error}`, 2));
        const initialTimer = setTimeout(runSweep, 2_000);
        const sweepTimer = setInterval(runSweep, INDEX_RECONCILE_INTERVAL_MS);
        const redriveUntags = () => {
            const db = Zotero.Beaver?.db;
            if (!db) return;
            void db.redriveDeadUntagJobs(Date.now(), 100)
            .then((count) => {
                if (count > 0) Zotero.Beaver?.backgroundExtractor?.notify();
            })
            .catch((error) => logger(`useFulltextUpsertLane: untag redrive failed: ${error}`, 2));
        };
        const redriveTimer = setTimeout(redriveUntags, 5_000);
        const redriveInterval = setInterval(redriveUntags, UNTAG_REDRIVE_INTERVAL_MS);

        return () => {
            cancelled = true;
            clearTimeout(initialTimer);
            clearInterval(sweepTimer);
            clearTimeout(redriveTimer);
            clearInterval(redriveInterval);
            if (registrationTimer) clearInterval(registrationTimer);
            Zotero.Beaver?.backgroundExtractor?.unregisterExecutor(
                executor.jobType,
                executor,
            );
            Zotero.Beaver?.backgroundExtractor?.unregisterExecutor(
                untagExecutor.jobType,
                untagExecutor,
            );
        };
    }, [hasAccess, scopeKey]);
}

export async function reconcileRemoteRefs(
    libraryIds: number[],
    isCancelled: () => boolean,
): Promise<void> {
    const db = Zotero.Beaver?.db;
    if (
        !db
        || Zotero.Beaver?.hasSearchIndexAccess !== true
        || !backgroundProcessingEnabled()
    ) return;
    const { localUserKey } = getZoteroUserIdentifier();
    for (const libraryId of libraryIds) {
        if (isCancelled()) return;
        if (!isBackgroundProcessingLibraryEnabled(libraryId)) continue;
        const scopeRef = getIndexScopeRef(libraryId);
        if (!scopeRef) continue;

        const remote: Array<{ doc_hash: string; zotero_key: string }> = [];
        let cursor: string | null = null;
        do {
            const page = await searchIndexApiClient.listRefs({
                scopeRef,
                zoteroLocalId: localUserKey,
                cursor,
            });
            remote.push(...page.refs);
            cursor = page.next_cursor;
        } while (cursor && !isCancelled());
        if (isCancelled()) return;

        const local = await db.getAttachmentProcessingStatesByLibrary(libraryId);
        const localPairs = new Map(
            local
                .filter((row) => !!row.structuredDocumentHash)
                .map((row) => [
                    `${row.zoteroKey}:${row.structuredDocumentHash}`,
                    row,
                ]),
        );
        const remotePairs = new Set(
            remote.map((ref) => `${ref.zotero_key}:${ref.doc_hash}`),
        );

        for (const [pair, row] of localPairs) {
            if (remotePairs.has(pair)) {
                const knownVersion = row.upsertIndexVersion == null
                    ? null
                    : Number(row.upsertIndexVersion);
                if (knownVersion != null && knownVersion >= EXPECTED_SEARCH_INDEX_VERSION) {
                    await db.markAttachmentUpsertDone({
                        libraryId,
                        zoteroKey: row.zoteroKey,
                        structuredDocumentHash: row.structuredDocumentHash!,
                        upsertIndexVersion: row.upsertIndexVersion!,
                    });
                    continue;
                }
            }
            if (row.extractStatus !== 'done') continue;
            await db.enqueueBackgroundJob({
                jobType: 'fulltext_upsert',
                libraryId,
                itemId: row.itemId,
                zoteroKey: row.zoteroKey,
                contentKind: row.contentKind,
                payloadKind: 'structured',
                priority: BACKGROUND_UPSERT_PRIORITY,
                payload: buildIndexJobPayload(row.contentKind, {
                    docHash: row.structuredDocumentHash!,
                }),
                now: Date.now(),
            });
        }

        // Remote-only pairs are not safe deletion evidence. Scope refs are
        // shared across devices, while a local ledger may be empty after a
        // schema reset or incomplete before Zotero sync finishes. Explicit
        // item deletion/replacement and library exclusion own untagging.
        Zotero.Beaver?.backgroundExtractor?.notify();
    }
}

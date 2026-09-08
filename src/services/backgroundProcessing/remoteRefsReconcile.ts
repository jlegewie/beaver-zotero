import type { BackgroundJobInput } from '../database';
import { searchIndexApiClient } from '../searchIndex/searchIndexApiClient';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../utils/zoteroUtils';
import {
    BACKGROUND_UPSERT_PRIORITY,
    EXPECTED_SEARCH_INDEX_VERSION,
} from './constants';
import {
    backgroundProcessingEnabled,
    buildIndexJobPayload,
    isBackgroundProcessingLibraryEnabled,
} from './utils';

/**
 * Align the local ledger with the cloud index's tag coverage: confirm rows the
 * index already holds and re-enqueue upserts for extracted rows it is missing.
 */
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

        const remote = await searchIndexApiClient.listAllRefs({
            scopeRef,
            zoteroLocalId: localUserKey,
            isCancelled,
        });
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

        const jobs: BackgroundJobInput[] = [];
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
            jobs.push({
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
        await db.enqueueBackgroundJobs(jobs);

        // Remote-only pairs are not safe deletion evidence. Scope refs are
        // shared across devices, while a local ledger may be empty after a
        // schema reset or incomplete before Zotero sync finishes. Explicit
        // item deletion/replacement and library exclusion own untagging.
        Zotero.Beaver?.backgroundExtractor?.notify();
    }
}

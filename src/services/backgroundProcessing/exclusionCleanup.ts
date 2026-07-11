import { searchIndexApiClient } from '../searchIndex/searchIndexApiClient';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../utils/zoteroUtils';
import { logger } from '../../utils/logger';
import { BACKGROUND_UNTAG_PRIORITY } from './constants';
import { buildIndexJobPayload } from './utils';

/**
 * Enforce Beaver's library-exclusion boundary on derived local state and cloud
 * membership. Unlike the ordinary /refs sweep, this destructive path runs only
 * for libraries the user explicitly excluded. Returns the libraries whose
 * cleanup is verifiably finished (no ledger rows or remote refs remained).
 */
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
                    const remoteRefs = await searchIndexApiClient.listAllRefs({
                        scopeRef,
                        zoteroLocalId: localUserKey,
                        isCancelled,
                    });
                    remoteRefCount = remoteRefs.length;
                    for (const ref of remoteRefs) {
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

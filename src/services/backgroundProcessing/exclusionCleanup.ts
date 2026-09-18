import { captureAccountGuard } from '../accountGuard';
import { searchIndexApiClient } from '../searchIndex/searchIndexApiClient';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../utils/zoteroUtils';
import { logger } from '@beaver/agent-core/platform/logger';
import { buildUntagJobInput, indexCleanupIdentity } from './utils';

/**
 * Enforce Beaver's library-exclusion boundary on derived local state and cloud
 * membership. Unlike the ordinary /refs sweep, this destructive path runs only
 * for libraries the user explicitly excluded. Returns the libraries whose
 * cleanup is verifiably finished (no ledger rows or remote refs remained).
 */
export async function purgeExcludedLibraries(
    libraryIds: number[],
    isCancelled: () => boolean,
): Promise<Set<number>> {
    const completed = new Set<number>();
    const db = Zotero.Beaver?.db;
    const accountId = Zotero.Beaver?.account?.getSnapshot().session?.user.id;
    if (!db || !accountId) return completed;
    const accountIsCurrent = captureAccountGuard(accountId);
    const cancelled = () => isCancelled() || !accountIsCurrent();
    const { localUserKey } = getZoteroUserIdentifier();

    for (const libraryId of libraryIds) {
        const isStillExcluded = () =>
            !(Zotero.Beaver?.searchableLibraryIds ?? []).includes(libraryId);
        if (cancelled()) return completed;
        if (!isStillExcluded()) continue;
        const rows = await db.getAttachmentProcessingStatesByLibrary(libraryId);
        const ledgerWasEmpty = rows.length === 0;
        const jobs = rows.filter((row) => row.structuredDocumentHash && row.upsertRemoteIdentity)
            .map((row) => buildUntagJobInput(row, Date.now(), { reason: 'exclusion' }));

        // Cancel all local work before adding the only allowed post-exclusion
        // intent: a remote membership removal that reads no library content.
        if (cancelled() || !isStillExcluded()) continue;
        await db.deleteBackgroundJobsByLibrary(libraryId);

        let remoteListingComplete = false;
        let remoteRefCount = 0;
        const scopeRef = getIndexScopeRef(libraryId);
        if (scopeRef) {
            try {
                const remoteRefs = await searchIndexApiClient.listAllRefs({
                    scopeRef,
                    zoteroLocalId: localUserKey,
                    isCancelled: cancelled,
                });
                remoteRefCount = remoteRefs.length;
                for (const ref of remoteRefs) {
                    jobs.push(buildUntagJobInput({
                        libraryId, itemId: null, zoteroKey: ref.zotero_key, contentKind: 'pdf',
                        structuredDocumentHash: ref.doc_hash,
                        upsertRemoteIdentity: { index_account_id: accountId,
                            index_scope_ref: scopeRef, index_local_id: localUserKey },
                    }, Date.now(), { reason: 'exclusion' }));
                }
                remoteListingComplete = !cancelled();
            } catch (error) {
                // Ledger-known refs below are still durably queued. A later
                // scope refresh/app start retries discovery of any others.
                logger(`Excluded-library remote listing failed for ${libraryId}: ${error}`, 2);
            }
        } else {
            remoteListingComplete = true;
        }

        if (cancelled() || !isStillExcluded()) continue;
        // Prefer the ledger's content kind when listing returns the same membership.
        const identities = new Set<string>();
        const uniqueJobs = jobs.filter((job) => {
            const identity = indexCleanupIdentity(job);
            if (identities.has(identity)) return false;
            identities.add(identity);
            return true;
        });
        if (uniqueJobs.length > 0) await db.enqueueBackgroundJobs(uniqueJobs);

        if (cancelled() || !isStillExcluded()) continue;
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

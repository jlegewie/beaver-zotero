import type { BackgroundJobInput } from '../database';
import { searchIndexApiClient } from '../searchIndex/searchIndexApiClient';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../utils/zoteroUtils';
import { BACKGROUND_UPSERT_PRIORITY } from './constants';
import { backgroundProcessingEnabled, buildIndexJobPayload, isBackgroundProcessingLibraryEnabled } from './utils';

const RECOVERY_BATCH_SIZE = 50;

/** Recover unknown acknowledgements incrementally; settled rows need no remote audit. */
export async function reconcileRemoteRefs(libraryIds: number[], isCancelled: () => boolean): Promise<number> {
    const owner = Zotero.Beaver;
    const db = owner?.db;
    if (!db || owner.hasSearchIndexAccess !== true || !backgroundProcessingEnabled()) return 0;
    const generation = owner.account?.getGeneration();
    const accountId = owner.account?.getSnapshot().session?.user.id;
    if (!accountId) return 0;
    const { localUserKey } = getZoteroUserIdentifier();
    const cancelled = () => isCancelled() || generation !== owner.account?.getGeneration();
    const requirements = await searchIndexApiClient.requirements();
    if (cancelled()) return 0;
    owner.background?.searchReadiness?.setRequirements(requirements);
    if (!requirements.index_validity || requirements.index_validity === 'unknown') return 0;
    if (!Number.isSafeInteger(requirements.namespace_generation) || (requirements.namespace_generation ?? 0) <= 0) return 0;
    const summary = owner.background?.searchReadiness?.getSummary();
    if (requirements.index_validity === 'current' && summary && summary.namespace_generation === requirements.namespace_generation
        && summary.libraries.every(lib => lib.discovery_complete && lib.pending === 0)) return 0;
    const jobs: BackgroundJobInput[] = [];
    for (const libraryId of libraryIds) {
        if (cancelled()) return 0;
        if (!isBackgroundProcessingLibraryEnabled(libraryId)) continue;
        const scopeRef = getIndexScopeRef(libraryId);
        if (!scopeRef) continue;
        const rows = await db.getAttachmentIndexRecoveryCandidates(libraryId, {
            accountId, scopeRef, localId: localUserKey, namespaceGeneration: requirements.namespace_generation ?? null,
            indexVersion: requirements.index_version,
        }, RECOVERY_BATCH_SIZE - jobs.length);
        for (const row of rows) {
            if (!row.structuredDocumentHash) continue;
            jobs.push({ jobType: 'fulltext_upsert', libraryId, itemId: row.itemId, zoteroKey: row.zoteroKey,
                contentKind: row.contentKind, payloadKind: 'structured', priority: BACKGROUND_UPSERT_PRIORITY,
                payload: buildIndexJobPayload(row.contentKind, { docHash: row.structuredDocumentHash }), now: Date.now() });
        }
        if (jobs.length >= RECOVERY_BATCH_SIZE) break;
    }
    if (cancelled()) return 0;
    await db.enqueueBackgroundJobs(jobs.filter(job => isBackgroundProcessingLibraryEnabled(job.libraryId)));
    if (jobs.length) owner.backgroundExtractor?.notify();
    return jobs.length;
}

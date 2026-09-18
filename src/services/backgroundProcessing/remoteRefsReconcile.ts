import type { BackgroundJobInput } from '../database';
import { searchIndexApiClient, type IndexVerifyResponse } from '../searchIndex/searchIndexApiClient';
import { getIndexScopeRef, getZoteroUserIdentifier } from '../../utils/zoteroUtils';
import {
    BACKGROUND_UPSERT_PRIORITY,
} from './constants';
import {
    backgroundProcessingEnabled,
    buildIndexJobPayload,
    isBackgroundProcessingLibraryEnabled,
} from './utils';

const INDEX_VERIFY_BATCH_SIZE = 50;

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
    const accountId = Zotero.Beaver?.account?.getSnapshot().session?.user.id;
    for (const libraryId of libraryIds) {
        if (isCancelled()) return;
        if (!isBackgroundProcessingLibraryEnabled(libraryId)) continue;
        const scopeRef = getIndexScopeRef(libraryId);
        if (!scopeRef) continue;

        const requirements = await searchIndexApiClient.requirements();
        if (isCancelled()) return;
        const local = await db.getAttachmentProcessingStatesByLibrary(libraryId);
        const candidates = local.filter((row) => row.structuredDocumentHash && row.extractStatus === 'done');
        const verified = new Map<string, IndexVerifyResponse['refs'][number]>();
        for (let offset = 0; offset < candidates.length; offset += INDEX_VERIFY_BATCH_SIZE) {
            if (isCancelled() || !isBackgroundProcessingLibraryEnabled(libraryId)) return;
            const result = await searchIndexApiClient.verify(localUserKey, candidates.slice(offset, offset + INDEX_VERIFY_BATCH_SIZE).map((row) => ({
                scope_ref: scopeRef, zotero_key: row.zoteroKey, doc_hash: row.structuredDocumentHash!,
            })));
            for (const ref of result.refs) verified.set(`${ref.zotero_key}:${ref.doc_hash}`, ref);
        }
        if (isCancelled() || !isBackgroundProcessingLibraryEnabled(libraryId)) return;
        const jobs: BackgroundJobInput[] = [];
        for (const row of candidates) {
            if (isCancelled()) return;
            const ref = verified.get(`${row.zoteroKey}:${row.structuredDocumentHash}`);
            if (!ref) continue; // An incomplete response is unknown, not missing.
            const identity = row.upsertRemoteIdentity;
            const ownershipChanged = identity && (identity.index_account_id !== accountId
                || identity.index_scope_ref !== scopeRef || identity.index_local_id !== localUserKey);
            // The upsert lane preserves the former owner's cleanup before acquiring ownership.
            if (!ownershipChanged && (ref.state === 'current' || ref.state === 'empty')
                && ref.index_version === requirements.index_version
                && ref.extract_schema_version === row.extractSchemaVersion
                && requirements.extract_schema_versions[row.contentKind]?.includes(ref.extract_schema_version!)) {
                await db.markAttachmentUpsertDone({
                    libraryId, zoteroKey: row.zoteroKey,
                    structuredDocumentHash: row.structuredDocumentHash!,
                    upsertIndexVersion: String(ref.index_version),
                    remoteIdentity: accountId ? { index_account_id: accountId, index_scope_ref: scopeRef, index_local_id: localUserKey } : undefined,
                    expectedUpsertStatus: row.upsertStatus,
                    expectedUpsertIndexVersion: row.upsertIndexVersion,
                    expectedExtractStatus: row.extractStatus,
                });
                continue;
            }
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
        if (isCancelled()) return;
        await db.enqueueBackgroundJobs(jobs);

        // Remote-only pairs are not safe deletion evidence. Scope refs are
        // shared across devices, while a local ledger may be empty after a
        // schema reset or incomplete before Zotero sync finishes. Explicit
        // item deletion/replacement and library exclusion own untagging.
        Zotero.Beaver?.backgroundExtractor?.notify();
    }
}

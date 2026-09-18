import type {
    AttachmentProcessingStateRecord,
    BackgroundJobInput,
    BackgroundJobPayload,
} from '../database';
import { isLibraryInScope } from '../libraryScope';
import { getPref } from '../../utils/prefs';
import { BACKGROUND_UNTAG_PRIORITY } from './constants';

type ProcessableKind = AttachmentProcessingStateRecord['contentKind'];

export function backgroundProcessingEnabled(): boolean {
    return getPref('backgroundProcessingEnabled') === true;
}

/**
 * True when background producers may touch this library: the searchable-library
 * scope is known and includes it. Library exclusion in Beaver's preferences is
 * the only opt-out; there is no separate per-library processing list. Fails
 * closed while the mirror is unpublished.
 */
export function isBackgroundProcessingLibraryEnabled(libraryId: number): boolean {
    return isLibraryInScope(libraryId);
}

export function buildBackgroundExtractPayload(kind: ProcessableKind): BackgroundJobPayload {
    if (kind === 'pdf') {
        return {
            content_kind: 'pdf',
            maxPages: null,
            timeoutSeconds: 120,
        };
    }
    return { content_kind: kind } as BackgroundJobPayload;
}

export function buildIndexJobPayload(
    kind: ProcessableKind,
    options: {
        indexAction?: 'upsert' | 'untag';
        docHash?: string;
    } = {},
): BackgroundJobPayload {
    const base = buildBackgroundExtractPayload(kind);
    return {
        ...base,
        index_action: options.indexAction ?? 'upsert',
        ...(options.docHash ? { doc_hash: options.docHash } : {}),
    } as BackgroundJobPayload;
}

/** Untag job for a ledger row whose indexed content is being dropped. */
export function buildUntagJobInput(
    row: Pick<AttachmentProcessingStateRecord, 'libraryId' | 'itemId' | 'zoteroKey' | 'contentKind' | 'structuredDocumentHash' | 'upsertRemoteIdentity'>,
    now: number,
    options: { hash?: string; reason?: BackgroundJobPayload['index_cleanup_reason'] } = {},
): BackgroundJobInput {
    return {
        jobType: 'fulltext_untag',
        libraryId: row.libraryId,
        itemId: row.itemId,
        zoteroKey: row.zoteroKey,
        contentKind: row.contentKind,
        payloadKind: 'structured',
        priority: BACKGROUND_UNTAG_PRIORITY,
        payload: { ...buildIndexJobPayload(row.contentKind, {
            indexAction: 'untag',
            docHash: options.hash ?? row.structuredDocumentHash!,
        }), ...row.upsertRemoteIdentity, ...(options.reason ? { index_cleanup_reason: options.reason } : {}) },
        now,
    };
}


/** Complete remote membership identity, shared by scheduling and durable cleanup. */
export function indexCleanupIdentity(job: Pick<BackgroundJobInput, 'payload' | 'zoteroKey'>): string {
    return JSON.stringify([job.payload?.index_account_id, job.payload?.index_scope_ref,
        job.payload?.index_local_id, job.zoteroKey, job.payload?.doc_hash]);
}

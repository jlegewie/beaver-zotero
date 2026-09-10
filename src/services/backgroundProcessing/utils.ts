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
        previousDocumentHash?: string;
    } = {},
): BackgroundJobPayload {
    const base = buildBackgroundExtractPayload(kind);
    return {
        ...base,
        index_action: options.indexAction ?? 'upsert',
        ...(options.docHash ? { doc_hash: options.docHash } : {}),
        ...(options.previousDocumentHash
            ? { previous_doc_hash: options.previousDocumentHash }
            : {}),
    } as BackgroundJobPayload;
}

/** Untag job for a ledger row whose indexed content is being dropped. */
export function buildUntagJobInput(
    row: AttachmentProcessingStateRecord,
    now: number,
): BackgroundJobInput {
    return {
        jobType: 'fulltext_untag',
        libraryId: row.libraryId,
        itemId: row.itemId,
        zoteroKey: row.zoteroKey,
        contentKind: row.contentKind,
        payloadKind: 'structured',
        priority: BACKGROUND_UNTAG_PRIORITY,
        payload: buildIndexJobPayload(row.contentKind, {
            indexAction: 'untag',
            docHash: row.structuredDocumentHash!,
        }),
        now,
    };
}


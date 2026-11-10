/**
 * Shared steps of the two create-annotation executors
 * (create_highlight_annotations, create_note_annotations): resolving and
 * gating the target attachment, recording each item's outcome, and stopping a
 * batch at the deadline.
 */

import type { CreatedAnnotationResult, FailedAnnotationResult } from '@beaver/agent-core/types/agentActions/createAnnotations';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { hasLibraryIdentity, libraryRefForLibraryID, resolveItemReference, resolveLibraryRef } from '../../../utils/libraryIdentity';
import {
    EpubAnnotationError,
    HighlightPageSpanError,
    MissingPageGeometryError,
    SnapshotAnnotationError,
} from '../../annotations/createAnnotation';
import { getReadableContentKind } from '../../documentExtraction/attachmentResolution';
import { checkAborted, TimeoutContext, TimeoutError } from '../timeout';
import { ActionExecutionError, actionError, assertLibraryNotExcluded, assertLibraryRefNotExcluded } from './actionExecution';

export type AnnotationContentKind = 'pdf' | 'epub' | 'snapshot';

/** The batch item fields an outcome row echoes back. */
interface AnnotationBatchItem {
    client_item_id: string;
    index: number;
    loc_raw: string;
}

export function mapAnnotationErrorCode(error: unknown): string {
    if (error instanceof MissingPageGeometryError) {
        return error.reason === 'extraction_failed'
            ? 'page_extraction_failed'
            : 'page_geometry_unavailable';
    }
    if (
        error instanceof EpubAnnotationError
        || error instanceof SnapshotAnnotationError
        || error instanceof HighlightPageSpanError
    ) {
        return error.code;
    }
    return 'apply_failed';
}

/** PDF, EPUB, and snapshots are the supported annotation targets; else rejected. */
export function getAnnotationContentKind(attachment: Zotero.Item): AnnotationContentKind | null {
    const kind = getReadableContentKind(attachment);
    return kind === 'pdf' || kind === 'epub' || kind === 'snapshot' ? kind : null;
}

/** A numeric page_label doubles as the 1-based EPUB section ordinal fallback. */
export function epubSectionOrdinal(pageLabel: string | null | undefined): number | undefined {
    return pageLabel && /^\d+$/.test(pageLabel) ? Number(pageLabel) : undefined;
}

export function normalizeRef(raw: any): ZoteroItemReference {
    const libraryRef = raw?.library_ref ?? raw?.libraryRef;
    return {
        library_id: typeof raw?.library_id === 'number' ? raw.library_id : Number(raw?.libraryId ?? raw?.library_id ?? 0),
        zotero_key: String(raw?.zotero_key ?? raw?.zoteroKey ?? ''),
        // Carry the device-portable library_ref through unchanged when present.
        ...(typeof libraryRef === 'string' && libraryRef ? { library_ref: libraryRef } : {}),
    };
}

export async function resolveAnnotationAttachment(ref: ZoteroItemReference): Promise<Zotero.Item | null> {
    // A portable `library_ref` is a complete target on its own, so the numeric
    // `library_id` may legitimately be the unresolved sentinel.
    if (!hasLibraryIdentity(ref) || !ref.zotero_key) return null;
    const resolved = await resolveItemReference(ref);
    return resolved.status === 'found' ? resolved.item : null;
}

/**
 * The attachment an apply writes to, checked again at execution: its library
 * must be on this device and not excluded from Beaver (checked before the
 * attachment is loaded, and again on the attachment's own library), and it
 * must be a supported annotation target.
 */
export async function resolveAnnotationTarget(
    resolvedRef: ZoteroItemReference,
): Promise<{ attachment: Zotero.Item; contentKind: AnnotationContentKind }> {
    assertLibraryRefNotExcluded(resolvedRef);
    if (resolveLibraryRef(resolvedRef) === null) {
        throw actionError(
            'library_unavailable',
            `The library (${resolvedRef.library_ref}) holding this attachment is not available on this computer.`,
            { userMessage: 'Attachment library is not available on this computer' },
        );
    }
    const attachment = await resolveAnnotationAttachment(resolvedRef);
    const contentKind = attachment ? getAnnotationContentKind(attachment) : null;
    if (!attachment || !contentKind) {
        throw actionError('invalid_attachment', 'Resolved item is not a local PDF, EPUB or snapshot attachment');
    }
    assertLibraryNotExcluded(attachment.libraryID);
    return { attachment, contentKind };
}

export function createdRow(item: AnnotationBatchItem, ref: { library_id: number; zotero_key: string }): CreatedAnnotationResult {
    return {
        client_item_id: item.client_item_id,
        index: item.index,
        loc_raw: item.loc_raw,
        library_id: ref.library_id,
        zotero_key: ref.zotero_key,
        library_ref: libraryRefForLibraryID(ref.library_id) ?? undefined,
    };
}

export function failedRow(item: AnnotationBatchItem, error: unknown): FailedAnnotationResult {
    return {
        client_item_id: item.client_item_id,
        index: item.index,
        loc_raw: item.loc_raw,
        error: (error as Error)?.message ?? String(error),
        error_code: mapAnnotationErrorCode(error),
    };
}

/**
 * Check the deadline before the next item. Once annotations exist, a reached
 * deadline ends the batch instead of failing it: the items from `next` on,
 * not attempted, are recorded as failed with `timeout` and true is returned, so the result still
 * lists what was created and undo can remove it. Before anything is created,
 * the timeout propagates.
 */
export function stopForDeadline(
    ctx: TimeoutContext,
    phase: string,
    items: readonly AnnotationBatchItem[],
    next: number,
    created: CreatedAnnotationResult[],
    failed: FailedAnnotationResult[],
): boolean {
    try {
        checkAborted(ctx, phase);
        return false;
    } catch (error) {
        if (!(error instanceof TimeoutError) || created.length === 0) throw error;
        for (const item of items.slice(next)) {
            failed.push({
                client_item_id: item.client_item_id,
                index: item.index,
                loc_raw: item.loc_raw,
                error: 'Not attempted: the apply ran out of time',
                error_code: 'timeout',
            });
        }
        return true;
    }
}

/** The error for a failure that stops a whole batch before its items run. */
export function annotationBatchError(error: unknown): unknown {
    if (error instanceof TimeoutError || error instanceof ActionExecutionError) return error;
    return actionError(mapAnnotationErrorCode(error), String(error), {
        userMessage: (error as Error)?.message || String(error),
    });
}

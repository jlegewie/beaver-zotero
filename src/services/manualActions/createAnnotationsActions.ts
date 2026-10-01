/**
 * Utilities for executing and undoing bulk annotation agent actions.
 * Used by AgentActionView for post-run manual apply and undo.
 */

import { AgentAction } from '@beaver/agent-core/agents/agentActionTypes';
import { logger } from '@beaver/agent-core/platform/logger';
import {
    CreatedAnnotationResult,
    CreateHighlightAnnotationsProposedData,
    CreateHighlightAnnotationsResultData,
    CreateNoteAnnotationsProposedData,
    CreateNoteAnnotationsResultData,
    FailedAnnotationResult,
} from '@beaver/agent-core/types/agentActions/createAnnotations';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { libraryRefForLibraryID, resolveItemReference, resolveLibraryRef } from '../../utils/libraryIdentity';
import { checkLibraryExcluded, excludedLibraryUserMessage, getAttachmentFileStatus } from '../agentDataProvider/utils';
import {
    createEpubHighlightAnnotation,
    createEpubNoteAnnotation,
    createNoteAnnotation,
    createPdfHighlightForItem,
    EpubAnnotationError,
    HighlightPageSpanError,
    MissingPageGeometryError,
} from '../annotations/createAnnotation';
import { getReadableContentKind } from '../documentExtraction/attachmentResolution';

type AnnotationContentKind = 'pdf' | 'epub';

function mapAnnotationErrorCode(error: unknown): string {
    if (error instanceof MissingPageGeometryError) {
        return error.reason === 'extraction_failed'
            ? 'page_extraction_failed'
            : 'page_geometry_unavailable';
    }
    if (error instanceof EpubAnnotationError || error instanceof HighlightPageSpanError) {
        return error.code;
    }
    return 'apply_failed';
}

type UserFacingError = Error & { userMessage?: string };

/**
 * Reject an annotation write or undo in a library excluded from Beaver.
 *
 * A library can be excluded after the action was proposed or applied, so the
 * boundary is re-checked when the user applies or undoes it.
 */
function assertAnnotationLibraryNotExcluded(
    ref: { library_id?: number | null; library_ref?: string | null },
): void {
    const libraryId = resolveLibraryRef(ref);
    if (libraryId === null) return;
    const exclusion = checkLibraryExcluded(libraryId);
    if (!exclusion) return;
    const error: UserFacingError = new Error(exclusion.message);
    error.userMessage = excludedLibraryUserMessage(libraryId);
    throw error;
}

async function getAnnotationAttachment(
    ref: ZoteroItemReference,
): Promise<{ attachment: Zotero.Item; contentKind: AnnotationContentKind }> {
    assertAnnotationLibraryNotExcluded(ref);
    const resolved = await resolveItemReference(ref);
    if (resolved.status === 'library_unavailable') {
        throw new Error('Attachment library is not available on this computer');
    }
    const attachment = resolved.status === 'found' ? resolved.item : null;
    const kind = attachment ? getReadableContentKind(attachment) : null;
    if (!attachment || (kind !== 'pdf' && kind !== 'epub')) {
        throw new Error('Resolved item is not a PDF or EPUB attachment');
    }
    return { attachment, contentKind: kind };
}

/** A numeric page_label doubles as the 1-based EPUB section ordinal fallback. */
function epubSectionOrdinal(pageLabel: string | null | undefined): number | undefined {
    return pageLabel && /^\d+$/.test(pageLabel) ? Number(pageLabel) : undefined;
}

/**
 * Execute a create_highlight_annotations action from the UI.
 */
export async function executeCreateHighlightAnnotationsAction(
    action: AgentAction,
): Promise<CreateHighlightAnnotationsResultData> {
    const data = action.proposed_data as CreateHighlightAnnotationsProposedData;
    const { requested_ref, resolved_ref, items, tags } = data;
    const { attachment, contentKind } = await getAnnotationAttachment(resolved_ref);

    await getAttachmentFileStatus(attachment, false);

    const created: CreatedAnnotationResult[] = [];
    const failed: FailedAnnotationResult[] = [];

    for (const item of items) {
        if (contentKind === 'epub') {
            try {
                const ref = await createEpubHighlightAnnotation(attachment, {
                    sectionHref: item.section_href ?? undefined,
                    sectionOrdinal: item.section_ordinal ?? epubSectionOrdinal(item.page_label),
                    anchorId: item.anchor_id ?? undefined,
                    text: item.text ?? '',
                    color: item.color,
                    comment: item.comment ?? item.title,
                    pageLabel: item.page_label ?? null,
                    tags,
                });
                created.push({
                    client_item_id: item.client_item_id,
                    index: item.index,
                    loc_raw: item.loc_raw,
                    library_id: ref.library_id,
                    zotero_key: ref.zotero_key,
                    library_ref: libraryRefForLibraryID(ref.library_id) ?? undefined,
                });
            } catch (error: any) {
                failed.push({
                    client_item_id: item.client_item_id,
                    index: item.index,
                    loc_raw: item.loc_raw,
                    error: error?.message ?? String(error),
                    error_code: mapAnnotationErrorCode(error),
                });
            }
            continue;
        }

        if (!item.page_locations?.length) {
            failed.push({
                client_item_id: item.client_item_id,
                index: item.index,
                loc_raw: item.loc_raw,
                error: 'No page locations provided',
                error_code: 'page_geometry_unavailable',
            });
            continue;
        }

        try {
            created.push(await createPdfHighlightForItem(attachment, item, tags));
        } catch (error: any) {
            failed.push({
                client_item_id: item.client_item_id,
                index: item.index,
                loc_raw: item.loc_raw,
                error: error?.message ?? String(error),
                error_code: mapAnnotationErrorCode(error),
            });
        }
    }

    return {
        requested_ref,
        resolved_ref,
        created,
        failed,
        total_created: created.length,
        total_failed: failed.length,
    };
}

/**
 * Execute a create_note_annotations action from the UI.
 */
export async function executeCreateNoteAnnotationsAction(
    action: AgentAction,
): Promise<CreateNoteAnnotationsResultData> {
    const data = action.proposed_data as CreateNoteAnnotationsProposedData;
    const { requested_ref, resolved_ref, items, tags } = data;
    const { attachment, contentKind } = await getAnnotationAttachment(resolved_ref);

    await getAttachmentFileStatus(attachment, false);

    const created: CreatedAnnotationResult[] = [];
    const failed: FailedAnnotationResult[] = [];

    for (const item of items) {
        try {
            let ref;
            if (contentKind === 'epub') {
                ref = await createEpubNoteAnnotation(attachment, {
                    sectionHref: item.section_href ?? undefined,
                    sectionOrdinal: item.section_ordinal ?? epubSectionOrdinal(item.page_label),
                    anchorId: item.anchor_id ?? undefined,
                    text: item.text ?? undefined,
                    comment: item.comment,
                    color: item.color,
                    pageLabel: item.page_label ?? null,
                    tags,
                });
            } else {
                const notePosition = item.note_position;
                if (!notePosition) {
                    failed.push({
                        client_item_id: item.client_item_id,
                        index: item.index,
                        loc_raw: item.loc_raw,
                        error: 'No note position provided',
                        error_code: 'page_geometry_unavailable',
                    });
                    continue;
                }
                ref = await createNoteAnnotation(attachment, {
                    notePosition,
                    comment: item.comment,
                    color: item.color,
                    pageLabel: item.page_label ?? null,
                    readingOrderOffset: item.reading_order_offset ?? null,
                    tags,
                });
            }
            created.push({
                client_item_id: item.client_item_id,
                index: item.index,
                loc_raw: item.loc_raw,
                library_id: ref.library_id,
                zotero_key: ref.zotero_key,
                library_ref: libraryRefForLibraryID(ref.library_id) ?? undefined,
            });
        } catch (error: any) {
            failed.push({
                client_item_id: item.client_item_id,
                index: item.index,
                loc_raw: item.loc_raw,
                error: error?.message ?? String(error),
                error_code: mapAnnotationErrorCode(error),
            });
        }
    }

    return {
        requested_ref,
        resolved_ref,
        created,
        failed,
        total_created: created.length,
        total_failed: failed.length,
    };
}

/**
 * Undo a bulk annotation action by deleting every created annotation.
 */
export async function undoCreateAnnotationsAction(action: AgentAction): Promise<void> {
    const created = action.result_data?.created;
    if (!Array.isArray(created) || created.length === 0) {
        logger(`undoCreateAnnotationsAction: No created annotations for action ${action.id}`, 1);
        return;
    }

    for (const ref of created) assertAnnotationLibraryNotExcluded(ref);
    for (const ref of created) {
        const resolved = await resolveItemReference(ref);
        if (resolved.status === 'library_unavailable') {
            logger(`undoCreateAnnotationsAction: Library unavailable for ${ref.library_ref || ref.library_id}-${ref.zotero_key}`, 1);
            continue;
        }
        if (resolved.status === 'found') {
            await resolved.item.eraseTx();
        }
    }
}

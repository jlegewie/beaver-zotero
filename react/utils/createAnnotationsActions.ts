/**
 * Utilities for executing and undoing bulk annotation agent actions.
 * Used by AgentActionView for post-run manual apply and undo.
 */

import { AgentAction } from '../agents/agentActions';
import {
    CreatedAnnotationResult,
    CreateHighlightAnnotationsProposedData,
    CreateHighlightAnnotationsResultData,
    CreateNoteAnnotationsProposedData,
    CreateNoteAnnotationsResultData,
    FailedAnnotationResult,
} from '../types/agentActions/createAnnotations';
import {
    EpubAnnotationError,
    MissingPageGeometryError,
    createEpubHighlightAnnotation,
    createEpubNoteAnnotation,
    createHighlightAnnotation,
    createNoteAnnotation,
} from '../../src/services/annotations/createAnnotation';
import { getReadableContentKind } from '../../src/services/documentExtraction/attachmentResolution';
import { getAttachmentFileStatus } from '../../src/services/agentDataProvider/utils';
import { logger } from '../../src/utils/logger';

type AnnotationContentKind = 'pdf' | 'epub';

function mapAnnotationErrorCode(error: unknown): string {
    if (error instanceof MissingPageGeometryError) {
        return error.reason === 'extraction_failed'
            ? 'page_extraction_failed'
            : 'page_geometry_unavailable';
    }
    if (error instanceof EpubAnnotationError) {
        return error.code;
    }
    return 'apply_failed';
}

async function getAnnotationAttachment(
    libraryId: number,
    zoteroKey: string,
): Promise<{ attachment: Zotero.Item; contentKind: AnnotationContentKind }> {
    const attachment = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, zoteroKey);
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
    const { attachment, contentKind } = await getAnnotationAttachment(
        resolved_ref.library_id,
        resolved_ref.zotero_key,
    );

    await getAttachmentFileStatus(attachment, false);

    const created: CreatedAnnotationResult[] = [];
    const failed: FailedAnnotationResult[] = [];

    for (const item of items) {
        if (contentKind === 'epub') {
            try {
                const ref = await createEpubHighlightAnnotation(attachment, {
                    sectionHref: item.section_href ?? undefined,
                    sectionOrdinal: epubSectionOrdinal(item.page_label),
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

        // The item-level label is only a valid fallback for single-page
        // highlights; for a multi-page item it is the first page's label, so
        // reusing it would mislabel later pages. Per-page labels come from
        // each loc.page_label (or the cache) instead.
        const itemPageLabelFallback = item.page_locations.length === 1
            ? (item.page_label ?? null)
            : null;

        for (const loc of item.page_locations) {
            try {
                const ref = await createHighlightAnnotation(attachment, {
                    pageIndex: loc.page_idx,
                    boxes: loc.boxes ?? [],
                    text: item.text ?? '',
                    color: item.color,
                    comment: item.comment ?? item.title,
                    pageLabel: loc.page_label ?? itemPageLabelFallback,
                    readingOrderOffset: loc.reading_order_offset ?? null,
                    tags,
                });
                created.push({
                    client_item_id: item.client_item_id,
                    index: item.index,
                    loc_raw: item.loc_raw,
                    library_id: ref.library_id,
                    zotero_key: ref.zotero_key,
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
    const { attachment, contentKind } = await getAnnotationAttachment(
        resolved_ref.library_id,
        resolved_ref.zotero_key,
    );

    await getAttachmentFileStatus(attachment, false);

    const created: CreatedAnnotationResult[] = [];
    const failed: FailedAnnotationResult[] = [];

    for (const item of items) {
        try {
            let ref;
            if (contentKind === 'epub') {
                ref = await createEpubNoteAnnotation(attachment, {
                    sectionHref: item.section_href ?? undefined,
                    sectionOrdinal: epubSectionOrdinal(item.page_label),
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

    for (const ref of created) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(ref.library_id, ref.zotero_key);
        if (item) {
            await item.eraseTx();
        }
    }
}

import { logger } from '@beaver/agent-core/platform/logger';
import {
    WSAgentActionExecuteResponse,
    WSAgentActionValidateResponse
} from '@beaver/agent-core/protocol/agentProtocol';
import { normalizeNotePosition } from '@beaver/agent-core/types/agentActions/annotations';
import type {
    CreatedAnnotationResult,
    CreateNoteAnnotationsProposedData,
    CreateNoteAnnotationsResultData,
    FailedAnnotationResult,
    NoteAnnotationItem,
} from '@beaver/agent-core/types/agentActions/createAnnotations';
import { normalizeAnnotationTags } from '@beaver/agent-core/types/agentActions/createAnnotations';
import { hasLibraryIdentity, resolveLibraryRef } from '../../../utils/libraryIdentity';
import { shortItemTitle } from '../../../utils/zoteroUtils';
import { getParentItemAsync } from '../../../utils/zoteroDataLoading';
import {
    createEpubNoteAnnotation,
    createNoteAnnotation,
    createSnapshotNoteAnnotation,
    prepareSnapshotAnnotationDocument,
} from '../../annotations/createAnnotation';
import { canUseReaderContentType } from '../../attachmentContentType';
import type { ActionExecuteRequest, ActionValidateRequest } from '../operationContext';
import { checkAborted, TimeoutContext } from '../timeout';
import { checkLibraryExcluded, getAttachmentFileStatus, getDeferredToolPreference, validateLibraryAccess } from '../utils';
import { toExecuteResponse } from './actionExecution';
import {
    annotationBatchError,
    createdRow,
    epubSectionOrdinal,
    failedRow,
    getAnnotationContentKind,
    normalizeRef,
    resolveAnnotationAttachment,
    resolveAnnotationTarget,
    stopForDeadline,
} from './annotationBatch';

function getActionData(request: ActionValidateRequest): CreateNoteAnnotationsProposedData {
    return normalizeActionData(request.action_data ?? {});
}

/** Read stored or requested action data into its normalized shape. */
function normalizeActionData(raw: Record<string, any>): CreateNoteAnnotationsProposedData {
    return {
        requested_ref: normalizeRef(raw.requested_ref ?? raw.requestedRef ?? {}),
        resolved_ref: normalizeRef(raw.resolved_ref ?? raw.resolvedRef ?? {}),
        items: Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [],
        tags: normalizeAnnotationTags(raw.tags),
    } as CreateNoteAnnotationsProposedData;
}

function normalizeItem(raw: any): NoteAnnotationItem {
    const rawReadingOrder = raw?.reading_order_offset ?? raw?.readingOrderOffset;
    const readingOrderOffset =
        typeof rawReadingOrder === 'number' && Number.isFinite(rawReadingOrder)
            ? rawReadingOrder
            : (rawReadingOrder === null ? null : undefined);
    return {
        index: typeof raw?.index === 'number' ? raw.index : Number(raw?.index ?? 0),
        client_item_id: String(raw?.client_item_id ?? raw?.clientItemId ?? ''),
        title: String(raw?.title ?? ''),
        loc_raw: String(raw?.loc_raw ?? raw?.locRaw ?? raw?.loc?.raw ?? ''),
        loc: raw?.loc ?? { kind: 'unknown', value: '', raw: '' },
        comment: String(raw?.comment ?? ''),
        color: raw?.color ?? 'yellow',
        note_position: normalizeNotePosition({ note_position: raw?.note_position ?? raw?.notePosition }) ?? {
            page_index: 0,
            side: 'right',
            x: 0,
            y: 0,
        },
        page_label: raw?.page_label ?? raw?.pageLabel ?? null,
        text: raw?.text != null ? String(raw.text) : undefined,
        section_href: raw?.section_href ?? raw?.sectionHref ?? null,
        section_ordinal: raw?.section_ordinal ?? raw?.sectionOrdinal ?? null,
        anchor_id: raw?.anchor_id ?? raw?.anchorId ?? null,
        ...(readingOrderOffset !== undefined ? { reading_order_offset: readingOrderOffset } : {}),
    };
}

async function getAttachmentTitle(attachment: Zotero.Item): Promise<string> {
    try {
        const parent = await getParentItemAsync(attachment);
        if (parent) {
            await parent.loadDataType('itemData');
            return await shortItemTitle(parent);
        }
        await attachment.loadDataType('itemData');
        return attachment.getDisplayTitle() || attachment.key;
    } catch (error) {
        logger(`getAttachmentTitle: failed to load title for ${attachment.libraryID}-${attachment.key}: ${error}`, 1);
        return attachment.key;
    }
}

/**
 * Validate a create_note_annotations action before deferred execution.
 */
export async function validateCreateNoteAnnotationsAction(
    request: ActionValidateRequest,
): Promise<WSAgentActionValidateResponse> {
    const data = getActionData(request);
    const { requested_ref, resolved_ref, items } = data;

    if (!hasLibraryIdentity(resolved_ref) || !resolved_ref.zotero_key) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'resolved_ref is required',
            error_code: 'missing_resolved_ref',
            preference: 'always_ask',
        };
    }
    if (!items.length) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'At least one annotation item is required',
            error_code: 'no_items',
            preference: 'always_ask',
        };
    }

    // Enforce the exclusion boundary before resolving/loading the attachment.
    // library_ref is authoritative when the numeric library_id is stale.
    const targetLibraryId = resolveLibraryRef(resolved_ref);
    const excluded = targetLibraryId === null ? null : checkLibraryExcluded(targetLibraryId);
    if (excluded) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: excluded.message,
            error_code: 'library_not_searchable',
            preference: 'always_ask',
        };
    }
    // A portable ref this device cannot map is a missing library, not a bad
    // attachment: say so instead of letting the lookup below fail as
    // "not a local PDF or EPUB attachment".
    if (targetLibraryId === null) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `The library (${resolved_ref.library_ref}) holding this attachment is not available on this computer.`,
            error_code: 'library_unavailable',
            preference: 'always_ask',
        };
    }

    const attachment = await resolveAnnotationAttachment(resolved_ref);
    const contentKind = attachment ? getAnnotationContentKind(attachment) : null;
    if (!attachment || !contentKind) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'Resolved item is not a local PDF or EPUB attachment',
            error_code: 'invalid_attachment',
            preference: 'always_ask',
        };
    }
    const libValidation = validateLibraryAccess(attachment.libraryID);
    if (!libValidation.valid) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: libValidation.error,
            error_code: libValidation.error_code,
            preference: 'always_ask',
        };
    }
    const library = libValidation.library!;
    if (!library.editable) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library '${library.name}' is read-only and cannot be modified`,
            error_code: 'library_not_editable',
            preference: 'always_ask',
        };
    }

    const filePath = await attachment.getFilePathAsync();
    if (!filePath) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'Attachment file is not available locally',
            error_code: 'attachment_file_unavailable',
            preference: 'always_ask',
        };
    }
    // Zotero only annotates attachments with a canonical content type; a
    // mislabelled PDF/EPUB is corrected at execution once its file confirms it.
    if (!await canUseReaderContentType(attachment)) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Zotero cannot annotate this attachment: it is stored as '${attachment.attachmentContentType || 'unknown'}' and its file could not be confirmed as a PDF or EPUB.`,
            error_code: 'invalid_attachment',
            preference: 'always_ask',
        };
    }

    // EPUB annotations parse the section on demand (no document-cache geometry),
    // so extraction is never a prerequisite. PDFs need cached page geometry.
    let needsExtraction = false;
    if (contentKind === 'pdf') {
        needsExtraction = true;
        try {
            const cached = await Zotero.Beaver?.documentCache?.getMetadata(
                { libraryId: attachment.libraryID, zoteroKey: attachment.key },
                filePath,
            );
            needsExtraction = !cached || !cached.pages || cached.pages.length === 0;
        } catch (error) {
            logger(`validateCreateNoteAnnotationsAction: cache probe failed: ${error}`, 1);
        }
    }

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            content_kind: contentKind,
            library_name: library.name,
            attachment_title: await getAttachmentTitle(attachment),
            item_count: items.length,
            resolution_differs: requested_ref.zotero_key !== resolved_ref.zotero_key,
            needs_extraction: needsExtraction,
        },
        normalized_action_data: data as unknown as Record<string, any>,
        preference: getDeferredToolPreference('create_note_annotations', undefined, request.operation),
    };
}

/**
 * Create the note annotations of a create_note_annotations action and return
 * its `result_data`.
 *
 * Each item succeeds or fails on its own; failures are listed in `failed`.
 * A deadline reached between items stops the batch: the items not attempted
 * are listed as failed with `timeout`, so the annotations already created stay
 * on record for undo. With nothing created yet, the timeout propagates.
 */
export async function applyCreateNoteAnnotations(
    rawData: Record<string, any>,
    ctx: TimeoutContext,
): Promise<CreateNoteAnnotationsResultData> {
    const data = normalizeActionData(rawData);
    const { requested_ref, resolved_ref, items, tags } = data;
    const { attachment, contentKind } = await resolveAnnotationTarget(resolved_ref);

    let snapshotDoc: Awaited<ReturnType<typeof prepareSnapshotAnnotationDocument>> | undefined;
    try {
        await getAttachmentFileStatus(attachment, false);
        checkAborted(ctx, 'create_note_annotations:after_extract');
        // Snapshots: parse the HTML once for the whole batch so each item resolves
        // against the shared Document instead of re-reading + re-parsing the file.
        snapshotDoc = contentKind === 'snapshot'
            ? await prepareSnapshotAnnotationDocument(attachment)
            : undefined;
    } catch (error) {
        throw annotationBatchError(error);
    }

    const created: CreatedAnnotationResult[] = [];
    const failed: FailedAnnotationResult[] = [];

    for (const [position, item] of items.entries()) {
        if (stopForDeadline(ctx, `create_note_annotations:item_${item.index}`, items, position, created, failed)) break;
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
            } else if (contentKind === 'snapshot') {
                ref = await createSnapshotNoteAnnotation(attachment, {
                    anchorId: item.anchor_id ?? undefined,
                    text: item.text ?? undefined,
                    comment: item.comment,
                    color: item.color,
                    tags,
                }, snapshotDoc);
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
            created.push(createdRow(item, ref));
        } catch (error) {
            failed.push(failedRow(item, error));
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

/** Create a note annotation batch for the backend during a run. */
export async function executeCreateNoteAnnotationsAction(
    request: ActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    return toExecuteResponse(request.request_id, 'executeCreateNoteAnnotationsAction',
        () => applyCreateNoteAnnotations(request.action_data ?? {}, ctx));
}

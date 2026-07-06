import {
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
} from '../../agentProtocol';
import {
    EpubAnnotationError,
    MissingPageGeometryError,
    SnapshotAnnotationError,
    createEpubNoteAnnotation,
    createNoteAnnotation,
    createSnapshotNoteAnnotation,
    prepareSnapshotAnnotationDocument,
} from '../../annotations/createAnnotation';
import { getReadableContentKind } from '../../documentExtraction/attachmentResolution';
import { checkLibraryExcluded, getAttachmentFileStatus, getDeferredToolPreference, validateLibraryAccess } from '../utils';
import { TimeoutContext, checkAborted, TimeoutError } from '../timeout';
import type {
    CreatedAnnotationResult,
    CreateNoteAnnotationsProposedData,
    FailedAnnotationResult,
    NoteAnnotationItem,
} from '../../../../react/types/agentActions/createAnnotations';
import type { ZoteroItemReference } from '../../../../react/types/zotero';
import { normalizeNotePosition } from '../../../../react/types/agentActions/annotations';
import { normalizeAnnotationTags } from '../../../../react/types/agentActions/createAnnotations';
import { shortItemTitle } from '../../../utils/zoteroUtils';
import { libraryRefForLibraryID, resolveItemReference } from '../../../utils/libraryIdentity';
import { logger } from '../../../utils/logger';

function mapAnnotationErrorCode(error: unknown): string {
    if (error instanceof MissingPageGeometryError) {
        return error.reason === 'extraction_failed'
            ? 'page_extraction_failed'
            : 'page_geometry_unavailable';
    }
    if (error instanceof EpubAnnotationError || error instanceof SnapshotAnnotationError) {
        return error.code;
    }
    return 'apply_failed';
}

/** PDF, EPUB, and snapshots are the supported annotation targets; else rejected. */
function getAnnotationContentKind(attachment: Zotero.Item): 'pdf' | 'epub' | 'snapshot' | null {
    const kind = getReadableContentKind(attachment);
    return kind === 'pdf' || kind === 'epub' || kind === 'snapshot' ? kind : null;
}

/** A numeric page_label doubles as the 1-based EPUB section ordinal fallback. */
function epubSectionOrdinal(pageLabel: string | null | undefined): number | undefined {
    return pageLabel && /^\d+$/.test(pageLabel) ? Number(pageLabel) : undefined;
}

function normalizeRef(raw: any): ZoteroItemReference {
    const libraryRef = raw?.library_ref ?? raw?.libraryRef;
    return {
        library_id: typeof raw?.library_id === 'number' ? raw.library_id : Number(raw?.libraryId ?? raw?.library_id ?? 0),
        zotero_key: String(raw?.zotero_key ?? raw?.zoteroKey ?? ''),
        // Carry the device-portable library_ref through unchanged when present.
        ...(typeof libraryRef === 'string' && libraryRef ? { library_ref: libraryRef } : {}),
    };
}

function getActionData(request: WSAgentActionValidateRequest | WSAgentActionExecuteRequest): CreateNoteAnnotationsProposedData {
    const raw = request.action_data ?? {};
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

async function resolveAttachment(ref: ZoteroItemReference): Promise<Zotero.Item | null> {
    if (!ref.library_id || !ref.zotero_key) return null;
    const resolved = await resolveItemReference(ref);
    return resolved.status === 'found' ? resolved.item : null;
}

async function getAttachmentTitle(attachment: Zotero.Item): Promise<string> {
    try {
        const parent = attachment.parentItem;
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
    request: WSAgentActionValidateRequest,
): Promise<WSAgentActionValidateResponse> {
    const data = getActionData(request);
    const { requested_ref, resolved_ref, items } = data;

    if (!resolved_ref.library_id || !resolved_ref.zotero_key) {
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

    const attachment = await resolveAttachment(resolved_ref);
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
            library_name: library.name,
            attachment_title: await getAttachmentTitle(attachment),
            item_count: items.length,
            resolution_differs: requested_ref.zotero_key !== resolved_ref.zotero_key,
            needs_extraction: needsExtraction,
        },
        normalized_action_data: data as unknown as Record<string, any>,
        preference: getDeferredToolPreference('create_note_annotations'),
    };
}

/**
 * Execute a create_note_annotations action headlessly.
 */
export async function executeCreateNoteAnnotationsAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const data = getActionData(request);
    const { requested_ref, resolved_ref, items, tags } = data;

    // TOCTOU guard: never annotate an attachment in a library the user excluded
    // from Beaver, even if validation passed earlier or the request skipped it.
    const attachment = await resolveAttachment(resolved_ref);
    const contentKind = attachment ? getAnnotationContentKind(attachment) : null;
    if (!attachment || !contentKind) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'Resolved item is not a local PDF or EPUB attachment',
            error_code: 'invalid_attachment',
        };
    }
    const excluded = checkLibraryExcluded(attachment.libraryID);
    if (excluded) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: excluded.message,
            error_code: 'library_not_searchable',
        };
    }

    try {
        await getAttachmentFileStatus(attachment, false);
        checkAborted(ctx, 'create_note_annotations:after_extract');

        const created: CreatedAnnotationResult[] = [];
        const failed: FailedAnnotationResult[] = [];

        // Snapshots: parse the HTML once for the whole batch so each item resolves
        // against the shared Document instead of re-reading + re-parsing the file.
        const snapshotDoc = contentKind === 'snapshot'
            ? await prepareSnapshotAnnotationDocument(attachment)
            : undefined;

        for (const item of items) {
            checkAborted(ctx, `create_note_annotations:item_${item.index}`);
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
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: {
                requested_ref,
                resolved_ref,
                created,
                failed,
                total_created: created.length,
                total_failed: failed.length,
            },
        };
    } catch (error) {
        if (error instanceof TimeoutError) throw error;
        logger(`executeCreateNoteAnnotationsAction: Failed: ${error}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: String(error),
            error_code: mapAnnotationErrorCode(error),
        };
    }
}

import { logger } from '@beaver/agent-core/platform/logger';
import {
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
    WSAgentActionValidateResponse
} from '@beaver/agent-core/protocol/agentProtocol';
import { normalizePageLocations } from '@beaver/agent-core/types/agentActions/annotations';
import type {
    CreatedAnnotationResult,
    CreateHighlightAnnotationsProposedData,
    FailedAnnotationResult,
    HighlightAnnotationItem,
} from '@beaver/agent-core/types/agentActions/createAnnotations';
import { normalizeAnnotationTags } from '@beaver/agent-core/types/agentActions/createAnnotations';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { hasLibraryIdentity, libraryRefForLibraryID, resolveItemReference, resolveLibraryRef } from '../../../utils/libraryIdentity';
import { shortItemTitle } from '../../../utils/zoteroUtils';
import {
    createEpubHighlightAnnotation,
    createPdfHighlightForItem,
    createSnapshotHighlightAnnotation,
    EpubAnnotationError,
    HighlightPageSpanError,
    highlightPageSpan,
    MissingPageGeometryError,
    prepareSnapshotAnnotationDocument,
    SnapshotAnnotationError,
} from '../../annotations/createAnnotation';
import { getReadableContentKind } from '../../documentExtraction/attachmentResolution';
import { canUseReaderContentType } from '../../attachmentContentType';
import type { ActionExecuteRequest, ActionValidateRequest } from '../operationContext';
import { checkAborted, TimeoutContext, TimeoutError } from '../timeout';
import { checkLibraryExcluded, getAttachmentFileStatus, getDeferredToolPreference, validateLibraryAccess } from '../utils';

function mapAnnotationErrorCode(error: unknown): string {
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

function getActionData(request: ActionValidateRequest | WSAgentActionExecuteRequest): CreateHighlightAnnotationsProposedData {
    const raw = request.action_data ?? {};
    return {
        requested_ref: normalizeRef(raw.requested_ref ?? raw.requestedRef ?? {}),
        resolved_ref: normalizeRef(raw.resolved_ref ?? raw.resolvedRef ?? {}),
        items: Array.isArray(raw.items) ? raw.items.map(normalizeItem) : [],
        tags: normalizeAnnotationTags(raw.tags),
    } as CreateHighlightAnnotationsProposedData;
}

function normalizeItem(raw: any): HighlightAnnotationItem {
    return {
        index: typeof raw?.index === 'number' ? raw.index : Number(raw?.index ?? 0),
        client_item_id: String(raw?.client_item_id ?? raw?.clientItemId ?? ''),
        title: String(raw?.title ?? ''),
        loc_raw: String(raw?.loc_raw ?? raw?.locRaw ?? raw?.loc?.raw ?? ''),
        loc: raw?.loc ?? { kind: 'unknown', value: '', raw: '' },
        text: String(raw?.text ?? ''),
        color: raw?.color ?? 'yellow',
        comment: raw?.comment ?? null,
        page_locations: normalizePageLocations({ locations: raw?.page_locations ?? raw?.pageLocations ?? raw?.locations }) ?? [],
        page_label: raw?.page_label ?? raw?.pageLabel ?? null,
        section_href: raw?.section_href ?? raw?.sectionHref ?? null,
        section_ordinal: raw?.section_ordinal ?? raw?.sectionOrdinal ?? null,
        anchor_id: raw?.anchor_id ?? raw?.anchorId ?? null,
    };
}

async function resolveAttachment(ref: ZoteroItemReference): Promise<Zotero.Item | null> {
    // A portable `library_ref` is a complete target on its own, so the numeric
    // `library_id` may legitimately be the unresolved sentinel.
    if (!hasLibraryIdentity(ref) || !ref.zotero_key) return null;
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
 * Validate a create_highlight_annotations action before deferred execution.
 */
export async function validateCreateHighlightAnnotationsAction(
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

    // One requested highlight is one Zotero annotation, which covers at most
    // two consecutive pages. Reject here so the approval card never shows a
    // highlight that cannot be created.
    if (contentKind === 'pdf') {
        for (const item of items) {
            if (!item.page_locations?.length) continue;
            try {
                highlightPageSpan(item.page_locations);
            } catch (error) {
                if (!(error instanceof HighlightPageSpanError)) throw error;
                return {
                    type: 'agent_action_validate_response',
                    request_id: request.request_id,
                    valid: false,
                    error: `Highlight ${item.index}: ${error.message}`,
                    error_code: error.code,
                    preference: 'always_ask',
                };
            }
        }
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
            logger(`validateCreateHighlightAnnotationsAction: cache probe failed: ${error}`, 1);
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
        preference: getDeferredToolPreference('create_highlight_annotations', undefined, request.operation),
    };
}

/**
 * Execute a create_highlight_annotations action headlessly.
 */
export async function executeCreateHighlightAnnotationsAction(
    request: ActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const data = getActionData(request);
    const { requested_ref, resolved_ref, items, tags } = data;

    // TOCTOU guard: never annotate an attachment in a library the user excluded
    // from Beaver, even if validation passed earlier or the request skipped it.
    // Resolve and gate the library before resolving/loading the attachment.
    const targetLibraryId = resolveLibraryRef(resolved_ref);
    const targetExcluded = targetLibraryId === null ? null : checkLibraryExcluded(targetLibraryId);
    if (targetExcluded) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: targetExcluded.message,
            error_code: 'library_not_searchable',
        };
    }
    if (targetLibraryId === null) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: `The library (${resolved_ref.library_ref}) holding this attachment is not available on this computer.`,
            error_code: 'library_unavailable',
        };
    }
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
        checkAborted(ctx, 'create_highlight_annotations:after_extract');

        const created: CreatedAnnotationResult[] = [];
        const failed: FailedAnnotationResult[] = [];

        // Snapshots: parse the HTML once for the whole batch so each item resolves
        // against the shared Document instead of re-reading + re-parsing the file.
        const snapshotDoc = contentKind === 'snapshot'
            ? await prepareSnapshotAnnotationDocument(attachment)
            : undefined;

        for (const item of items) {
            checkAborted(ctx, `create_highlight_annotations:item_${item.index}`);

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

            if (contentKind === 'snapshot') {
                try {
                    const ref = await createSnapshotHighlightAnnotation(attachment, {
                        anchorId: item.anchor_id ?? undefined,
                        text: item.text ?? '',
                        color: item.color,
                        comment: item.comment ?? item.title,
                        tags,
                    }, snapshotDoc);
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
        logger(`executeCreateHighlightAnnotationsAction: Failed: ${error}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: String(error),
            error_code: mapAnnotationErrorCode(error),
        };
    }
}

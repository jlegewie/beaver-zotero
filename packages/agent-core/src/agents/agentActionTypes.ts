import { ZoteroItemReference } from '../types/zotero';
import {
    ActionStatus,
    ActionType,
    NoteProposedData,
    EditMetadataProposedData,
} from '../types/agentActions/base';
import {
    normalizePageLocations,
    normalizeSentenceIdList,
    normalizeNotePosition,
} from '../types/agentActions/annotations';
import type { CreateItemProposedData, CreateItemResultData } from '../types/agentActions/items';
import type { ManageCollectionsProposedData, ManageCollectionsResultData } from '../types/agentActions/base';
import type {
    CreatedAnnotationResult,
    CreateHighlightAnnotationsProposedData,
    CreateHighlightAnnotationsResultData,
    CreateNoteAnnotationsProposedData,
    CreateNoteAnnotationsResultData,
    FailedAnnotationResult,
    HighlightAnnotationItem,
    NoteAnnotationItem,
} from '../types/agentActions/createAnnotations';
import { normalizeAnnotationTags } from '../types/agentActions/createAnnotations';
import type {
    AnnotationPlacementSnapshot,
    AnnotationPreviewSnapshot,
    AnnotationRelocation,
    EditAnnotationsProposedData,
    EditAnnotationsResultData,
} from '../types/agentActions/editAnnotations';

// =============================================================================
// Agent Action Types
// =============================================================================

/**
 * Agent action model
 * Created during agent runs via WebSocket streaming.
 */
export interface AgentAction {
    // Identity
    id: string;
    run_id: string;
    toolcall_id?: string;
    user_id?: string;

    // Action type
    action_type: ActionType;

    // Status
    status: ActionStatus;
    error_message?: string;
    error_details?: Record<string, any>;

    // Action-specific proposed data and result data
    proposed_data: Record<string, any>; // Will be cast to specific types based on action_type
    result_data?: Record<string, any>; // Populated after application

    // Timestamps
    created_at?: string;
    updated_at?: string;
}

/**
 * Type guard for highlight annotation actions
 */
export const isHighlightAnnotationAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'highlight_annotation';
};

/**
 * Type guard for note annotation actions
 */
export const isNoteAnnotationAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'note_annotation';
};

/**
 * Type guard for any annotation action
 */
export const isAnnotationAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'highlight_annotation' || action.action_type === 'note_annotation';
};

export const isCreateHighlightAnnotationsAgentAction = (action: AgentAction): action is CreateHighlightAnnotationsAgentAction => {
    return action.action_type === 'create_highlight_annotations';
};

export const isCreateNoteAnnotationsAgentAction = (action: AgentAction): action is CreateNoteAnnotationsAgentAction => {
    return action.action_type === 'create_note_annotations';
};

export const isCreateAnnotationsAgentAction = (action: AgentAction): action is CreateHighlightAnnotationsAgentAction | CreateNoteAnnotationsAgentAction => {
    return isCreateHighlightAnnotationsAgentAction(action) || isCreateNoteAnnotationsAgentAction(action);
};

export const isEditAnnotationsAgentAction = (action: AgentAction): action is EditAnnotationsAgentAction =>
    action.action_type === 'edit_annotations';

/**
 * Type guard for zotero note actions
 */
export const isZoteroNoteAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'zotero_note';
};

/**
 * Type guard for create note actions (via create_note tool)
 */
export const isCreateNoteAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'create_note';
};

/**
 * Type guard for create item actions
 */
export const isCreateItemAgentAction = (action: AgentAction): action is CreateItemAgentAction => {
    return action.action_type === 'create_item';
};

/**
 * Type guard for edit metadata actions
 */
export const isEditMetadataAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'edit_metadata';
};

/**
 * Type guard for create collection actions
 */
export const isCreateCollectionAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'create_collection';
};

/**
 * Type guard for organize items actions
 */
export const isOrganizeItemsAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'organize_items';
};

/**
 * Type guard for manage tags actions
 */
export const isManageTagsAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'manage_tags';
};

/**
 * Type guard for manage collections actions
 */
export const isManageCollectionsAgentAction = (action: AgentAction): action is ManageCollectionsAgentAction => {
    return action.action_type === 'manage_collections';
};

/**
 * Type guard for edit note actions
 */
export const isEditNoteAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'edit_note';
};

/**
 * Type guard for batch edit note actions
 */
export const isEditNoteBatchAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'edit_note_batch';
};

/** edit_note OR edit_note_batch — any note-edit action against a single note. */
export const isAnyEditNoteAgentAction = (action: AgentAction): boolean =>
    isEditNoteAgentAction(action) || isEditNoteBatchAgentAction(action);

/**
 * Type guard for confirm extraction actions
 */
export const isConfirmExtractionAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'confirm_extraction';
};

/**
 * Type guard for confirm external search actions
 */
export const isConfirmExternalSearchAgentAction = (action: AgentAction): boolean => {
    return action.action_type === 'confirm_external_search';
};

/**
 * Typed agent action for create_item actions
 */
export type CreateItemAgentAction = AgentAction & {
    action_type: 'create_item';
    proposed_data: CreateItemProposedData;
    result_data?: CreateItemResultData;
};

/**
 * Typed agent action for manage_collections actions
 */
export type ManageCollectionsAgentAction = AgentAction & {
    action_type: 'manage_collections';
    proposed_data: ManageCollectionsProposedData;
    result_data?: ManageCollectionsResultData;
};

export type CreateHighlightAnnotationsAgentAction = AgentAction & {
    action_type: 'create_highlight_annotations';
    proposed_data: CreateHighlightAnnotationsProposedData;
    result_data?: CreateHighlightAnnotationsResultData;
};

export type CreateNoteAnnotationsAgentAction = AgentAction & {
    action_type: 'create_note_annotations';
    proposed_data: CreateNoteAnnotationsProposedData;
    result_data?: CreateNoteAnnotationsResultData;
};

export type EditAnnotationsAgentAction = AgentAction & {
    action_type: 'edit_annotations';
    proposed_data: EditAnnotationsProposedData;
    result_data?: EditAnnotationsResultData;
};

/**
 * Check if an agent action has been applied and has a Zotero item reference
 */
export const hasAppliedZoteroItem = (action: AgentAction): boolean => {
    return action.status === 'applied' &&
           !!action.result_data?.zotero_key &&
           !!action.result_data?.library_id;
};

export const hasAppliedBulkAnnotations = (action: AgentAction): boolean => {
    return isCreateAnnotationsAgentAction(action) &&
        action.status === 'applied' &&
        Array.isArray(action.result_data?.created) &&
        action.result_data.created.length > 0;
};

/**
 * Get Zotero item reference from an applied agent action
 */
export const getZoteroItemReferenceFromAgentAction = (action: AgentAction): ZoteroItemReference | null => {
    if (!hasAppliedZoteroItem(action)) {
        return null;
    }
    return {
        library_id: action.result_data!.library_id,
        zotero_key: action.result_data!.zotero_key,
        library_ref: action.result_data!.library_ref,
    } as ZoteroItemReference;
};

// =============================================================================
// Deserialization
// =============================================================================

function normalizeZoteroItemReference(raw: any): ZoteroItemReference {
    const libraryId = raw?.library_id ?? raw?.libraryId;
    const zoteroKey = raw?.zotero_key ?? raw?.zoteroKey;
    // Carry the device-portable library_ref through unchanged when the
    // backend sent one
    const libraryRef = raw?.library_ref ?? raw?.libraryRef;
    return {
        library_id: typeof libraryId === 'number' ? libraryId : Number(libraryId ?? 0),
        zotero_key: typeof zoteroKey === 'string' ? zoteroKey : String(zoteroKey ?? ''),
        ...(typeof libraryRef === 'string' && libraryRef ? { library_ref: libraryRef } : {}),
    };
}

/** Pre-change display state of the annotations an edit_annotations action targets. */
function normalizeAnnotationPreviews(raw: any): AnnotationPreviewSnapshot[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((row: any) => ({
        ...normalizeZoteroItemReference(row ?? {}),
        annotation_id: String(row?.annotation_id ?? row?.annotationId ?? ''),
        ...(typeof row?.annotation_type === 'string' && row.annotation_type
            ? { annotation_type: row.annotation_type }
            : {}),
        color: typeof row?.color === 'string' ? row.color : '',
        comment: typeof row?.comment === 'string' ? row.comment : '',
        tags: normalizeAnnotationTags(row?.tags) ?? [],
        ...(typeof row?.page_label === 'string' ? { page_label: row.page_label } : {}),
        ...(typeof row?.text === 'string' ? { text: row.text } : {}),
    }));
}

function normalizeCreateAnnotationBaseItem(item: any) {
    return {
        index: typeof item?.index === 'number' ? item.index : Number(item?.index ?? 0),
        client_item_id: String(item?.client_item_id ?? item?.clientItemId ?? ''),
        title: String(item?.title ?? ''),
        loc_raw: String(item?.loc_raw ?? item?.locRaw ?? ''),
        loc: item?.loc ?? { kind: 'unknown', value: '', raw: '' },
        page_label: item?.page_label ?? item?.pageLabel ?? null,
        section_href: item?.section_href ?? item?.sectionHref ?? null,
        section_ordinal: item?.section_ordinal ?? item?.sectionOrdinal ?? null,
        anchor_id: item?.anchor_id ?? item?.anchorId ?? null,
    };
}

function normalizeHighlightAnnotationItem(item: any): HighlightAnnotationItem {
    return {
        ...normalizeCreateAnnotationBaseItem(item),
        text: String(item?.text ?? ''),
        color: item?.color ?? 'yellow',
        comment: item?.comment ?? null,
        page_locations: normalizePageLocations({ locations: item?.page_locations ?? item?.pageLocations ?? item?.locations }) ?? [],
    };
}

function normalizeNoteAnnotationItem(item: any): NoteAnnotationItem {
    const rawReadingOrder = item?.reading_order_offset ?? item?.readingOrderOffset;
    const readingOrderOffset =
        typeof rawReadingOrder === 'number' && Number.isFinite(rawReadingOrder)
            ? rawReadingOrder
            : (rawReadingOrder === null ? null : undefined);
    return {
        ...normalizeCreateAnnotationBaseItem(item),
        comment: String(item?.comment ?? ''),
        color: item?.color ?? 'yellow',
        note_position: normalizeNotePosition({ note_position: item?.note_position ?? item?.notePosition }) ?? {
            page_index: 0,
            side: 'right',
            x: 0,
            y: 0,
        },
        text: item?.text != null ? String(item.text) : undefined,
        ...(readingOrderOffset !== undefined ? { reading_order_offset: readingOrderOffset } : {}),
    };
}

function normalizeCreatedAnnotation(item: any): CreatedAnnotationResult {
    // Rows of a page-spanning highlight share client_item_id, loc_raw and title,
    // so the page is the only thing that tells them apart. Carry it through, and
    // leave both fields absent for rows that predate them rather than inventing
    // a page 0.
    const rawPageIdx = item?.page_idx ?? item?.pageIdx;
    const pageIdx = typeof rawPageIdx === 'number' && Number.isFinite(rawPageIdx)
        ? rawPageIdx
        : undefined;
    const rawPageLabel = item?.page_label ?? item?.pageLabel;
    const pageLabel = typeof rawPageLabel === 'string' ? rawPageLabel : undefined;

    return {
        ...normalizeZoteroItemReference(item),
        client_item_id: String(item?.client_item_id ?? item?.clientItemId ?? ''),
        index: typeof item?.index === 'number' ? item.index : Number(item?.index ?? 0),
        loc_raw: String(item?.loc_raw ?? item?.locRaw ?? ''),
        ...(pageIdx !== undefined ? { page_idx: pageIdx } : {}),
        ...(pageLabel !== undefined ? { page_label: pageLabel } : {}),
    };
}

function normalizeFailedAnnotation(item: any): FailedAnnotationResult {
    return {
        client_item_id: String(item?.client_item_id ?? item?.clientItemId ?? ''),
        index: typeof item?.index === 'number' ? item.index : Number(item?.index ?? 0),
        loc_raw: String(item?.loc_raw ?? item?.locRaw ?? ''),
        error: String(item?.error ?? ''),
        error_code: item?.error_code ?? item?.errorCode ?? null,
    };
}

function normalizeCreateAnnotationsResultData(raw: any): Record<string, any> {
    const created = Array.isArray(raw?.created) ? raw.created.map(normalizeCreatedAnnotation) : [];
    const failed = Array.isArray(raw?.failed) ? raw.failed.map(normalizeFailedAnnotation) : [];
    return {
        requested_ref: normalizeZoteroItemReference(raw?.requested_ref ?? raw?.requestedRef ?? {}),
        resolved_ref: normalizeZoteroItemReference(raw?.resolved_ref ?? raw?.resolvedRef ?? {}),
        created,
        failed,
        total_created: typeof raw?.total_created === 'number' ? raw.total_created : Number(raw?.totalCreated ?? created.length),
        total_failed: typeof raw?.total_failed === 'number' ? raw.total_failed : Number(raw?.totalFailed ?? failed.length),
    };
}

function normalizeRelocation(raw: any): AnnotationRelocation | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const pageLocations = normalizePageLocations({
        locations: raw.page_locations ?? raw.pageLocations,
    });
    const notePosition = normalizeNotePosition({
        note_position: raw.note_position ?? raw.notePosition,
    });
    const attachment = raw.attachment_ref ?? raw.attachmentRef;
    if (!attachment) return undefined;
    return {
        loc_raw: String(raw.loc_raw ?? raw.locRaw ?? ''),
        content_kind: raw.content_kind ?? raw.contentKind,
        attachment_ref: normalizeZoteroItemReference(attachment),
        ...(pageLocations ? { page_locations: pageLocations } : {}),
        ...(notePosition ? { note_position: notePosition } : {}),
        ...(raw.text !== undefined ? { text: raw.text } : {}),
        ...(raw.page_label !== undefined || raw.pageLabel !== undefined
            ? { page_label: raw.page_label ?? raw.pageLabel }
            : {}),
        ...(raw.reading_order_offset !== undefined || raw.readingOrderOffset !== undefined
            ? { reading_order_offset: raw.reading_order_offset ?? raw.readingOrderOffset }
            : {}),
        ...(raw.section_href !== undefined || raw.sectionHref !== undefined
            ? { section_href: raw.section_href ?? raw.sectionHref }
            : {}),
        ...(raw.section_ordinal !== undefined || raw.sectionOrdinal !== undefined
            ? { section_ordinal: raw.section_ordinal ?? raw.sectionOrdinal }
            : {}),
        ...(raw.anchor_id !== undefined || raw.anchorId !== undefined
            ? { anchor_id: raw.anchor_id ?? raw.anchorId }
            : {}),
    } as AnnotationRelocation;
}

function normalizePlacementSnapshot(raw: any): AnnotationPlacementSnapshot | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const position = raw.position;
    if (typeof position !== 'string') return undefined;
    return {
        position,
        ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
        ...(raw.page_label !== undefined || raw.pageLabel !== undefined
            ? { page_label: String(raw.page_label ?? raw.pageLabel ?? '') }
            : {}),
        ...(raw.sort_index !== undefined || raw.sortIndex !== undefined
            ? { sort_index: String(raw.sort_index ?? raw.sortIndex ?? '') }
            : {}),
    };
}

/**
 * Deserializes and normalizes a raw agent action object from the backend
 * into a typed AgentAction object.
 */
export function toAgentAction(raw: Record<string, any>): AgentAction {
    const actionType = (raw.action_type ?? raw.actionType) as ActionType;

    // Normalize proposed_data based on action type
    let proposedData: Record<string, any> = raw.proposed_data ?? raw.proposedData ?? {};

    if (actionType === 'highlight_annotation' || actionType === 'note_annotation') {
        const libraryIdRaw = proposedData.library_id ?? proposedData.libraryId;
        const attachmentKeyRaw = proposedData.attachment_key ?? proposedData.attachmentKey;
        const libraryRef = proposedData.library_ref ?? proposedData.libraryRef;
        const sentenceIds = normalizeSentenceIdList(proposedData.sentence_ids ?? proposedData.sentenceIds);

        const normalizedData: any = {
            title: proposedData.title ?? '',
            comment: proposedData.comment ?? '',
            library_id: typeof libraryIdRaw === 'number' ? libraryIdRaw : Number(libraryIdRaw ?? 0),
            ...(typeof libraryRef === 'string' && libraryRef ? { library_ref: libraryRef } : {}),
            attachment_key: typeof attachmentKeyRaw === 'string' ? attachmentKeyRaw : String(attachmentKeyRaw ?? ''),
            raw_sentence_ids: proposedData.raw_sentence_ids ?? proposedData.rawSentenceIds ?? null,
            sentence_ids: sentenceIds,
        };

        if (actionType === 'highlight_annotation') {
            normalizedData.text = proposedData.text ?? '';
            normalizedData.color = proposedData.color ?? proposedData.highlight_color ?? null;
            normalizedData.highlight_locations = normalizePageLocations(proposedData);
        } else if (actionType === 'note_annotation') {
            normalizedData.note_position = normalizeNotePosition(proposedData);
        }

        proposedData = normalizedData;
    } else if (actionType === 'create_highlight_annotations') {
        proposedData = {
            requested_ref: normalizeZoteroItemReference(proposedData.requested_ref ?? proposedData.requestedRef ?? {}),
            resolved_ref: normalizeZoteroItemReference(proposedData.resolved_ref ?? proposedData.resolvedRef ?? {}),
            items: Array.isArray(proposedData.items)
                ? proposedData.items.map(normalizeHighlightAnnotationItem)
                : [],
            tags: normalizeAnnotationTags(proposedData.tags),
        } as CreateHighlightAnnotationsProposedData;
    } else if (actionType === 'create_note_annotations') {
        proposedData = {
            requested_ref: normalizeZoteroItemReference(proposedData.requested_ref ?? proposedData.requestedRef ?? {}),
            resolved_ref: normalizeZoteroItemReference(proposedData.resolved_ref ?? proposedData.resolvedRef ?? {}),
            items: Array.isArray(proposedData.items)
                ? proposedData.items.map(normalizeNoteAnnotationItem)
                : [],
            tags: normalizeAnnotationTags(proposedData.tags),
        } as CreateNoteAnnotationsProposedData;
    } else if (actionType === 'edit_annotations') {
        const skipped = Array.isArray(proposedData.skipped)
            ? proposedData.skipped.map((row: any) => ({
                annotation_id: String(row?.annotation_id ?? row?.annotationId ?? ''),
                reason: String(row?.reason ?? ''),
            }))
            : [];
        // The card renders its annotations from these, and they are the only
        // copy left once the action resolves and its result data is cleared.
        // This normalizer rebuilds proposed_data field by field, so anything
        // not carried here is dropped before the card ever sees it.
        const previews = normalizeAnnotationPreviews(
            proposedData.annotation_previews ?? proposedData.annotationPreviews,
        );
        const carried = {
            skipped,
            ...(previews.length ? { annotation_previews: previews } : {}),
        };
        if (proposedData.operation === 'delete') {
            proposedData = {
                operation: 'delete',
                annotation_refs: Array.isArray(proposedData.annotation_refs ?? proposedData.annotationRefs)
                    ? (proposedData.annotation_refs ?? proposedData.annotationRefs).map(normalizeZoteroItemReference)
                    : [],
                ...carried,
            } as EditAnnotationsProposedData;
        } else {
            proposedData = {
                operation: 'edit',
                edits: (Array.isArray(proposedData.edits) ? proposedData.edits : []).map((group: any) => {
                    const changes = group?.changes ?? {};
                    const patch = {
                        ...(changes.color !== undefined ? { color: changes.color } : {}),
                        ...(changes.comment !== undefined ? { comment: changes.comment } : {}),
                        ...(changes.add_tags !== undefined ? { add_tags: normalizeAnnotationTags(changes.add_tags) } : {}),
                        ...(changes.remove_tags !== undefined ? { remove_tags: normalizeAnnotationTags(changes.remove_tags) } : {}),
                    };
                    const relocation = normalizeRelocation(group?.relocation);
                    return {
                        annotation_refs: Array.isArray(group?.annotation_refs)
                            ? group.annotation_refs.map(normalizeZoteroItemReference)
                            : [],
                        ...(Object.keys(patch).length ? { changes: patch } : {}),
                        ...(relocation ? { relocation } : {}),
                    };
                }),
                ...carried,
            } as EditAnnotationsProposedData;
        }
    } else if (actionType === 'zotero_note') {
        const libraryIdRaw = proposedData.library_id ?? proposedData.libraryId;
        const zoteroKeyRaw = proposedData.zotero_key ?? proposedData.zoteroKey;
        const rawTag = proposedData.raw_tag ?? proposedData.rawTag;

        let normalizedLibraryId: number | undefined;
        if (libraryIdRaw !== undefined && libraryIdRaw !== null) {
            const parsed = typeof libraryIdRaw === 'number' ? libraryIdRaw : Number(libraryIdRaw);
            normalizedLibraryId = Number.isNaN(parsed) ? undefined : parsed;
        }

        proposedData = {
            title: proposedData.title ?? '',
            content: typeof proposedData.content === 'string' || proposedData.content === null
                ? proposedData.content
                : (proposedData.content ?? null),
            library_id: normalizedLibraryId,
            zotero_key: typeof zoteroKeyRaw === 'string'
                ? zoteroKeyRaw
                : (zoteroKeyRaw !== undefined && zoteroKeyRaw !== null ? String(zoteroKeyRaw) : undefined),
            library_ref: typeof proposedData.library_ref === 'string'
                ? proposedData.library_ref
                : (typeof proposedData.libraryRef === 'string' ? proposedData.libraryRef : undefined),
            library: typeof proposedData.library === 'string' ? proposedData.library : undefined,
            collection: typeof proposedData.collection === 'string' ? proposedData.collection : undefined,
            raw_tag: typeof rawTag === 'string' ? rawTag : undefined,
        } as NoteProposedData;
    } else if (actionType === 'create_item') {
        const libraryIdRaw = proposedData.library_id ?? proposedData.libraryId;
        const parsedLibraryId = libraryIdRaw == null || libraryIdRaw === ''
            ? undefined
            : (typeof libraryIdRaw === 'number' ? libraryIdRaw : Number(libraryIdRaw));

        proposedData = {
            library_id: parsedLibraryId,
            library_ref: proposedData.library_ref ?? proposedData.libraryRef,
            library_name: proposedData.library_name ?? proposedData.libraryName,
            item: proposedData.item ?? {},
            reason: proposedData.reason,
            relevance_score: proposedData.relevance_score ?? proposedData.relevanceScore,
            file_available: proposedData.file_available ?? proposedData.fileAvailable ?? false,
            downloaded_url: proposedData.downloaded_url ?? proposedData.downloadedUrl,
            storage_path: proposedData.storage_path ?? proposedData.storagePath,
            text_path: proposedData.text_path ?? proposedData.textPath,
            collection_keys: proposedData.collection_keys ?? proposedData.collectionKeys,
            suggested_tags: proposedData.suggested_tags ?? proposedData.suggestedTags,
        } as CreateItemProposedData;
    } else if (actionType === 'edit_metadata') {
        // Normalize edit_metadata proposed data
        const edits = Array.isArray(proposedData.edits) ? proposedData.edits : [];
        const creators = Array.isArray(proposedData.creators)
            ? proposedData.creators
            : (proposedData.creators && typeof proposedData.creators === 'object')
                ? [proposedData.creators]  // wrap single creator object in array (common LLM output error)
                : null;
        const oldCreators = Array.isArray(proposedData.old_creators)
            ? proposedData.old_creators
            : null;
        proposedData = {
            library_id: typeof proposedData.library_id === 'number'
                ? proposedData.library_id
                : Number(proposedData.library_id ?? proposedData.libraryId ?? 0),
            zotero_key: proposedData.zotero_key ?? proposedData.zoteroKey ?? '',
            library_ref: proposedData.library_ref ?? proposedData.libraryRef,
            edits: edits.map((edit: any) => ({
                field: edit.field ?? '',
                old_value: edit.old_value ?? edit.oldValue ?? null,
                new_value: edit.new_value ?? edit.newValue ?? null,
            })),
            creators,
            old_creators: oldCreators,
        } as EditMetadataProposedData;
    } else if (actionType === 'create_collection') {
        // Normalize create_collection proposed data. library_id always names a
        // resolved library: the agent may target a library by name, but the name
        // is resolved to an id during validation, before the action is emitted.
        proposedData = {
            library_id: typeof proposedData.library_id === 'number'
                ? proposedData.library_id
                : Number(proposedData.library_id ?? proposedData.libraryId ?? 0),
            library_ref: proposedData.library_ref ?? proposedData.libraryRef,
            name: proposedData.name ?? '',
            parent_key: proposedData.parent_key ?? proposedData.parentKey ?? null,
            item_ids: proposedData.item_ids ?? proposedData.itemIds ?? [],
        };
    } else if (actionType === 'organize_items') {
        // Normalize organize_items proposed data
        proposedData = {
            item_ids: proposedData.item_ids ?? proposedData.itemIds ?? [],
            tags: proposedData.tags ?? null,
            collections: proposedData.collections ?? null,
            current_state: proposedData.current_state ?? proposedData.currentState ?? null,
        };
    } else if (actionType === 'confirm_extraction') {
        // Normalize confirm_extraction proposed data
        proposedData = {
            attachment_count: proposedData.attachment_count ?? proposedData.attachmentCount ?? 0,
            extra_credits: proposedData.extra_credits ?? proposedData.extraCredits ?? 0,
            total_credits: proposedData.total_credits ?? proposedData.totalCredits ?? 0,
            included_free: proposedData.included_free ?? proposedData.includedFree ?? 0,
            attachment_ids: proposedData.attachment_ids ?? proposedData.attachmentIds ?? [],
            label: proposedData.label ?? null,
        };
    } else if (actionType === 'confirm_external_search') {
        // Normalize confirm_external_search proposed data
        proposedData = {
            extra_credits: proposedData.extra_credits ?? proposedData.extraCredits ?? 0,
            total_credits: proposedData.total_credits ?? proposedData.totalCredits ?? 0,
            label: proposedData.label ?? null,
        };
    }

    // Normalize result_data if present
    let resultData: Record<string, any> | undefined = raw.result_data ?? raw.resultData;
    if (resultData && (actionType === 'highlight_annotation' || actionType === 'note_annotation')) {
        const zoteroKey = resultData.zotero_key ?? resultData.zoteroKey;
        const libraryId = resultData.library_id ?? resultData.libraryId;
        const libraryRef = resultData.library_ref ?? resultData.libraryRef;
        const attachmentKey = resultData.attachment_key ?? resultData.attachmentKey;

        if (zoteroKey) {
            resultData = {
                zotero_key: zoteroKey,
                library_id: typeof libraryId === 'number' ? libraryId : Number(libraryId ?? 0),
                ...(typeof libraryRef === 'string' && libraryRef ? { library_ref: libraryRef } : {}),
                attachment_key: typeof attachmentKey === 'string' ? attachmentKey : String(attachmentKey ?? ''),
            };
        }
    } else if (resultData && (actionType === 'create_highlight_annotations' || actionType === 'create_note_annotations')) {
        resultData = normalizeCreateAnnotationsResultData(resultData);
    } else if (resultData && actionType === 'edit_annotations') {
        const appliedRefs = Array.isArray(resultData.applied_refs ?? resultData.appliedRefs)
            ? (resultData.applied_refs ?? resultData.appliedRefs).map(normalizeZoteroItemReference)
            : [];
        const before = Array.isArray(resultData.before) ? resultData.before.map((snapshot: any) => {
            const movedTo = normalizePlacementSnapshot(snapshot.moved_to ?? snapshot.movedTo);
            // Undo reads `tags` unconditionally and restores the automatic ones
            // by name, so an untagged annotation must keep an empty array and
            // `automatic_tags` has to survive the round trip through history.
            const automaticTags = normalizeAnnotationTags(snapshot.automatic_tags ?? snapshot.automaticTags);
            return {
                annotation_id: String(snapshot.annotation_id ?? snapshot.annotationId ?? ''),
                ...normalizeZoteroItemReference(snapshot),
                color: String(snapshot.color ?? ''),
                comment: String(snapshot.comment ?? ''),
                tags: normalizeAnnotationTags(snapshot.tags) ?? [],
                ...(automaticTags ? { automatic_tags: automaticTags } : {}),
                ...(typeof snapshot.deleted === 'boolean' ? { deleted: snapshot.deleted } : {}),
                ...(snapshot.annotation_type !== undefined || snapshot.annotationType !== undefined
                    ? { annotation_type: String(snapshot.annotation_type ?? snapshot.annotationType ?? '') }
                    : {}),
                ...(typeof snapshot.text === 'string' ? { text: snapshot.text } : {}),
                ...(snapshot.page_label !== undefined || snapshot.pageLabel !== undefined
                    ? { page_label: String(snapshot.page_label ?? snapshot.pageLabel ?? '') }
                    : {}),
                ...(snapshot.sort_index !== undefined || snapshot.sortIndex !== undefined
                    ? { sort_index: String(snapshot.sort_index ?? snapshot.sortIndex ?? '') }
                    : {}),
                ...(typeof snapshot.position === 'string' ? { position: snapshot.position } : {}),
                ...(movedTo ? { moved_to: movedTo } : {}),
            };
        }) : [];
        const relocated = Array.isArray(resultData.relocated) ? resultData.relocated.map((mapping: any) => ({
            old_ref: normalizeZoteroItemReference(mapping.old_ref ?? mapping.oldRef ?? {}),
            new_ref: normalizeZoteroItemReference(mapping.new_ref ?? mapping.newRef ?? {}),
        })) : undefined;
        resultData = {
            operation: resultData.operation === 'delete' ? 'delete' : 'edit',
            applied_refs: appliedRefs,
            before,
            ...(relocated?.length ? { relocated } : {}),
        } as EditAnnotationsResultData;
    } else if (resultData && actionType === 'zotero_note') {
        const zoteroKey = resultData.zotero_key ?? resultData.zoteroKey;
        const libraryId = resultData.library_id ?? resultData.libraryId;
        const libraryRef = resultData.library_ref ?? resultData.libraryRef;
        const parentKey = resultData.parent_key ?? resultData.parentKey;
        if (zoteroKey) {
            resultData = {
                zotero_key: String(zoteroKey),
                library_id: typeof libraryId === 'number' ? libraryId : Number(libraryId ?? 0),
                ...(typeof libraryRef === 'string' && libraryRef ? { library_ref: libraryRef } : {}),
                ...(parentKey ? { parent_key: String(parentKey) } : {})
            };
        }
    } else if (resultData && actionType === 'create_item') {
        const zoteroKey = resultData.zotero_key ?? resultData.zoteroKey ?? resultData.item_key ?? resultData.itemKey;
        const libraryId = resultData.library_id ?? resultData.libraryId;
        const libraryRef = resultData.library_ref ?? resultData.libraryRef;

        if (zoteroKey) {
            resultData = {
                zotero_key: String(zoteroKey),
                library_id: typeof libraryId === 'number' ? libraryId : Number(libraryId ?? 0),
                ...(typeof libraryRef === 'string' && libraryRef ? { library_ref: libraryRef } : {}),
                attachment_status: resultData.attachment_status ?? resultData.attachmentStatus ?? 'none',
                attachment_key: resultData.attachment_key ?? resultData.attachmentKey,
                attachment_resolved_at: resultData.attachment_resolved_at ?? resultData.attachmentResolvedAt,
            };
        }
    }

    return {
        id: raw.id,
        run_id: raw.run_id ?? raw.runId,
        toolcall_id: raw.toolcall_id ?? raw.toolcallId,
        user_id: raw.user_id ?? raw.userId,
        action_type: actionType,
        status: raw.status ?? 'pending',
        error_message: raw.error_message ?? raw.errorMessage,
        proposed_data: proposedData,
        error_details: raw.error_details ?? raw.validationErrors,
        result_data: resultData,
        created_at: raw.created_at ?? raw.createdAt,
        updated_at: raw.updated_at ?? raw.updatedAt,
    };
}

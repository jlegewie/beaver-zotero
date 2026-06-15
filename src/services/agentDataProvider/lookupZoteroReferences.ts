/**
 * Shared helper for looking up Zotero item/attachment/note data by reference.
 *
 * Extracted from handleZoteroDataRequest so it can be reused by other callers
 * (e.g., citation resolution during create_note).
 */

import { logger } from '../../utils/logger';
import { ItemDataWithStatus, AttachmentDataWithStatus, ZoteroItemReference } from '../../../react/types/zotero';
import { searchableLibraryIdsAtom, syncWithZoteroAtom } from '../../../react/atoms/profile';
import { userIdAtom } from '../../../react/atoms/auth';
import { store } from '../../../react/store';
import {
    formatZoteroCreatorsString,
    getCreatorsFromItem,
    getYearFromItem,
    serializeAttachment,
    serializeAnnotation,
    serializeItem,
    serializeNote,
} from '../../utils/zoteroSerializers';
import { computeItemStatus, prefetchSyncDates, getAttachmentFileStatus, getAttachmentFileStatusLightweight, getBestAttachmentBatch, buildItemStub } from './utils';
import {
    WSDataError,
    AnnotationResultItem,
    NoteResultItem,
    FileStatusLevel,
} from '../agentProtocol';


export interface LookupZoteroReferencesOptions {
    include_attachments: boolean;
    include_parents: boolean;
    /**
     * When true and a referenced item is a regular item, include its child
     * notes in the response. Defaults to true when omitted.
     */
    include_notes?: boolean;
    file_status_level?: FileStatusLevel;  // default: 'lightweight'
}

export interface LookupZoteroReferencesResult {
    items: ItemDataWithStatus[];
    attachments: AttachmentDataWithStatus[];
    notes: NoteResultItem[];
    annotations: AnnotationResultItem[];
    errors: WSDataError[];
}

/**
 * Look up Zotero item/attachment/note data for a list of references.
 *
 * Given references (library_id + zotero_key pairs), loads items from Zotero,
 * categorizes them, discovers parents/attachments, serializes, and computes
 * sync status.
 *
 * @param references List of Zotero item references to look up
 * @param options Controls parent/attachment inclusion and file status level
 * @returns Serialized items, attachments, notes, and any errors
 */
export async function lookupZoteroReferences(
    references: ZoteroItemReference[],
    options: LookupZoteroReferencesOptions,
): Promise<LookupZoteroReferencesResult> {
    const errors: WSDataError[] = [];

    // Get sync configuration from store
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    const syncWithZotero = store.get(syncWithZoteroAtom);
    const userId = store.get(userIdAtom);

    // Track keys to avoid duplicates when including parents/attachments
    const itemKeys = new Set<string>();
    const attachmentKeys = new Set<string>();
    const noteKeys = new Set<string>();
    const annotationKeys = new Set<string>();

    // Collect Zotero items to serialize
    const itemsToSerialize: Zotero.Item[] = [];
    const attachmentsToSerialize: Zotero.Item[] = [];
    const notesToSerialize: Zotero.Item[] = [];
    const annotationsToSerialize: Zotero.Item[] = [];

    const makeKey = (libraryId: number, zoteroKey: string) => `${libraryId}-${zoteroKey}`;

    // Phase 1: Collect primary items from references IN PARALLEL
    const primaryItems: Zotero.Item[] = [];
    const referenceToItem = new Map<string, Zotero.Item>();

    const loadResults = await Promise.all(
        references.map(async (reference) => {
            try {
                const zoteroItem = await Zotero.Items.getByLibraryAndKeyAsync(reference.library_id, reference.zotero_key);
                if (!zoteroItem) {
                    return { reference, error: 'Item not found in local database', error_code: 'not_found' as const };
                }
                return { reference, item: zoteroItem };
            } catch (error: any) {
                logger(`lookupZoteroReferences: Failed to load zotero item ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
                const details = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
                return { reference, error: 'Failed to load item', error_code: 'load_failed' as const, details };
            }
        })
    );

    // Process results, preserving order
    for (const result of loadResults) {
        if ('item' in result && result.item) {
            primaryItems.push(result.item);
            referenceToItem.set(makeKey(result.reference.library_id, result.reference.zotero_key), result.item);
        } else if ('error' in result) {
            errors.push({
                reference: result.reference,
                error: result.error,
                error_code: result.error_code,
                details: result.details
            });
        }
    }

    // Phase 2: Load data types for primary items BEFORE accessing parentID/getAttachments
    if (primaryItems.length > 0) {
        await Zotero.Items.loadDataTypes(primaryItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);
    }

    // Phase 3: Collect all parent/attachment/note IDs first, then batch load
    const parentIdsToLoad = new Set<number>();
    const attachmentIdsToLoad = new Set<number>();
    const noteIdsToLoad = new Set<number>();
    const includeChildNotes = options.include_notes !== false;

    // First pass: collect IDs and categorize items
    for (const reference of references) {
        const zoteroItem = referenceToItem.get(makeKey(reference.library_id, reference.zotero_key));
        if (!zoteroItem) continue;

        try {
            if (zoteroItem.isAttachment()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!attachmentKeys.has(key)) {
                    attachmentKeys.add(key);
                    attachmentsToSerialize.push(zoteroItem);
                }
                // Collect parent ID for batch loading
                if (options.include_parents && zoteroItem.parentID) {
                    parentIdsToLoad.add(zoteroItem.parentID);
                }
            } else if (zoteroItem.isRegularItem()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!itemKeys.has(key)) {
                    itemKeys.add(key);
                    itemsToSerialize.push(zoteroItem);
                }
                // Collect attachment IDs for batch loading
                if (options.include_attachments) {
                    const attachmentIds = zoteroItem.getAttachments();
                    for (const attachmentId of attachmentIds) {
                        attachmentIdsToLoad.add(attachmentId);
                    }
                }
                // Collect child note IDs for batch loading so the agent can
                // discover sibling notes attached to the same item without a
                // separate search.
                if (includeChildNotes) {
                    const noteIds = zoteroItem.getNotes();
                    for (const noteId of noteIds) {
                        noteIdsToLoad.add(noteId);
                    }
                }
            } else if (zoteroItem.isNote()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!noteKeys.has(key)) {
                    noteKeys.add(key);
                    notesToSerialize.push(zoteroItem);
                }
                // Collect parent ID for batch loading
                if (options.include_parents && zoteroItem.parentID) {
                    parentIdsToLoad.add(zoteroItem.parentID);
                }
            } else if (zoteroItem.isAnnotation()) {
                const key = makeKey(zoteroItem.libraryID, zoteroItem.key);
                if (!annotationKeys.has(key)) {
                    annotationKeys.add(key);
                    annotationsToSerialize.push(zoteroItem);
                }
                // Annotations live two levels deep: regular item -> attachment ->
                // annotation. Collect the parent attachment for serialization
                // and rely on Phase 4 to load the grandparent regular item.
                if (options.include_parents && zoteroItem.parentID) {
                    attachmentIdsToLoad.add(zoteroItem.parentID);
                }
            } else {
                errors.push({
                    reference,
                    error: 'Item is not a regular item, attachment, note, or annotation',
                    error_code: 'filtered_from_sync'
                });
            }
        } catch (error: any) {
            logger(`lookupZoteroReferences: Failed to categorize zotero item ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            const details = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
            errors.push({
                reference,
                error: 'Failed to load item/attachment',
                error_code: 'load_failed',
                details
            });
        }
    }

    // Batch load parents, attachments, and child notes in parallel
    const [parentItemsArray, attachmentItemsArray, noteItemsArray] = await Promise.all([
        parentIdsToLoad.size > 0 ? Zotero.Items.getAsync([...parentIdsToLoad]) : Promise.resolve([]),
        attachmentIdsToLoad.size > 0 ? Zotero.Items.getAsync([...attachmentIdsToLoad]) : Promise.resolve([]),
        noteIdsToLoad.size > 0 ? Zotero.Items.getAsync([...noteIdsToLoad]) : Promise.resolve([])
    ]);

    // Create lookup maps. Index primary items too so child notes discovered
    // for a referenced regular item can resolve `note.parentID` → the
    // referenced item without an additional load.
    const parentItemsById = new Map<number, Zotero.Item>();
    for (const item of primaryItems) {
        if (item) parentItemsById.set(item.id, item);
    }
    for (const item of parentItemsArray) {
        if (item) parentItemsById.set(item.id, item);
    }

    const attachmentItemsById = new Map<number, Zotero.Item>();
    for (const item of attachmentItemsArray) {
        if (item) attachmentItemsById.set(item.id, item);
    }

    const noteItemsById = new Map<number, Zotero.Item>();
    for (const item of noteItemsArray) {
        if (item) noteItemsById.set(item.id, item);
    }

    // Second pass: add parents, attachments, and child notes using the pre-loaded items
    for (const reference of references) {
        const zoteroItem = referenceToItem.get(makeKey(reference.library_id, reference.zotero_key));
        if (!zoteroItem) continue;

        try {
            if (zoteroItem.isAttachment()) {
                // Add parent item if requested (using pre-loaded data)
                if (options.include_parents && zoteroItem.parentID) {
                    const parentItem = parentItemsById.get(zoteroItem.parentID);
                    if (parentItem && !parentItem.isAttachment()) {
                        const parentKey = makeKey(parentItem.libraryID, parentItem.key);
                        if (!itemKeys.has(parentKey)) {
                            itemKeys.add(parentKey);
                            itemsToSerialize.push(parentItem);
                        }
                    }
                }
            } else if (zoteroItem.isRegularItem()) {
                // Add attachments if requested (using pre-loaded data)
                if (options.include_attachments) {
                    const attachmentIds = zoteroItem.getAttachments();
                    for (const attachmentId of attachmentIds) {
                        const attachment = attachmentItemsById.get(attachmentId);
                        if (attachment) {
                            const attKey = makeKey(attachment.libraryID, attachment.key);
                            if (!attachmentKeys.has(attKey)) {
                                attachmentKeys.add(attKey);
                                attachmentsToSerialize.push(attachment);
                            }
                        }
                    }
                }
                // Add child notes when requested. Each note will be serialized
                // with parent_item_id pointing back to this regular item.
                if (includeChildNotes) {
                    const noteIds = zoteroItem.getNotes();
                    for (const noteId of noteIds) {
                        const note = noteItemsById.get(noteId);
                        if (note) {
                            const noteKey = makeKey(note.libraryID, note.key);
                            if (!noteKeys.has(noteKey)) {
                                noteKeys.add(noteKey);
                                notesToSerialize.push(note);
                            }
                        }
                    }
                }
            } else if (zoteroItem.isAnnotation()) {
                // Add parent attachment and grandparent regular item when
                // requested, so consumers can render an annotation citation
                // against the bibliographic parent.
                if (options.include_parents && zoteroItem.parentID) {
                    const parentAttachment = attachmentItemsById.get(zoteroItem.parentID);
                    if (parentAttachment) {
                        const attKey = makeKey(parentAttachment.libraryID, parentAttachment.key);
                        if (!attachmentKeys.has(attKey)) {
                            attachmentKeys.add(attKey);
                            attachmentsToSerialize.push(parentAttachment);
                        }
                    }
                }
            }
        } catch (error: any) {
            logger(`lookupZoteroReferences: Failed to expand zotero data ${reference.library_id}-${reference.zotero_key}: ${error}`, 1);
            const details = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
            errors.push({
                reference,
                error: 'Failed to load item/attachment',
                error_code: 'load_failed',
                details
            });
        }
    }

    // Phase 4: Load data for all items (including newly discovered parents and children)
    const allItems = [...itemsToSerialize, ...attachmentsToSerialize, ...notesToSerialize, ...annotationsToSerialize];
    if (allItems.length > 0) {
        // Load all item data in bulk
        await Zotero.Items.loadDataTypes(allItems, ["primaryData", "creators", "itemData", "childItems", "tags", "collections", "relations"]);

        // Load parent items for attachments (needed for isInTrash() to check parent trash status)
        const parentIds = [...new Set(
            allItems
                .filter(item => item.parentID)
                .map(item => item.parentID as number)
        )];
        if (parentIds.length > 0) {
            const parentItems = await Zotero.Items.getAsync(parentIds);
            if (parentItems.length > 0) {
                await Zotero.Items.loadDataTypes(parentItems, ["primaryData"]);
                // Index parent attachments for annotations and capture
                // grandparents so annotations can render bibliographic context.
                for (const parentItem of parentItems) {
                    if (parentItem.isAttachment?.() && !attachmentItemsById.has(parentItem.id)) {
                        attachmentItemsById.set(parentItem.id, parentItem);
                    }
                }
                const grandparentIds = [...new Set(
                    parentItems
                        .filter(p => p.isAttachment?.() && p.parentID)
                        .map(p => p.parentID as number)
                )];
                if (grandparentIds.length > 0) {
                    const grandparentItems = await Zotero.Items.getAsync(grandparentIds);
                    if (grandparentItems.length > 0) {
                        await Zotero.Items.loadDataTypes(grandparentItems, ["primaryData", "itemData", "creators"]);
                        for (const grandparent of grandparentItems) {
                            parentItemsById.set(grandparent.id, grandparent);
                        }
                    }
                }
            }
        }
    }

    // Phase 5: Determine file status level and pre-compute primary attachments if needed
    const fileStatusLevel = options.file_status_level ?? 'lightweight';

    // Pre-compute primary attachments per parent (single batch SQL query)
    // Skip when file_status_level is 'none' since isPrimary is only used for file status
    let bestAttachmentMap = new Map<number, number>();
    if (fileStatusLevel !== 'none') {
        const parentIdsForPrimaryCheck = [...new Set(
            attachmentsToSerialize
                .filter(att => att.parentID)
                .map(att => att.parentID as number)
        )];
        if (parentIdsForPrimaryCheck.length > 0) {
            bestAttachmentMap = await getBestAttachmentBatch(parentIdsForPrimaryCheck);
        }
    }

    // Pre-fetch sync dates for all libraries (1 query per unique library instead of per item)
    const allLibraryIds = [...new Set([
        ...itemsToSerialize.map(item => item.libraryID),
        ...attachmentsToSerialize.map(att => att.libraryID)
    ])];
    const syncDateCache = await prefetchSyncDates(allLibraryIds, syncWithZotero, userId);

    const [itemResults, attachmentResults] = await Promise.all([
        Promise.all(itemsToSerialize.map(async (item): Promise<ItemDataWithStatus | null> => {
            try {
                const serialized = await serializeItem(item, undefined, { skipHash: true });
                const status = await computeItemStatus(item, searchableLibraryIds, syncWithZotero, userId, { syncDateCache });
                return { item: serialized, status };
            } catch (error: any) {
                logger(`lookupZoteroReferences: Failed to serialize item ${item.libraryID}/${item.key}: ${error}`, 1);
                errors.push({
                    reference: { library_id: item.libraryID, zotero_key: item.key },
                    error: 'Failed to serialize item',
                    error_code: 'load_failed',
                    details: error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error),
                });
                return null;
            }
        })),
        Promise.all(attachmentsToSerialize.map(async (attachment): Promise<AttachmentDataWithStatus | null> => {
            try {
                const serialized = await serializeAttachment(attachment, undefined, {
                    skipFileHash: true,
                    skipSyncingFilter: true,
                    skipHash: true,
                    includeAnnotationsCount: true,
                });
                if (!serialized) {
                    errors.push({
                        reference: { library_id: attachment.libraryID, zotero_key: attachment.key },
                        error: 'Attachment not available locally',
                        error_code: 'not_available',
                    });
                    return null;
                }
                // Determine if this is the primary attachment for its parent (using batch data)
                let isPrimary = false;
                if (attachment.parentID) {
                    const bestAttachmentId = bestAttachmentMap.get(attachment.parentID);
                    isPrimary = bestAttachmentId !== undefined && attachment.id === bestAttachmentId;
                }

                let fileStatus = undefined;
                if (fileStatusLevel === 'lightweight') {
                    fileStatus = await getAttachmentFileStatusLightweight(attachment, isPrimary);
                } else if (fileStatusLevel === 'full') {
                    fileStatus = await getAttachmentFileStatus(attachment, isPrimary);
                }

                const status = await computeItemStatus(
                    attachment,
                    searchableLibraryIds,
                    syncWithZotero,
                    userId,
                    { syncDateCache },
                );

                return { attachment: serialized, status, file_status: fileStatus };
            } catch (error: any) {
                logger(`lookupZoteroReferences: Failed to serialize attachment ${attachment.libraryID}/${attachment.key}: ${error}`, 1);
                errors.push({
                    reference: { library_id: attachment.libraryID, zotero_key: attachment.key },
                    error: 'Failed to serialize attachment',
                    error_code: 'load_failed',
                    details: error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error),
                });
                return null;
            }
        }))
    ]);

    // Filter out null results
    const items = itemResults.filter((i): i is ItemDataWithStatus => i !== null);
    const attachments = attachmentResults.filter((a): a is AttachmentDataWithStatus => a !== null);

    // Note parents
    const noteParentItems = [...new Set(
        notesToSerialize
            .map(note => note.parentID)
            .filter((id): id is number => typeof id === 'number')
    )]
        .map(id => parentItemsById.get(id))
        .filter((p): p is Zotero.Item => p != null);
    if (noteParentItems.length > 0) {
        await Zotero.Items.loadDataTypes(noteParentItems, ['itemData', 'creators']);
    }

    // Serialize notes using the same pattern as zotero_search/list_items
    const noteResults: NoteResultItem[] = [];
    for (const note of notesToSerialize) {
        try {
            const parentItem = note.parentID ? parentItemsById.get(note.parentID) : null;
            noteResults.push(serializeNote(note, parentItem ? buildItemStub(parentItem) : null));
        } catch (error: any) {
            logger(`lookupZoteroReferences: Failed to serialize note ${note.libraryID}/${note.key}: ${error}`, 1);
            errors.push({
                reference: { library_id: note.libraryID, zotero_key: note.key },
                error: 'Failed to serialize note',
                error_code: 'load_failed',
                details: error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error),
            });
        }
    }

    // Serialize annotations. Annotations live under attachments, which live
    // under regular items. We surface both the parent attachment (the PDF)
    // and the bibliographic regular item (the paper) so the citation system
    // can render against the bibliographic parent and an LLM-facing tool can
    // name what each id refers to.
    const annotationResults: AnnotationResultItem[] = [];
    for (const annotation of annotationsToSerialize) {
        try {
            const parentAttachment = annotation.parentID ? attachmentItemsById.get(annotation.parentID) : null;
            const attachmentInfo = parentAttachment
                ? { item_id: `${parentAttachment.libraryID}-${parentAttachment.key}` }
                : null;

            const regularItem = parentAttachment?.parentID
                ? parentItemsById.get(parentAttachment.parentID)
                : null;
            let itemInfo: {
                item_id: string;
                item_type?: string | null;
                title: string;
                creators?: string | null;
                year?: number | null;
            } | null = null;
            if (regularItem) {
                let itemTitle = '';
                try { itemTitle = (regularItem.getField('title', false, true) as string) || ''; }
                catch { itemTitle = regularItem.getDisplayTitle?.() || ''; }
                itemInfo = {
                    item_id: `${regularItem.libraryID}-${regularItem.key}`,
                    item_type: regularItem.itemType ?? null,
                    title: itemTitle,
                    creators: formatZoteroCreatorsString(getCreatorsFromItem(regularItem)),
                    year: getYearFromItem(regularItem) ?? null,
                };
            }

            annotationResults.push(serializeAnnotation(annotation, attachmentInfo, itemInfo));
        } catch (error: any) {
            logger(`lookupZoteroReferences: Failed to serialize annotation ${annotation.libraryID}/${annotation.key}: ${error}`, 1);
            errors.push({
                reference: { library_id: annotation.libraryID, zotero_key: annotation.key },
                error: 'Failed to serialize annotation',
                error_code: 'load_failed',
                details: error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error),
            });
        }
    }

    return {
        items,
        attachments,
        notes: noteResults,
        annotations: annotationResults,
        errors,
    };
}

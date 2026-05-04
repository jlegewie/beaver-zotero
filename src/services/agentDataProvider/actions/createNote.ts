import { logger } from '../../../utils/logger';
import { store } from '../../../../react/store';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import { citationDataMapAtom } from '../../../../react/atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../../../react/atoms/externalReferences';
import { currentThreadIdAtom } from '../../../../react/atoms/threads';
import { activeRunAtom } from '../../../../react/agents/atoms';
import { renderToHTML } from '../../../../react/utils/citationRenderers';
import { preloadPageLabelsForContent } from '../../../../react/utils/pageLabels';
import { wrapWithSchemaVersion, getBeaverNoteFooterHTML } from '../../../../react/utils/noteActions';
import { getOrSimplify } from '../../../utils/noteHtmlSimplifier';
import { getLatestNoteHtml } from '../../../utils/noteEditorIO';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
} from '../../agentProtocol';
import { ItemDataWithStatus, AttachmentDataWithStatus } from '../../../../react/types/zotero';
import { getDeferredToolPreference, getLibraryByIdOrName, getCollectionByIdOrName } from '../utils';
import { TimeoutContext, checkAborted } from '../timeout';
import { extractCitationReferences } from './extractCitationReferences';
import { lookupZoteroReferences, LookupZoteroReferencesResult } from '../lookupZoteroReferences';
import { WSDataError, NoteResultItem } from '../../agentProtocol';
import { addAutoApproveNoteKeyAtom, makeNoteKey } from '../../../../react/atoms/editNoteAutoApprove';
import { resolveCreateNoteParent } from './resolveCreateNoteParent';
import { TimingAccumulator } from '../../../utils/timing';


/**
 * Data shape for create_note action_data.
 */
interface CreateNoteActionData {
    title: string;
    content: string;
    parent_item_id?: string | null;
    library?: string | null;
    collection?: string | null;
}


/**
 * Citation resolution data included in result_data.
 * Mirrors the WSZoteroDataResponse shape plus invalid_keys.
 */
interface CitedItemsData {
    items: ItemDataWithStatus[];
    attachments: AttachmentDataWithStatus[];
    notes?: NoteResultItem[];
    errors?: WSDataError[];
    /** Citation IDs with invalid Zotero key format (fabricated by the model) */
    invalid_keys?: string[];
}


/**
 * Typed shape of result_data returned by executeCreateNoteAction.
 */
interface CreateNoteResultData {
    library_id: number;
    zotero_key: string;
    parent_key?: string;
    collection_key?: string;
    note_content?: string;
    cited_items_data?: CitedItemsData;
    warning?: string;
    related_item_key?: string;
}



/**
 * Validate a create_note action.
 * Resolves the target library, parent item, and collection.
 * Returns the user's preference for this tool.
 */
async function validateCreateNoteAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
    const start = Date.now();
    const ta = new TimingAccumulator();
    const buildTiming = (): Record<string, number> => ({
        total_ms: Date.now() - start,
        ...ta.getAll(),
    });

    const {
        title,
        content,
        parent_item_id: rawParentItemId,
        library: libraryNameOrId,
        collection: collectionNameOrKey,
    } = request.action_data as CreateNoteActionData;

    // Validate required fields
    if (!title || !title.trim()) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'Note title cannot be empty',
            error_code: 'invalid_title',
            preference: 'always_ask',
            timing: buildTiming(),
        };
    }

    if (!content || !content.trim()) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: 'Note content cannot be empty',
            error_code: 'invalid_content',
            preference: 'always_ask',
            timing: buildTiming(),
        };
    }

    // pre_resolve_ms: any time spent before the first awaited resolution
    // begins. Today this is just sync arg destructuring; if the message
    // queue ever stalls before dispatch this captures it.
    ta.record('pre_resolve_ms', Date.now() - start);

    // Detect collection key passed as parent_id.
    let parentItemIdInput: string | null | undefined = rawParentItemId;
    let collectionInput: string | null | undefined = collectionNameOrKey;
    let parentToCollectionWarning: string | null = null;
    let collectionDerivedLibraryId: number | null = null;

    if (parentItemIdInput) {
        const dashIdx = parentItemIdInput.indexOf('-');
        let candidateKey: string;
        let candidateLibraryId: number | null = null;
        if (dashIdx > 0) {
            const libIdPart = parentItemIdInput.substring(0, dashIdx);
            const keyPart = parentItemIdInput.substring(dashIdx + 1);
            const parsedLibId = parseInt(libIdPart, 10);
            if (!isNaN(parsedLibId) && keyPart) {
                candidateLibraryId = parsedLibId;
                candidateKey = keyPart;
            } else {
                candidateKey = parentItemIdInput;
            }
        } else {
            candidateKey = parentItemIdInput;
        }

        if (Zotero.Utilities.isValidObjectKey(candidateKey)) {
            await ta.track('parent_collection_swap_ms', async () => {
                let itemExists = false;
                if (candidateLibraryId !== null) {
                    try {
                        const item = await Zotero.Items.getByLibraryAndKeyAsync(candidateLibraryId, candidateKey);
                        itemExists = !!item;
                    } catch {
                        itemExists = false;
                    }
                }
                if (itemExists) return;

                const collectionMatch = getCollectionByIdOrName(
                    parentItemIdInput!,
                    candidateLibraryId ?? undefined,
                );
                if (!collectionMatch) return;

                // If the caller already supplied an explicit collection, defer
                // to it
                if (collectionInput) {
                    logger(
                        `validateCreateNoteAction: parent_id "${parentItemIdInput}" looks like collection "${collectionMatch.collection.name}", but an explicit collection was supplied; clearing parent_id and keeping the explicit collection`,
                        1,
                    );
                    parentToCollectionWarning =
                        `parent_id "${parentItemIdInput}" was a collection key, not an item ID, and was ignored. ` +
                        `The explicit 'collection' parameter was used instead. ` +
                        `Use the 'collection' parameter for collections.`;
                    parentItemIdInput = null;
                    return;
                }

                logger(
                    `validateCreateNoteAction: parent_id "${parentItemIdInput}" resolved as collection "${collectionMatch.collection.name}"; swapping to collection`,
                    1,
                );
                parentToCollectionWarning =
                    `parent_id "${parentItemIdInput}" was a collection key, not an item ID. ` +
                    `The note was added to collection "${collectionMatch.collection.name}" as a standalone note instead of as a child item. ` +
                    `Use the 'collection' parameter for collections.`;
                parentItemIdInput = null;
                collectionInput = collectionMatch.collection.key;
                collectionDerivedLibraryId = collectionMatch.libraryID;
            });
        }
    }

    // Resolve parent item if parent_item_id provided (format: "<library_id>-<zotero_key>").
    // The shared helper walks the item chain up to a regular item, or falls
    // back to standalone-with-related-item when the chain ends at a standalone.
    const parentResolution = await ta.track('parent_resolution_ms', () =>
        resolveCreateNoteParent(parentItemIdInput)
    );
    if (!parentResolution.ok) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: parentResolution.error,
            error_code: parentResolution.errorCode,
            preference: 'always_ask',
            timing: buildTiming(),
        };
    }
    const parentKey: string | null = parentResolution.parentKey;
    let resolvedLibraryId: number | null = parentResolution.resolvedLibraryId;
    const relatedItemKey: string | null = parentResolution.relatedItemKey;
    const parentFallbackWarning: string | null = parentResolution.warning;

    // Resolve target library from library parameter if not set from parent_item_id.
    // Sync, but groups all library-related lookups (getLibraryByIdOrName +
    // getAll fallback + Libraries.get + searchable check + editability) under
    // one bucket. Recorded before each early-return so failure paths attribute
    // their cost too.
    const tLib = Date.now();
    if (resolvedLibraryId == null && libraryNameOrId) {
        const libraryResult = getLibraryByIdOrName(libraryNameOrId);
        if (libraryResult.wasExplicitlyRequested && !libraryResult.library) {
            const allLibraries = Zotero.Libraries.getAll();
            const availableNames = allLibraries.map((lib) => lib.name).join(', ');
            ta.record('library_resolution_ms', Date.now() - tLib);
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Library not found: "${libraryNameOrId}". Omit the library parameter to use the default library. Available libraries: ${availableNames}`,
                error_code: 'library_not_found',
                preference: 'always_ask',
                timing: buildTiming(),
            };
        }
        if (libraryResult.library) {
            resolvedLibraryId = libraryResult.library.libraryID;
        }
    }

    // If parent_id was a collection key, the note must end up in that
    // collection's library
    if (collectionDerivedLibraryId != null && resolvedLibraryId != null && resolvedLibraryId !== collectionDerivedLibraryId) {
        ta.record('library_resolution_ms', Date.now() - tLib);
        const collectionLibrary = Zotero.Libraries.get(collectionDerivedLibraryId);
        const explicitLibrary = Zotero.Libraries.get(resolvedLibraryId);
        const collectionLibraryName = collectionLibrary ? collectionLibrary.name : String(collectionDerivedLibraryId);
        const explicitLibraryName = explicitLibrary ? explicitLibrary.name : String(resolvedLibraryId);
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error:
                `parent_id "${rawParentItemId}" is a collection in library "${collectionLibraryName}", ` +
                `but library "${explicitLibraryName}" was also requested. ` +
                `Use the 'collection' parameter for collections, and ensure 'library' matches.`,
            error_code: 'library_collection_mismatch',
            preference: 'always_ask',
            timing: buildTiming(),
        };
    }
    if (resolvedLibraryId == null && collectionDerivedLibraryId != null) {
        resolvedLibraryId = collectionDerivedLibraryId;
    }

    // Default to user's library
    if (resolvedLibraryId == null) {
        resolvedLibraryId = Zotero.Libraries.userLibraryID;
    }

    // Validate library exists
    const library = Zotero.Libraries.get(resolvedLibraryId);
    if (!library) {
        ta.record('library_resolution_ms', Date.now() - tLib);
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library not found: ${resolvedLibraryId}`,
            error_code: 'library_not_found',
            preference: 'always_ask',
            timing: buildTiming(),
        };
    }

    // Validate library is searchable (synced with Beaver)
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    if (!searchableLibraryIds.includes(resolvedLibraryId)) {
        ta.record('library_resolution_ms', Date.now() - tLib);
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library '${library.name}' is not synced with Beaver. The user can update this setting in Beaver Preferences.`,
            error_code: 'library_not_searchable',
            preference: 'always_ask',
            timing: buildTiming(),
        };
    }

    // Validate library is editable
    if (!library.editable) {
        ta.record('library_resolution_ms', Date.now() - tLib);
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library '${library.name}' is read-only and cannot be modified`,
            error_code: 'library_not_editable',
            preference: 'always_ask',
            timing: buildTiming(),
        };
    }
    ta.record('library_resolution_ms', Date.now() - tLib);

    // Resolve collection if specified.
    // Child notes cannot belong to collections directly (Zotero's
    // fki_collectionItems_itemID_parentItemID trigger aborts the insert),
    // so silently drop the collection when a parent is set — the note
    // inherits collection membership from the parent.
    let resolvedCollectionKey: string | null = null;
    if (collectionInput && !parentKey) {
        const tColl = Date.now();
        const collectionResult = getCollectionByIdOrName(collectionInput, resolvedLibraryId);
        ta.record('collection_resolution_ms', Date.now() - tColl);
        if (collectionResult) {
            resolvedCollectionKey = collectionResult.collection.key;
        } else {
            logger(`validateCreateNoteAction: Collection "${collectionInput}" not found, will skip collection assignment`, 1);
        }
    } else if (collectionInput && parentKey) {
        logger(`validateCreateNoteAction: Ignoring collection "${collectionInput}" because note has parent_key ${parentKey}`, 1);
    }

    // Standalone fallback: if parent resolution dropped to a standalone related
    // item and no collection was explicitly provided, inherit the related item's
    // first collection so the note stays near it in the library tree.
    if (relatedItemKey && !resolvedCollectionKey && !collectionInput) {
        await ta.track('collection_inherit_ms', async () => {
            const sourceItem = await Zotero.Items.getByLibraryAndKeyAsync(resolvedLibraryId!, relatedItemKey);
            if (sourceItem) {
                // getByLibraryAndKeyAsync only guarantees primaryData; getCollections()
                // requires the 'collections' data type, so load it explicitly.
                try {
                    await Zotero.Items.loadDataTypes([sourceItem], ['collections']);
                    const collectionIds = sourceItem.getCollections();
                    if (collectionIds && collectionIds.length > 0) {
                        const firstCollection = Zotero.Collections.get(collectionIds[0]);
                        if (firstCollection) {
                            resolvedCollectionKey = firstCollection.key;
                        }
                    }
                } catch (collErr: any) {
                    logger(`validateCreateNoteAction: Failed to inherit collection from related item: ${collErr.message}`, 1);
                }
            }
        });
    }

    // Get user preference
    const preference = getDeferredToolPreference('create_note');

    // Combine the parent→collection swap warning with any standalone-fallback
    // warning so the agent gets one coherent message about what we did.
    const combinedWarning =
        parentToCollectionWarning && parentFallbackWarning
            ? `${parentToCollectionWarning} ${parentFallbackWarning}`
            : parentToCollectionWarning || parentFallbackWarning;

    // Build normalized action data with resolved values
    const normalizedActionData: Record<string, any> = {
        title: title.trim(),
        content,
        library_id: resolvedLibraryId,
        parent_item_id: parentItemIdInput ?? null,
        collection: collectionInput ?? null,
        parent_key: parentKey,
        collection_key: resolvedCollectionKey,
        related_item_key: relatedItemKey,
        warning: combinedWarning,
    };

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            library_id: resolvedLibraryId,
            library_name: library.name,
            parent_key: parentKey,
            collection_key: resolvedCollectionKey,
        },
        normalized_action_data: normalizedActionData,
        preference,
        timing: buildTiming(),
    };
}


/**
 * Execute a create_note action.
 * Creates a new Zotero note item with the specified content.
 */
async function executeCreateNoteAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const start = Date.now();
    const ta = new TimingAccumulator();
    const buildTiming = (): Record<string, number> => ({
        total_ms: Date.now() - start,
        ...ta.getAll(),
    });

    // action_data is the merged original + normalized_action_data from validation
    const actionData = request.action_data as {
        title: string;
        content: string;
        library_id?: number | null;  // resolved by validation
        parent_key?: string | null;  // resolved by validation
        collection_key?: string | null;  // resolved by validation
        related_item_key?: string | null;  // set by validation when falling back to standalone
        warning?: string | null;  // surfaced to the agent after creation
    };

    const {
        title,
        content,
        library_id: resolvedLibraryId,
        parent_key: parentKey,
        collection_key: collectionKey,
        related_item_key: relatedItemKey,
        warning,
    } = actionData;

    if (!title || !content) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'Title and content are required',
            error_code: 'missing_data',
            timing: buildTiming(),
        };
    }

    const targetLibraryId = resolvedLibraryId ?? Zotero.Libraries.userLibraryID;

    try {
        // Get citation context for rendering
        const citationDataMap = store.get(citationDataMapAtom);
        const externalMapping = store.get(externalReferenceItemMappingAtom);
        const externalReferencesMap = store.get(externalReferenceMappingAtom);

        // Build markdown content with title heading
        const markdownContent = `<h1>${title}</h1>\n\n${content}`;

        // Preload page labels for any citation references in content
        await ta.track('preload_page_labels_ms', () =>
            preloadPageLabelsForContent(markdownContent)
        );

        // Convert markdown to HTML with citation context
        const renderStart = Date.now();
        let htmlContent = renderToHTML(
            markdownContent.trim(),
            "markdown",
            { citationDataMap, externalMapping, externalReferencesMap },
        );
        ta.record('render_html_ms', Date.now() - renderStart);

        // Add Beaver footer with thread/run link
        const threadId = store.get(currentThreadIdAtom);
        const runId = store.get(activeRunAtom)?.id;
        if (threadId) {
            htmlContent += getBeaverNoteFooterHTML(threadId, runId);
        }

        // Checkpoint: abort before creating the note
        checkAborted(ctx, 'create_note:before_save');

        // Create the Zotero note item
        const zoteroNote = new Zotero.Item('note');
        zoteroNote.libraryID = targetLibraryId;
        if (parentKey) {
            zoteroNote.parentKey = parentKey;
        }
        zoteroNote.setNote(wrapWithSchemaVersion(htmlContent));

        // Resolve the related item (standalone-fallback target) up front so we
        // can attach the forward relation before the initial save.
        let relatedItem: Zotero.Item | null = null;
        if (relatedItemKey) {
            try {
                const found = await Zotero.Items.getByLibraryAndKeyAsync(targetLibraryId, relatedItemKey);
                if (found) {
                    relatedItem = found;
                    zoteroNote.addRelatedItem(found);
                }
            } catch (relationError: any) {
                logger(`executeCreateNoteAction: Failed to add relation to standalone parent: ${relationError.message}`, 1);
            }
        }

        // Stage the collection assignment on the in-memory item so saveTx persists it too.
        // Child notes (with parentKey) cannot be in collections — Zotero's
        // fki_collectionItems_itemID_parentItemID trigger aborts saveTx if we try.
        // Validation should already have dropped collectionKey in that case; guard anyway.
        if (collectionKey && !parentKey) {
            try {
                zoteroNote.addToCollection(collectionKey);
            } catch (collectionError: any) {
                logger(`executeCreateNoteAction: Failed to stage collection assignment: ${collectionError.message}`, 1);
                // Don't fail the whole operation for a collection assignment failure
            }
        } else if (collectionKey && parentKey) {
            logger(`executeCreateNoteAction: Skipping addToCollection(${collectionKey}) because note has parent_key ${parentKey} (child notes cannot be in collections directly)`, 1);
        }

        await ta.track('save_tx_ms', () => zoteroNote.saveTx());

        logger(`executeCreateNoteAction: Created note "${title}" with key ${zoteroNote.key} in library ${targetLibraryId}`, 1);

        // Auto-approve future edit_note actions targeting this newly created note
        const noteKey = makeNoteKey(zoteroNote.libraryID, zoteroNote.key);
        store.set(addAutoApproveNoteKeyAtom, noteKey);
        logger(`executeCreateNoteAction: Auto-approve enabled for created note ${noteKey}`, 1);

        // Mirror the relation on the related item so the "Related" pane shows
        // the link from either side. Requires the note's key, so runs post-save.
        if (relatedItem) {
            try {
                if (relatedItem.addRelatedItem(zoteroNote)) {
                    await relatedItem.saveTx({ skipDateModifiedUpdate: true });
                }
            } catch (reverseErr: any) {
                logger(`executeCreateNoteAction: Failed to mirror relation on related item: ${reverseErr.message}`, 1);
            }
        }

        // Read back the saved note as simplified HTML (same format as read_note)
        let noteContent: string | undefined;
        try {
            const noteId = `${zoteroNote.libraryID}-${zoteroNote.key}`;
            const rawHtml = getLatestNoteHtml(zoteroNote);
            if (rawHtml) {
                const simplifyStart = Date.now();
                const { simplified } = getOrSimplify(noteId, rawHtml, zoteroNote.libraryID);
                ta.record('simplify_ms', Date.now() - simplifyStart);
                noteContent = simplified;
            }
        } catch (simplifyError: any) {
            logger(`executeCreateNoteAction: Failed to simplify note content (non-fatal): ${simplifyError.message}`, 1);
        }

        // Resolve citation references for backend validation
        let citedItemsData: LookupZoteroReferencesResult | null = null;
        let invalidCitationKeys: string[] = [];
        try {
            const { references: citationRefs, invalidKeys } = extractCitationReferences(content);
            invalidCitationKeys = invalidKeys;
            if (citationRefs.length > 0) {
                logger(`executeCreateNoteAction: Resolving ${citationRefs.length} citation reference(s)`, 1);
                citedItemsData = await ta.track('lookup_references_ms', () =>
                    lookupZoteroReferences(citationRefs, {
                        include_attachments: true,
                        include_parents: true,
                        file_status_level: 'none',  // metadata only
                    })
                );
            }
            if (invalidKeys.length > 0) {
                logger(`executeCreateNoteAction: Found ${invalidKeys.length} invalid citation key(s): ${invalidKeys.join(', ')}`, 1);
            }
        } catch (citationError: any) {
            logger(`executeCreateNoteAction: Citation resolution failed (non-fatal): ${citationError.message}`, 1);
            // Citation resolution failure is non-fatal — note was created successfully
        }

        // Build typed result_data
        const resultData: CreateNoteResultData = {
            library_id: zoteroNote.libraryID,
            zotero_key: zoteroNote.key,
            ...(zoteroNote.parentKey ? { parent_key: zoteroNote.parentKey } : {}),
            ...(collectionKey ? { collection_key: collectionKey } : {}),
            ...(noteContent ? { note_content: noteContent } : {}),
            ...(warning ? { warning } : {}),
            ...(relatedItemKey ? { related_item_key: relatedItemKey } : {}),
        };

        if (citedItemsData || invalidCitationKeys.length > 0) {
            const cited: CitedItemsData = {
                items: citedItemsData?.items ?? [],
                attachments: citedItemsData?.attachments ?? [],
                ...(citedItemsData && citedItemsData.notes.length > 0 ? { notes: citedItemsData.notes } : {}),
                ...(citedItemsData && citedItemsData.errors.length > 0 ? { errors: citedItemsData.errors } : {}),
                ...(invalidCitationKeys.length > 0 ? { invalid_keys: invalidCitationKeys } : {}),
            };
            resultData.cited_items_data = cited;
        }

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: resultData,
            timing: buildTiming(),
        };
    } catch (error: any) {
        // Re-throw TimeoutError so it propagates to the main handler
        const { TimeoutError } = await import('../timeout');
        if (error instanceof TimeoutError) throw error;

        const errorMsg = error?.message || String(error) || 'Failed to create note';
        logger(`executeCreateNoteAction: Failed to create note: ${errorMsg}`, 1);
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: errorMsg,
            error_code: 'create_failed',
            timing: buildTiming(),
        };
    }
}


export { validateCreateNoteAction, executeCreateNoteAction };

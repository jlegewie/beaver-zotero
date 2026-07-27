import { logger } from '../../../utils/logger';
import { store } from '../../../../react/store';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import { citationMapAtom } from '../../../../react/atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../../../react/atoms/externalReferences';
import { currentThreadIdAtom } from '../../../../react/atoms/threads';
import { grantCreatedNoteEditsForRunAtom } from '../../../../react/atoms/runApprovalPolicy';
import { activeRunAtom } from '../../../../react/agents/atoms';
import { renderToHTML } from '../../../../react/utils/citationRenderers';
import { prepareCitationRenderContext } from '../../../../react/utils/citationRenderContext';
import { wrapWithSchemaVersion, getBeaverNoteFooterHTML } from '../../../../react/utils/noteActions';
import { getOrSimplify } from '../../../utils/noteHtmlSimplifier';
import { preloadNotePageLabels } from '../../../utils/noteCitationExpand';
import { getLatestNoteHtml } from '../../../utils/noteEditorIO';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
} from '../../agentProtocol';
import { ItemDataWithStatus, AttachmentDataWithStatus } from '../../../../react/types/zotero';
import { checkLibraryExcluded, excludedLibraryMessage, getDeferredToolPreference, getLibraryByIdOrName, getCollectionByIdOrName } from '../utils';
import {
    libraryRefForLibraryID,
    resolveObjectId,
    resolveWriteTargetLibrary,
    UNRESOLVED_LIBRARY_ID,
    writeTargetLibraryError,
} from '../../../utils/libraryIdentity';
import { TimeoutContext, checkAborted } from '../timeout';
import { extractCitationReferences } from './extractCitationReferences';
import { lookupZoteroReferences, LookupZoteroReferencesResult } from '../lookupZoteroReferences';
import { WSDataError, NoteResultItem } from '../../agentProtocol';
import { resolveCreateNoteParent } from './resolveCreateNoteParent';
import { TimingAccumulator } from '../../../utils/timing';


/**
 * Data shape for create_note action_data.
 */
interface CreateNoteActionData {
    title: string;
    content: string;
    parent_item_id?: string | null;
    library_id?: number | null;
    library_ref?: string | null;
    library?: string | null;
    /** Legacy single collection (key or name). Backends only send this shape to
     * clients that do not declare create_note_tags_collections. */
    collection?: string | null;
    /** Collection keys or names (create_note_tags_collections feature). Preferred
     * over `collection` when present. */
    collections?: string[] | null;
    /** Tags to apply to the new note (create_note_tags_collections feature). */
    tags?: string[] | null;
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
    library_ref?: string;
    parent_key?: string;
    collection_key?: string;
    /** All collection keys the note was added to (create_note_tags_collections). */
    collection_keys?: string[];
    /** Tags applied to the created note (create_note_tags_collections). */
    tags?: string[];
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
        library_id: rawLibraryId,
        library_ref: libraryRef,
        library: libraryNameOrId,
        collection: collectionNameOrKey,
        collections: rawCollections,
        tags: rawTags,
    } = request.action_data as CreateNoteActionData;

    // Tags to apply to the new note (create_note_tags_collections feature).
    // Deduplicated so the normalized data and current_value report each tag once.
    const tagsInput: string[] = [...new Set(
        (rawTags ?? [])
            .map(t => (typeof t === 'string' ? t.trim() : ''))
            .filter(Boolean)
    )];

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
    // Prefer the plural shape (create_note_tags_collections feature); fall back
    // to the legacy singular field for older backends and stored actions.
    let collectionsInput: string[] = (rawCollections && rawCollections.length > 0)
        ? rawCollections.filter(c => typeof c === 'string' && c.trim())
        : (collectionNameOrKey ? [collectionNameOrKey] : []);
    let parentToCollectionWarning: string | null = null;
    let collectionDerivedLibraryId: number | null = null;

    if (parentItemIdInput) {
        // Accepts both the portable "<library_ref>-<zotero_key>" grammar and the
        // legacy numeric grammar; a bare key or name falls through unsplit.
        const parsedInput = resolveObjectId(parentItemIdInput);
        let candidateKey: string;
        let candidateLibraryId: number | null = null;
        if (parsedInput) {
            candidateLibraryId = parsedInput.library_id === UNRESOLVED_LIBRARY_ID
                ? null
                : parsedInput.library_id;
            candidateKey = parsedInput.zotero_key;
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

                // If the caller already supplied explicit collections, defer
                // to them
                if (collectionsInput.length > 0) {
                    logger(
                        `validateCreateNoteAction: parent_id "${parentItemIdInput}" looks like collection "${collectionMatch.collection.name}", but explicit collections were supplied; clearing parent_id and keeping the explicit collections`,
                        1,
                    );
                    parentToCollectionWarning =
                        `parent_id "${parentItemIdInput}" was a collection key, not an item ID, and was ignored. ` +
                        `The explicit 'collections' parameter was used instead. ` +
                        `Use the 'collections' parameter for collections.`;
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
                    `Use the 'collections' parameter for collections.`;
                parentItemIdInput = null;
                collectionsInput = [collectionMatch.collection.key];
                collectionDerivedLibraryId = collectionMatch.libraryID;
            });
        }
    }

    // Resolve parent item if parent_item_id provided (format: "<library_id>-<zotero_key>").
    // The shared helper walks the item chain up to a regular item, or falls
    // back to standalone-with-related-item when the chain ends at a standalone.
    const parentResolution = await ta.track('parent_resolution_ms', () =>
        resolveCreateNoteParent(parentItemIdInput, libraryRef ?? undefined)
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
    if (libraryRef) {
        const targetResolution = resolveWriteTargetLibrary({
            library_ref: libraryRef,
            library_id: rawLibraryId,
            library_name: null,
        });
        if (!targetResolution.ok) {
            ta.record('library_resolution_ms', Date.now() - tLib);
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                ...writeTargetLibraryError(targetResolution),
                preference: 'always_ask',
                timing: buildTiming(),
            };
        }
        if (resolvedLibraryId != null && resolvedLibraryId !== targetResolution.libraryID) {
            ta.record('library_resolution_ms', Date.now() - tLib);
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: 'Resolved parent library does not match the requested library_ref',
                error_code: 'library_collection_mismatch',
                preference: 'always_ask',
                timing: buildTiming(),
            };
        }
        resolvedLibraryId = targetResolution.libraryID;
    }
    if (!libraryRef && rawLibraryId != null && rawLibraryId !== 0) {
        const targetResolution = resolveWriteTargetLibrary({
            library_id: rawLibraryId,
            library_name: null,
        });
        if (!targetResolution.ok) {
            ta.record('library_resolution_ms', Date.now() - tLib);
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                ...writeTargetLibraryError(targetResolution),
                preference: 'always_ask',
                timing: buildTiming(),
            };
        }
        if (resolvedLibraryId != null && resolvedLibraryId !== targetResolution.libraryID) {
            ta.record('library_resolution_ms', Date.now() - tLib);
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: 'Resolved parent library does not match the requested library_id',
                error_code: 'library_collection_mismatch',
                preference: 'always_ask',
                timing: buildTiming(),
            };
        }
        resolvedLibraryId = targetResolution.libraryID;
    }
    if (resolvedLibraryId == null && libraryNameOrId) {
        const libraryResult = getLibraryByIdOrName(libraryNameOrId);
        if (libraryResult.wasExplicitlyRequested && !libraryResult.library) {
            ta.record('library_resolution_ms', Date.now() - tLib);
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                // Do not list library names: getAll() includes libraries the
                // user excluded from Beaver, so echoing them would leak
                // excluded (private) libraries to the model.
                error: `Library not found: "${libraryNameOrId}". Omit the library parameter to use the default library.`,
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
            error: excludedLibraryMessage(resolvedLibraryId),
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

    // Resolve collections if specified.
    // Child notes cannot belong to collections directly (Zotero's
    // fki_collectionItems_itemID_parentItemID trigger aborts the insert),
    // so silently drop the collections when a parent is set — the note
    // inherits collection membership from the parent.
    const resolvedCollectionKeys: string[] = [];
    if (collectionsInput.length > 0 && !parentKey) {
        const tColl = Date.now();
        for (const entry of collectionsInput) {
            const collectionResult = getCollectionByIdOrName(entry, resolvedLibraryId);
            if (collectionResult) {
                if (!resolvedCollectionKeys.includes(collectionResult.collection.key)) {
                    resolvedCollectionKeys.push(collectionResult.collection.key);
                }
            } else {
                logger(`validateCreateNoteAction: Collection "${entry}" not found, will skip collection assignment`, 1);
            }
        }
        ta.record('collection_resolution_ms', Date.now() - tColl);
    } else if (collectionsInput.length > 0 && parentKey) {
        logger(`validateCreateNoteAction: Ignoring collections "${collectionsInput.join(', ')}" because note has parent_key ${parentKey}`, 1);
    }
    let resolvedCollectionKey: string | null = resolvedCollectionKeys[0] ?? null;

    // Standalone fallback: if parent resolution dropped to a standalone related
    // item and no collection was explicitly provided, inherit the related item's
    // first collection so the note stays near it in the library tree.
    if (relatedItemKey && resolvedCollectionKeys.length === 0 && collectionsInput.length === 0) {
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
                            resolvedCollectionKeys.push(firstCollection.key);
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
        library_ref: libraryRefForLibraryID(resolvedLibraryId) ?? undefined,
        parent_item_id: parentItemIdInput ?? null,
        collection: collectionsInput[0] ?? null,
        collections: collectionsInput,
        tags: tagsInput,
        parent_key: parentKey,
        collection_key: resolvedCollectionKey,
        collection_keys: resolvedCollectionKeys,
        related_item_key: relatedItemKey,
        warning: combinedWarning,
    };

    return {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            library_id: resolvedLibraryId,
            library_ref: libraryRefForLibraryID(resolvedLibraryId) ?? undefined,
            library_name: library.name,
            parent_key: parentKey,
            collection_key: resolvedCollectionKey,
            collection_keys: resolvedCollectionKeys,
            tags: tagsInput,
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
        library_ref?: string | null;  // resolved by validation
        parent_key?: string | null;  // resolved by validation
        collection_key?: string | null;  // resolved by validation
        collection_keys?: string[] | null;  // resolved by validation (create_note_tags_collections)
        tags?: string[] | null;  // create_note_tags_collections
        related_item_key?: string | null;  // set by validation when falling back to standalone
        warning?: string | null;  // surfaced to the agent after creation
    };

    const {
        title,
        content,
        library_id: resolvedLibraryId,
        library_ref: libraryRef,
        parent_key: parentKey,
        collection_key: collectionKey,
        collection_keys: collectionKeys,
        tags,
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

    const targetResolution = resolveWriteTargetLibrary({
        library_ref: libraryRef,
        library_id: resolvedLibraryId,
        library_name: null,
    });
    if (!targetResolution.ok) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            ...writeTargetLibraryError(targetResolution),
            timing: buildTiming(),
        };
    }
    const targetLibraryId = targetResolution.libraryID;

    // TOCTOU guard: never create in a library the user excluded from Beaver,
    // even if validation passed earlier or the execute request skipped it.
    const excludedLibrary = checkLibraryExcluded(targetLibraryId);
    if (excludedLibrary) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: excludedLibrary.message,
            error_code: 'library_not_searchable',
            timing: buildTiming(),
        };
    }

    try {
        // Get citation context for rendering
        const citationDataMap = store.get(citationMapAtom);
        const externalMapping = store.get(externalReferenceItemMappingAtom);
        const externalReferencesMap = store.get(externalReferenceMappingAtom);

        // Build markdown content with title heading
        const markdownContent = `<h1>${title}</h1>\n\n${content}`;

        // Build citation context for note export, including local page
        // metadata for structured locators in tool-call content.
        const renderContextData = await ta.track('prepare_render_context_ms', () =>
            prepareCitationRenderContext(markdownContent, {
                citationDataMap,
                externalMapping,
                externalReferencesMap,
            })
        );

        // Convert markdown to HTML with citation context
        const renderStart = Date.now();
        let htmlContent = renderToHTML(
            markdownContent.trim(),
            "markdown",
            renderContextData,
        );
        ta.record('render_html_ms', Date.now() - renderStart);

        // Add Beaver footer with thread/run link
        const threadId = store.get(currentThreadIdAtom);
        // Only the execute request can authoritatively associate this mutation
        // with a run. MCP/HTTP executions intentionally omit run_id.
        const runId = request.run_id;
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

        // Stage the collection assignments on the in-memory item so saveTx persists them too.
        // Prefer the plural resolved keys (create_note_tags_collections); fall back to the
        // legacy singular key for actions validated by older code.
        // Child notes (with parentKey) cannot be in collections — Zotero's
        // fki_collectionItems_itemID_parentItemID trigger aborts saveTx if we try.
        // Validation should already have dropped the keys in that case; guard anyway.
        const collectionKeysToApply = (collectionKeys && collectionKeys.length > 0)
            ? collectionKeys
            : (collectionKey ? [collectionKey] : []);
        const appliedCollectionKeys: string[] = [];
        if (collectionKeysToApply.length > 0 && !parentKey) {
            for (const key of collectionKeysToApply) {
                try {
                    zoteroNote.addToCollection(key);
                    appliedCollectionKeys.push(key);
                } catch (collectionError: any) {
                    logger(`executeCreateNoteAction: Failed to stage collection assignment for ${key}: ${collectionError.message}`, 1);
                    // Don't fail the whole operation for a collection assignment failure
                }
            }
        } else if (collectionKeysToApply.length > 0 && parentKey) {
            logger(`executeCreateNoteAction: Skipping addToCollection(${collectionKeysToApply.join(', ')}) because note has parent_key ${parentKey} (child notes cannot be in collections directly)`, 1);
        }

        // Stage tags (create_note_tags_collections). Tags are valid on child
        // notes too; addTag creates missing tags implicitly. Skip duplicates so
        // result_data reports each applied tag once.
        const appliedTags: string[] = [];
        for (const tag of tags ?? []) {
            const trimmed = typeof tag === 'string' ? tag.trim() : '';
            if (!trimmed || appliedTags.includes(trimmed)) continue;
            try {
                zoteroNote.addTag(trimmed);
                appliedTags.push(trimmed);
            } catch (tagError: any) {
                logger(`executeCreateNoteAction: Failed to stage tag "${trimmed}": ${tagError.message}`, 1);
            }
        }

        await ta.track('save_tx_ms', () => zoteroNote.saveTx());

        logger(`executeCreateNoteAction: Created note "${title}" with key ${zoteroNote.key} in library ${targetLibraryId}`, 1);

        // A note created by the agent is a safe, narrow continuation target:
        // allow only edits to this exact note for the remainder of this run.
        if (runId && store.get(activeRunAtom)?.id === runId) {
            store.set(grantCreatedNoteEditsForRunAtom, {
                runId,
                libraryId: zoteroNote.libraryID,
                zoteroKey: zoteroNote.key,
            });
        }

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
                const pageLabelsByItemId = await preloadNotePageLabels(rawHtml, zoteroNote.libraryID, { extractOnCacheMiss: true });
                const { simplified } = getOrSimplify(noteId, rawHtml, zoteroNote.libraryID, pageLabelsByItemId);
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
            library_ref: libraryRefForLibraryID(zoteroNote.libraryID) ?? undefined,
            ...(zoteroNote.parentKey ? { parent_key: zoteroNote.parentKey } : {}),
            ...(appliedCollectionKeys.length > 0 ? { collection_key: appliedCollectionKeys[0] } : {}),
            ...(appliedCollectionKeys.length > 0 ? { collection_keys: appliedCollectionKeys } : {}),
            ...(appliedTags.length > 0 ? { tags: appliedTags } : {}),
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

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
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
} from '../../agentProtocol';
import { getDeferredToolPreference, getLibraryByIdOrName, getCollectionByIdOrName } from '../utils';
import { TimeoutContext, checkAborted } from '../timeout';


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
 * Validate a create_note action.
 * Resolves the target library, parent item, and collection.
 * Returns the user's preference for this tool.
 */
async function validateCreateNoteAction(
    request: WSAgentActionValidateRequest
): Promise<WSAgentActionValidateResponse> {
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
        };
    }

    // Resolve parent item if parent_item_id provided (format: "<library_id>-<zotero_key>")
    let parentKey: string | null = null;
    let resolvedLibraryId: number | null = null;

    if (rawParentItemId) {
        const dashIdx = rawParentItemId.indexOf('-');
        if (dashIdx <= 0) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Invalid parent_item_id format: "${rawParentItemId}". Expected "<library_id>-<zotero_key>"`,
                error_code: 'invalid_parent_id',
                preference: 'always_ask',
            };
        }
        const parentLibraryId = parseInt(rawParentItemId.substring(0, dashIdx), 10);
        const parentZoteroKey = rawParentItemId.substring(dashIdx + 1);

        if (isNaN(parentLibraryId) || !parentZoteroKey) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Invalid parent_item_id format: "${rawParentItemId}". Expected "<library_id>-<zotero_key>"`,
                error_code: 'invalid_parent_id',
                preference: 'always_ask',
            };
        }

        const item = await Zotero.Items.getByLibraryAndKeyAsync(parentLibraryId, parentZoteroKey);
        if (!item) {
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Parent item not found: ${rawParentItemId}`,
                error_code: 'item_not_found',
                preference: 'always_ask',
            };
        }

        resolvedLibraryId = parentLibraryId;

        // Resolve attachment to its parent
        if (item.isAttachment() && item.parentKey) {
            parentKey = item.parentKey;
        } else {
            parentKey = parentZoteroKey;
        }
    }

    // Resolve target library from library parameter if not set from parent_item_id
    if (resolvedLibraryId == null && libraryNameOrId) {
        const libraryResult = getLibraryByIdOrName(libraryNameOrId);
        if (libraryResult.wasExplicitlyRequested && !libraryResult.library) {
            const allLibraries = Zotero.Libraries.getAll();
            const availableNames = allLibraries.map((lib) => lib.name).join(', ');
            return {
                type: 'agent_action_validate_response',
                request_id: request.request_id,
                valid: false,
                error: `Library not found: "${libraryNameOrId}". Omit the library parameter to use the default library. Available libraries: ${availableNames}`,
                error_code: 'library_not_found',
                preference: 'always_ask',
            };
        }
        if (libraryResult.library) {
            resolvedLibraryId = libraryResult.library.libraryID;
        }
    }

    // Default to user's library
    if (resolvedLibraryId == null) {
        resolvedLibraryId = Zotero.Libraries.userLibraryID;
    }

    // Validate library exists
    const library = Zotero.Libraries.get(resolvedLibraryId);
    if (!library) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library not found: ${resolvedLibraryId}`,
            error_code: 'library_not_found',
            preference: 'always_ask',
        };
    }

    // Validate library is searchable (synced with Beaver)
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    if (!searchableLibraryIds.includes(resolvedLibraryId)) {
        return {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: false,
            error: `Library '${library.name}' is not synced with Beaver. The user can update this setting in Beaver Preferences.`,
            error_code: 'library_not_searchable',
            preference: 'always_ask',
        };
    }

    // Validate library is editable
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

    // Resolve collection if specified
    let resolvedCollectionKey: string | null = null;
    if (collectionNameOrKey) {
        const collectionResult = getCollectionByIdOrName(collectionNameOrKey, resolvedLibraryId);
        if (collectionResult) {
            resolvedCollectionKey = collectionResult.collection.key;
        } else {
            logger(`validateCreateNoteAction: Collection "${collectionNameOrKey}" not found, will skip collection assignment`, 1);
        }
    }

    // Get user preference
    const preference = getDeferredToolPreference('create_note');

    // Build normalized action data with resolved values
    const normalizedActionData: Record<string, any> = {
        title: title.trim(),
        content,
        library_id: resolvedLibraryId,
        parent_key: parentKey,
        collection_key: resolvedCollectionKey,
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
    // action_data is the merged original + normalized_action_data from validation
    const actionData = request.action_data as {
        title: string;
        content: string;
        library_id?: number | null;  // resolved by validation
        parent_key?: string | null;  // resolved by validation
        collection_key?: string | null;  // resolved by validation
    };

    const {
        title,
        content,
        library_id: resolvedLibraryId,
        parent_key: parentKey,
        collection_key: collectionKey,
    } = actionData;

    if (!title || !content) {
        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: false,
            error: 'Title and content are required',
            error_code: 'missing_data',
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
        await preloadPageLabelsForContent(markdownContent);

        // Convert markdown to HTML with citation context
        let htmlContent = renderToHTML(
            markdownContent.trim(),
            "markdown",
            { citationDataMap, externalMapping, externalReferencesMap },
        );

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

        if (parentKey) {
            zoteroNote.libraryID = targetLibraryId;
            zoteroNote.parentKey = parentKey;
        } else {
            zoteroNote.libraryID = targetLibraryId;
        }

        zoteroNote.setNote(wrapWithSchemaVersion(htmlContent));
        await zoteroNote.saveTx();

        logger(`executeCreateNoteAction: Created note "${title}" with key ${zoteroNote.key} in library ${targetLibraryId}`, 1);

        // Add to collection if specified
        if (collectionKey) {
            try {
                zoteroNote.addToCollection(collectionKey);
                await zoteroNote.saveTx();
                logger(`executeCreateNoteAction: Added note to collection ${collectionKey}`, 1);
            } catch (collectionError: any) {
                logger(`executeCreateNoteAction: Failed to add note to collection: ${collectionError.message}`, 1);
                // Don't fail the whole operation for a collection assignment failure
            }
        }

        return {
            type: 'agent_action_execute_response',
            request_id: request.request_id,
            success: true,
            result_data: {
                library_id: zoteroNote.libraryID,
                zotero_key: zoteroNote.key,
                ...(zoteroNote.parentKey ? { parent_key: zoteroNote.parentKey } : {}),
                ...(collectionKey ? { collection_key: collectionKey } : {}),
            },
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
        };
    }
}


export { validateCreateNoteAction, executeCreateNoteAction };

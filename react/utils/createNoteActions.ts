/**
 * Utility functions for create_note agent actions.
 * Used by AgentActionView for post-run manual apply and undo.
 */

import { AgentAction } from '../agents/agentActions';
import { store } from '../store';
import { citationDataMapAtom } from '../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../atoms/externalReferences';
import { currentThreadIdAtom } from '../atoms/threads';
import { renderToHTML } from './citationRenderers';
import { preloadPageLabelsForContent } from './pageLabels';
import { wrapWithSchemaVersion, getBeaverNoteFooterHTML } from './noteActions';
import { logger } from '../../src/utils/logger';


export interface CreateNoteResultData {
    library_id: number;
    zotero_key: string;
    parent_key?: string;
    collection_key?: string;
}


/**
 * Execute a create_note action from the UI (post-run manual apply).
 * Creates the Zotero note item from the action's proposed_data.
 */
export async function executeCreateNoteAction(action: AgentAction, runId?: string): Promise<CreateNoteResultData> {
    const proposed = action.proposed_data as {
        title: string;
        content: string;
        parent_item_id?: string;   // original: "<library_id>-<zotero_key>"
        library_id?: number;       // resolved by validation (normalized_action_data)
        parent_key?: string;       // resolved by validation (normalized_action_data)
        collection_key?: string;   // resolved by validation (normalized_action_data)
        library?: string;
        collection?: string;
    };

    const { title, content } = proposed;

    if (!title || !content) {
        throw new Error('Title and content are required');
    }

    // Use resolved library_id from normalized data, or parse from parent_item_id, or default
    let targetLibraryId = proposed.library_id ?? Zotero.Libraries.userLibraryID;
    let parentKey = proposed.parent_key || null;

    // If no resolved values, parse parent_item_id
    if (!proposed.library_id && !proposed.parent_key && proposed.parent_item_id) {
        const dashIdx = proposed.parent_item_id.indexOf('-');
        if (dashIdx > 0) {
            const libId = parseInt(proposed.parent_item_id.substring(0, dashIdx), 10);
            const zKey = proposed.parent_item_id.substring(dashIdx + 1);
            if (!isNaN(libId) && zKey) {
                targetLibraryId = libId;
                const item = await Zotero.Items.getByLibraryAndKeyAsync(libId, zKey);
                if (item) {
                    parentKey = (item.isAttachment() && item.parentKey) ? item.parentKey : zKey;
                } else {
                    parentKey = zKey;
                }
            }
        }
    }

    const collectionKey = proposed.collection_key || null;

    // Get citation context for rendering
    const citationDataMap = store.get(citationDataMapAtom);
    const externalMapping = store.get(externalReferenceItemMappingAtom);
    const externalReferencesMap = store.get(externalReferenceMappingAtom);

    // Build markdown content with title heading
    const markdownContent = `<h1>${title}</h1>\n\n${content}`;

    // Preload page labels for citation references
    await preloadPageLabelsForContent(markdownContent);

    // Convert markdown to HTML with citation context
    let htmlContent = renderToHTML(
        markdownContent.trim(),
        "markdown",
        { citationDataMap, externalMapping, externalReferencesMap },
    );

    // Add Beaver footer with thread/run link
    const threadId = store.get(currentThreadIdAtom);
    if (threadId) {
        htmlContent += getBeaverNoteFooterHTML(threadId, runId);
    }

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

    logger(`executeCreateNoteAction: Created note "${title}" with key ${zoteroNote.key}`, 1);

    // Add to collection if specified
    if (collectionKey) {
        try {
            zoteroNote.addToCollection(collectionKey);
            await zoteroNote.saveTx();
        } catch (error: any) {
            logger(`executeCreateNoteAction: Failed to add note to collection: ${error.message}`, 1);
        }
    }

    return {
        library_id: zoteroNote.libraryID,
        zotero_key: zoteroNote.key,
        ...(zoteroNote.parentKey ? { parent_key: zoteroNote.parentKey } : {}),
        ...(collectionKey ? { collection_key: collectionKey } : {}),
    };
}


/**
 * Undo a create_note action by deleting the created note.
 */
export async function undoCreateNoteAction(action: AgentAction): Promise<void> {
    const resultData = action.result_data as CreateNoteResultData | undefined;
    if (!resultData?.library_id || !resultData?.zotero_key) {
        throw new Error('Cannot undo: no result data with note reference');
    }

    const item = await Zotero.Items.getByLibraryAndKeyAsync(
        resultData.library_id, resultData.zotero_key
    );
    if (!item) {
        logger(`undoCreateNoteAction: Note ${resultData.library_id}-${resultData.zotero_key} not found, may have been manually deleted`, 1);
        return;
    }

    await item.eraseTx();
    logger(`undoCreateNoteAction: Deleted note ${resultData.library_id}-${resultData.zotero_key}`, 1);
}

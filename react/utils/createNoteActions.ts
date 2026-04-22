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
import { resolveCreateNoteParent } from '../../src/services/agentDataProvider/actions/resolveCreateNoteParent';


export interface CreateNoteResultData {
    library_id: number;
    zotero_key: string;
    parent_key?: string;
    collection_key?: string;
    /** Simplified HTML content of the created note (same format as read_note) */
    note_content?: string;
    /** Formatted revision instructions from automated review (set by backend) */
    revision_instructions?: string;
    /** Set when the note was created as a standalone related item (fallback path) */
    related_item_key?: string;
    /** Human-readable warning about the fallback, if any */
    warning?: string;
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

    // Re-resolve the parent on manual apply whenever parent_item_id is set.
    // The resolver is the source of truth for the standalone-fallback path
    // (relatedItemKey/warning); stored normalized fields like library_id or
    // parent_key don't carry that data, so skipping resolution when they're
    // present would lose the fallback link.
    let targetLibraryId = proposed.library_id ?? Zotero.Libraries.userLibraryID;
    let parentKey: string | null = proposed.parent_key || null;
    let relatedItemKey: string | null = null;
    let warning: string | null = null;

    if (proposed.parent_item_id) {
        const resolution = await resolveCreateNoteParent(proposed.parent_item_id);
        if (!resolution.ok) {
            throw new Error(resolution.error);
        }
        if (resolution.resolvedLibraryId != null) {
            targetLibraryId = resolution.resolvedLibraryId;
        }
        parentKey = resolution.parentKey;
        relatedItemKey = resolution.relatedItemKey;
        warning = resolution.warning;
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

    // Fetch the standalone-fallback target once; used for both the forward
    // relation (staged pre-save) and collection inheritance.
    let relatedItem: Zotero.Item | null = null;
    if (relatedItemKey) {
        try {
            const found = await Zotero.Items.getByLibraryAndKeyAsync(targetLibraryId, relatedItemKey);
            if (found) {
                relatedItem = found;
            }
        } catch (relationError: any) {
            logger(`executeCreateNoteAction: Failed to look up standalone parent: ${relationError.message}`, 1);
        }
    }

    // Inherit collection from the standalone parent when none was specified.
    let effectiveCollectionKey = collectionKey;
    if (relatedItem && !effectiveCollectionKey) {
        try {
            await Zotero.Items.loadDataTypes([relatedItem], ['collections']);
            const collectionIds = relatedItem.getCollections();
            if (collectionIds && collectionIds.length > 0) {
                const firstCollection = Zotero.Collections.get(collectionIds[0]);
                if (firstCollection) {
                    effectiveCollectionKey = firstCollection.key;
                }
            }
        } catch (error: any) {
            logger(`executeCreateNoteAction: Failed to inherit collection from standalone parent: ${error.message}`, 1);
        }
    }

    // Create the Zotero note item and stage relation + collection on the
    // unsaved item so a single saveTx persists everything together.
    const zoteroNote = new Zotero.Item('note');
    zoteroNote.libraryID = targetLibraryId;
    if (parentKey) {
        zoteroNote.parentKey = parentKey;
    }
    zoteroNote.setNote(wrapWithSchemaVersion(htmlContent));

    if (relatedItem) {
        try {
            zoteroNote.addRelatedItem(relatedItem);
        } catch (relationError: any) {
            logger(`executeCreateNoteAction: Failed to stage relation on note: ${relationError.message}`, 1);
        }
    }

    if (effectiveCollectionKey) {
        try {
            zoteroNote.addToCollection(effectiveCollectionKey);
        } catch (error: any) {
            logger(`executeCreateNoteAction: Failed to stage collection assignment: ${error.message}`, 1);
        }
    }

    await zoteroNote.saveTx();

    logger(`executeCreateNoteAction: Created note "${title}" with key ${zoteroNote.key}`, 1);

    // Mirror the relation on the related item so the "Related" pane shows the
    // link from either side. Requires the note's key, so runs post-save.
    if (relatedItem) {
        try {
            if (relatedItem.addRelatedItem(zoteroNote)) {
                await relatedItem.saveTx({ skipDateModifiedUpdate: true });
            }
        } catch (reverseErr: any) {
            logger(`executeCreateNoteAction: Failed to mirror relation on related item: ${reverseErr.message}`, 1);
        }
    }

    return {
        library_id: zoteroNote.libraryID,
        zotero_key: zoteroNote.key,
        ...(zoteroNote.parentKey ? { parent_key: zoteroNote.parentKey } : {}),
        ...(effectiveCollectionKey ? { collection_key: effectiveCollectionKey } : {}),
        ...(relatedItemKey ? { related_item_key: relatedItemKey } : {}),
        ...(warning ? { warning } : {}),
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

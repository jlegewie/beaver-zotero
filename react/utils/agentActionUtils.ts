/**
 * Utility functions for agent actions
 */

import { AgentAction, isAnnotationAgentAction, isZoteroNoteAgentAction, hasAppliedZoteroItem } from '../agents/agentActions';
import { ZoteroItemReference } from '../types/zotero';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';

/**
 * Extract all Zotero item references from agent actions that need to be loaded.
 * 
 * This includes:
 * - Attachment items for annotation actions (from proposed_data)
 * - Applied items from result_data (annotations, notes, created items)
 */
export function extractItemReferencesFromAgentActions(actions: AgentAction[]): ZoteroItemReference[] {
    const refs = new Map<string, ZoteroItemReference>();

    for (const action of actions) {
        // For annotation actions, extract attachment reference from proposed_data
        if (isAnnotationAgentAction(action)) {
            const libraryId = action.proposed_data.library_id;
            const attachmentKey = action.proposed_data.attachment_key;
            if (typeof libraryId === 'number' && typeof attachmentKey === 'string' && attachmentKey) {
                const key = `${libraryId}-${attachmentKey}`;
                if (!refs.has(key)) {
                    refs.set(key, { library_id: libraryId, zotero_key: attachmentKey });
                }
            }
        }

        // For zotero_note actions with existing item reference in proposed_data
        if (isZoteroNoteAgentAction(action)) {
            const libraryId = action.proposed_data.library_id;
            const zoteroKey = action.proposed_data.zotero_key;
            if (typeof libraryId === 'number' && typeof zoteroKey === 'string' && zoteroKey) {
                const key = `${libraryId}-${zoteroKey}`;
                if (!refs.has(key)) {
                    refs.set(key, { library_id: libraryId, zotero_key: zoteroKey });
                }
            }
        }

        // For applied actions, extract the created item reference from result_data
        if (hasAppliedZoteroItem(action)) {
            const libraryId = action.result_data!.library_id;
            const zoteroKey = action.result_data!.zotero_key;
            if (typeof libraryId === 'number' && typeof zoteroKey === 'string' && zoteroKey) {
                const key = `${libraryId}-${zoteroKey}`;
                if (!refs.has(key)) {
                    refs.set(key, { library_id: libraryId, zotero_key: zoteroKey });
                }
            }
        }
    }

    return Array.from(refs.values());
}

/**
 * Load Zotero item data for agent actions.
 * 
 * Extracts all item references from the actions and loads their full data
 * (including parents, children, creators, etc.) for proper UI rendering.
 * 
 * @param actions - Array of agent actions to process
 * @returns Array of loaded Zotero items
 */
export async function loadItemDataForAgentActions(actions: AgentAction[]): Promise<Zotero.Item[]> {
    const refs = extractItemReferencesFromAgentActions(actions);
    if (refs.length === 0) return [];

    // Fetch items by library and key
    const itemPromises = refs.map(ref =>
        Zotero.Items.getByLibraryAndKeyAsync(ref.library_id, ref.zotero_key)
    );
    const items = (await Promise.all(itemPromises)).filter((item): item is Zotero.Item => !!item);

    // Load full item data
    if (items.length > 0) {
        await loadFullItemDataWithAllTypes(items);
    }

    return items;
}


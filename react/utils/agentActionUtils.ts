/**
 * Utility functions for agent actions
 */

import { AgentAction, isAnnotationAgentAction, isZoteroNoteAgentAction, hasAppliedZoteroItem } from '../agents/agentActions';
import { ZoteroItemReference } from '../types/zotero';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';
import { getPref } from '../../src/utils/prefs';
import { store } from '../store';
import { currentReaderAttachmentKeyAtom } from '../atoms/messageComposition';
import { toolAnnotationApplyBatcher, filterAnnotationAgentActions } from './toolAnnotationApplyBatcher';
import { logger } from '../../src/utils/logger';

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

/**
 * Auto-apply annotation agent actions if enabled in settings.
 * 
 * Checks if auto-apply is enabled, filters annotations for the current reader,
 * and enqueues them for batch application.
 * 
 * @param runId - The run ID for the actions
 * @param actions - Array of agent actions to process
 */
export function autoApplyAnnotationAgentActions(runId: string, actions: AgentAction[]): void {
    // Check if auto-apply is enabled
    if (!getPref('autoApplyAnnotations')) {
        return;
    }

    // Check if there's a current reader
    const currentReaderKey = store.get(currentReaderAttachmentKeyAtom);
    if (!currentReaderKey) {
        return;
    }

    // Filter to annotation actions only
    const annotationActions = filterAnnotationAgentActions(actions);
    if (annotationActions.length === 0) {
        return;
    }

    // Only auto-apply annotations for the current reader
    const actionsForCurrentReader = annotationActions.filter(
        (action) => action.proposed_data.attachment_key === currentReaderKey
    );

    if (actionsForCurrentReader.length === 0) {
        return;
    }

    // Group by toolcall_id and enqueue for batch application
    const actionsByToolcall = new Map<string, typeof actionsForCurrentReader>();
    for (const action of actionsForCurrentReader) {
        const toolcallId = action.toolcall_id || 'unknown';
        if (!actionsByToolcall.has(toolcallId)) {
            actionsByToolcall.set(toolcallId, []);
        }
        actionsByToolcall.get(toolcallId)!.push(action);
    }

    // Enqueue each group
    for (const [toolcallId, groupActions] of actionsByToolcall) {
        logger(`autoApplyAnnotationAgentActions: Enqueueing ${groupActions.length} annotations for toolcall ${toolcallId}`, 1);
        toolAnnotationApplyBatcher.enqueue({
            runId,
            toolcallId,
            actions: groupActions,
        });
    }
}


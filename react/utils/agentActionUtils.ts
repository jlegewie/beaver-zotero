/**
 * Utility functions for agent actions
 */

import { AgentAction, isAnnotationAgentAction, isCreateNoteAgentAction, hasAppliedZoteroItem } from '../agents/agentActions';
import { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { loadFullItemDataWithAllTypes } from '../../src/utils/zoteroUtils';
import { getPref } from '../../src/utils/prefs';
import { store } from '../store';
import { currentReaderAttachmentKeyAtom } from '../atoms/messageComposition';
import { toolAnnotationApplyBatcher, filterAnnotationAgentActions } from './toolAnnotationApplyBatcher';
import { logger } from '@beaver/agent-core/platform/logger';
import { parseZoteroId } from '@beaver/agent-core/citations/citationGrammar';
import { hasLibraryIdentity, libraryKeyToken, resolveItemReference, UNRESOLVED_LIBRARY_ID } from '../../src/utils/libraryIdentity';

/**
 * Add a `{library_ref?, library_id?, zotero_key}` reference to the dedup map,
 * ignoring anything that names no library or no key.
 *
 * Keyed on the portable `library_ref` when there is one: an unresolved ref
 * collapses `library_id` to the sentinel, so two references from different
 * libraries would otherwise dedup onto the same entry and one item would be
 * loaded for the other.
 */
function addItemReference(
    refs: Map<string, ZoteroItemReference>,
    source: { library_id?: unknown; library_ref?: unknown },
    zoteroKey: unknown,
): void {
    if (typeof zoteroKey !== 'string' || !zoteroKey) return;
    const libraryId = typeof source.library_id === 'number' ? source.library_id : undefined;
    const libraryRef = typeof source.library_ref === 'string' && source.library_ref
        ? source.library_ref
        : undefined;
    if (!hasLibraryIdentity({ library_id: libraryId, library_ref: libraryRef })) return;

    const key = `${libraryKeyToken({ library_ref: libraryRef, library_id: libraryId })}-${zoteroKey}`;
    if (refs.has(key)) return;
    refs.set(key, {
        library_id: libraryId ?? UNRESOLVED_LIBRARY_ID,
        zotero_key: zoteroKey,
        ...(libraryRef ? { library_ref: libraryRef } : {}),
    });
}

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
            addItemReference(refs, action.proposed_data, action.proposed_data.attachment_key);
        }

        // For create_note actions with parent item reference in proposed_data
        if (isCreateNoteAgentAction(action)) {
            const parentItemId = action.proposed_data.parent_item_id as string | undefined;
            const parsedParent = parseZoteroId(parentItemId);
            if (parsedParent) {
                // Key on library_ref when available: an unresolved portable ref
                // collapses library_id to UNRESOLVED_LIBRARY_ID, and two refs from
                // different groups would otherwise collide on the same key.
                const key = `${libraryKeyToken(parsedParent)}-${parsedParent.zotero_key}`;
                if (!refs.has(key)) {
                    refs.set(key, parsedParent);
                }
            }
        }

        // For applied actions, extract the created item reference from result_data
        if (hasAppliedZoteroItem(action)) {
            addItemReference(refs, action.result_data!, action.result_data!.zotero_key);
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

    const itemPromises = refs.map(async ref => {
        const resolved = await resolveItemReference(ref);
        return resolved.status === 'found' ? resolved.item : null;
    });
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

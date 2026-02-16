/**
 * Utility functions for agent actions
 */

import React, { createElement, useCallback } from 'react';
import { Setter } from 'jotai';
import { AgentAction, isAnnotationAgentAction, isZoteroNoteAgentAction, hasAppliedZoteroItem, ackAgentActionsAtom, undoAgentActionAtom } from '../agents/agentActions';
import { NoteProposedData } from '../types/agentActions/base';
import { ZoteroItemReference } from '../types/zotero';
import { activeRunAtom } from '../agents/atoms';
import { loadFullItemDataWithAllTypes, isLibraryEditable } from '../../src/utils/zoteroUtils';
import { getPref } from '../../src/utils/prefs';
import { store } from '../store';
import { currentReaderAttachmentKeyAtom } from '../atoms/messageComposition';
import { citationDataMapAtom } from '../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../atoms/externalReferences';
import { toolAnnotationApplyBatcher, filterAnnotationAgentActions } from './toolAnnotationApplyBatcher';
import { saveStreamingNote } from './noteActions';
import { addPopupMessageAtom, removePopupMessageAtom } from './popupMessageUtils';
import { truncateText } from './stringUtils';
import { ZOTERO_ICONS, ZoteroIcon } from '../components/icons/ZoteroIcon';
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

/**
 * Small popup content component for auto-created notes.
 * Shows "Saved to Zotero." with an "Undo" button.
 */
const NoteCreatedPopupContent: React.FC<{
    resultLibraryId: number;
    resultZoteroKey: string;
    actionId: string;
    popupId: string;
}> = ({ resultLibraryId, resultZoteroKey, actionId, popupId }) => {
    const handleUndo = useCallback(async () => {
        try {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(resultLibraryId, resultZoteroKey);
            if (item) await item.eraseTx();
            store.set(undoAgentActionAtom, actionId);
            store.set(removePopupMessageAtom, popupId);
        } catch (err) {
            logger(`Undo auto-created note failed: ${err}`, 1);
        }
    }, [resultLibraryId, resultZoteroKey, actionId, popupId]);

    return createElement('div', {
        className: 'display-flex flex-row items-center gap-2 text-sm font-color-tertiary',
    },
        createElement('span', null, 'Saved to Zotero.'),
        createElement('button', {
            className: 'text-link text-sm',
            onClick: handleUndo,
        }, 'Undo')
    );
};

/**
 * Parse note attributes from a `<note ...>` opening tag string.
 * Returns a map of attribute name → value.
 */
function parseNoteTagAttributes(tag: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let match;
    while ((match = attrRegex.exec(tag)) !== null) {
        attrs[match[1]] = match[2];
    }
    return attrs;
}

/**
 * Check if two `<note ...>` opening tags match by comparing their attributes
 * (excluding 'id' which is injected by the backend).
 * Uses sorted attribute comparison — same logic as `tagsMatch` in agentActions.ts.
 */
function noteTagsMatch(tag1: string, tag2: string): boolean {
    const attrs1 = parseNoteTagAttributes(tag1);
    const attrs2 = parseNoteTagAttributes(tag2);
    // Exclude 'id' attribute
    delete attrs1['id'];
    delete attrs2['id'];

    const keys1 = Object.keys(attrs1).sort();
    const keys2 = Object.keys(attrs2).sort();
    if (keys1.length !== keys2.length) return false;
    return keys1.every((key, i) => key === keys2[i] && attrs1[key] === attrs2[key]);
}

interface ParsedNoteBlock {
    rawTag: string;
    title: string;
    content: string;
    isComplete: boolean;
}

/**
 * Extract note blocks from message text by parsing `<note>` tags.
 * Returns parsed blocks with their content for matching against agent actions.
 */
function extractNoteBlocksFromText(text: string): ParsedNoteBlock[] {
    const blocks: ParsedNoteBlock[] = [];
    const noteOpeningTagRegex = /<note\s+([^>]*?)>/g;
    let match: RegExpExecArray | null;

    while ((match = noteOpeningTagRegex.exec(text)) !== null) {
        const openTagEnd = match.index + match[0].length;
        const rawTag = match[0];
        const attrs = parseNoteTagAttributes(rawTag);
        const title = attrs['title'] || '';

        const closingIdx = text.indexOf('</note>', openTagEnd);
        if (closingIdx !== -1) {
            blocks.push({
                rawTag,
                title,
                content: text.substring(openTagEnd, closingIdx),
                isComplete: true,
            });
        } else {
            blocks.push({
                rawTag,
                title,
                content: text.substring(openTagEnd),
                isComplete: false,
            });
        }
    }

    return blocks;
}

/**
 * Extract all note content from the active run's model messages.
 * Concatenates all text parts from response messages and parses note blocks.
 */
function extractNoteBlocksFromRun(runId: string): ParsedNoteBlock[] {
    const run = store.get(activeRunAtom);
    if (!run || run.id !== runId) return [];

    const allBlocks: ParsedNoteBlock[] = [];
    for (const message of run.model_messages) {
        if (message.kind !== 'response') continue;
        for (const part of message.parts) {
            if (part.part_kind !== 'text') continue;
            allBlocks.push(...extractNoteBlocksFromText(part.content));
        }
    }
    return allBlocks;
}

/**
 * Auto-create Zotero notes from agent actions if enabled in settings.
 *
 * Note content is NOT stored in agent action proposed_data (it's always null).
 * Instead, content lives in the streamed message text between <note> and </note> tags.
 * This function extracts content from the active run's messages and matches it
 * to pending note actions via raw_tag comparison.
 *
 * Should only be called from onRunComplete (not onAgentActions) since the note
 * content may still be streaming when individual actions arrive.
 *
 * @param runId - The run ID for the actions
 * @param actions - Array of agent actions to process
 * @param set - Jotai setter for updating atoms
 */
export async function autoCreateNoteAgentActions(
    runId: string,
    actions: AgentAction[],
    set: Setter
): Promise<void> {
    if (!getPref('autoCreateNotes')) return;

    const noteActions = actions.filter(a =>
        isZoteroNoteAgentAction(a) &&
        a.status === 'pending'
    );
    if (noteActions.length === 0) return;

    // Extract note content from the run's message text
    const noteBlocks = extractNoteBlocksFromRun(runId);
    if (noteBlocks.length === 0) {
        logger('autoCreateNoteAgentActions: No note blocks found in run messages', 1);
        return;
    }

    // Get citation context for rendering
    const citationDataMap = store.get(citationDataMapAtom);
    const externalMapping = store.get(externalReferenceItemMappingAtom);
    const externalReferencesMap = store.get(externalReferenceMappingAtom);

    for (const action of noteActions) {
        const proposed = action.proposed_data as NoteProposedData;
        const actionRawTag = proposed.raw_tag;

        // Match action to note block by raw_tag
        const matchedBlock = actionRawTag
            ? noteBlocks.find(b => noteTagsMatch(b.rawTag, actionRawTag))
            : null;

        if (!matchedBlock || !matchedBlock.isComplete || !matchedBlock.content.trim()) {
            continue;
        }

        const title = proposed.title || matchedBlock.title || 'New note';
        const content = matchedBlock.content;

        // Resolve parent from proposed_data.library_id + zotero_key
        let parentReference: ZoteroItemReference | undefined;
        let targetLibraryId: number | undefined;

        if (proposed.library_id != null && proposed.zotero_key) {
            const item = await Zotero.Items.getByLibraryAndKeyAsync(
                proposed.library_id, proposed.zotero_key
            );
            if (item) {
                targetLibraryId = proposed.library_id;
                if (item.isAttachment() && item.parentKey) {
                    parentReference = { library_id: proposed.library_id, zotero_key: item.parentKey };
                } else {
                    parentReference = { library_id: proposed.library_id, zotero_key: proposed.zotero_key };
                }
            }
        }

        if (!targetLibraryId) continue;
        if (!isLibraryEditable(targetLibraryId)) continue;

        try {
            const noteContent = `<h1>${title}</h1>\n\n${content}`;
            const result = await saveStreamingNote({
                markdownContent: noteContent,
                title,
                parentReference,
                targetLibraryId,
                contextData: { citationDataMap, externalMapping, externalReferencesMap }
            });

            // Acknowledge the action (marks as 'applied')
            set(ackAgentActionsAtom, runId, [{ action_id: action.id, result_data: result }]);

            // Show popup with undo
            const popupId = `auto-note-${action.id}`;
            set(addPopupMessageAtom, {
                id: popupId,
                type: 'info' as const,
                icon: createElement(ZoteroIcon, { icon: ZOTERO_ICONS.NOTES, size: 12 }),
                title: `Note: ${truncateText(title, 50)}`,
                customContent: createElement(NoteCreatedPopupContent, {
                    resultLibraryId: result.library_id,
                    resultZoteroKey: result.zotero_key,
                    actionId: action.id,
                    popupId,
                }),
                expire: true,
                duration: 6000,
            });
        } catch (error: any) {
            logger(`autoCreateNoteAgentActions: Failed to create note "${title}": ${error.message}`, 1);
        }
    }
}


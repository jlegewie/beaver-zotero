/**
 * Prompt Variable Resolution
 *
 * Resolves {{variable}} placeholders in custom prompt text.
 * Variables are resolved client-side before the message is sent to the agent.
 *
 * Two kinds of variables:
 *   - Item variables: resolve to Zotero.Item[] that get added as message
 *     attachments (flowing through the existing attachment pipeline).
 *     The placeholder is removed from the text.
 *   - Text variables: resolve to a string that replaces the placeholder.
 *
 * Supported variables:
 *   {{recent_items}}      — (items) Last 5 recently added papers
 *   {{recent_item}}       — (items) Most recently added paper
 *   {{selected_items}}     — (items) Currently selected items in the library view
 *   {{open_attachment}}    — (items) Attachment currently open in the reader
 *   {{active_item}}        — (items) Active context item (open parent > selected > recent)
 *   {{current_collection}} — (text)  Name of the currently selected collection
 */

import { logger } from '@beaver/agent-core/platform/logger';
import { agentItemFilter } from '../../src/utils/agentItemSupport';
import { getCurrentReader } from './readerUtils';
import { store } from '../store';
import { searchableLibraryIdsAtom } from '../atoms/profile';
import { currentReaderAttachmentAtom } from '../atoms/messageComposition';
import { selectedZoteroItemsAtom, currentNoteItemAtom, libraryViewAtom } from '../atoms/zoteroContext';
import { pureCollectionSelection } from './actionVisibility';
import { ActionTargetType } from '@beaver/agent-core/types/actions';
import { CollectionReference } from '@beaver/agent-core/types/zotero';
import { collectionToReference } from './zoteroReferences';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Human-readable hints shown when an item variable resolves to zero items */
export const EMPTY_VARIABLE_HINTS: Record<string, string> = {
    recent_items:    'No recently added items found in your library.',
    recent_item:     'No recently added item found in your library.',
    selected_items:  'No items are selected in the library view.',
    open_attachment: 'No attachment is open in the reader.',
    open_note:       'No note is open in a tab.',
    active_item:     'No active item found. Try opening a PDF or selecting an item.',
};

/** Metadata for each supported variable (used for UI hints) */
export const PROMPT_VARIABLES: { name: string; description: string }[] = [
    { name: 'recent_items',      description: 'Last 5 recently added items' },
    { name: 'recent_item',       description: 'Most recently added item' },
    { name: 'selected_items',     description: 'Currently selected items' },
    { name: 'open_attachment',    description: 'Attachment open in the reader' },
    { name: 'open_note',          description: 'Note open in a tab' },
    { name: 'active_item',        description: 'Active item (open file → selected → recent)' },
    { name: 'current_collection', description: 'Currently selected collection' },
];

/** Result of resolving prompt variables */
export interface PromptResolution {
    /** The prompt text with placeholders replaced (item placeholders removed) */
    text: string;
    /** Zotero items to add as message attachments */
    items: Zotero.Item[];
    /** Collection context when targetType is 'collection' — every selected
     *  collection, or empty when the selection is not purely collections. */
    collections: CollectionReference[];
    /** Item variable names that were present but resolved to zero items */
    emptyItemVariables: string[];
    /**
     * True when the action's bound target resolved to items but every one of
     * them belonged to an excluded library.
     */
    targetContextExcluded: boolean;
}

/**
 * Resolve {{variable}} placeholders in prompt text.
 * Returns the resolved text and any Zotero items that should be added as attachments.
 *
 * When `targetType` is provided, auto-attaches context items based on the target type
 * (e.g., selected items for "items", reader attachment for "attachment").
 * These are merged with any variable-resolved items, deduplicated by libraryID-key.
 */
/**
 * Drop items belonging to libraries the user excluded from Beaver.
 */
function keepSearchable(items: Zotero.Item[]): Zotero.Item[] {
    if (items.length === 0) return items;
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    return items.filter((item: Zotero.Item) => searchableLibraryIds.includes(item.libraryID));
}

export async function resolvePromptVariables(
    text: string,
    targetType?: ActionTargetType,
): Promise<PromptResolution> {
    const pattern = /\{\{(\w+)\}\}/g;
    const matches = [...text.matchAll(pattern)];

    // Fast path: no variables and no targetType context
    if (matches.length === 0 && !targetType) {
        return { text, items: [], collections: [], emptyItemVariables: [], targetContextExcluded: false };
    }

    // Resolve all unique variables in parallel
    const uniqueVars = [...new Set(matches.map(m => m[1]))];
    const resolutionMap = new Map<string, ResolvedVariable>();

    await Promise.all(uniqueVars.map(async (varName) => {
        const resolver = RESOLVERS[varName];
        if (!resolver) return; // Unknown variable — leave placeholder as-is
        try {
            const result = await resolver();
            resolutionMap.set(varName, result);
        } catch (e) {
            logger(`promptVariables: failed to resolve {{${varName}}}: ${e}`, 1);
            resolutionMap.set(varName, { text: '', items: [] });
        }
    }));

    // Replace placeholders and collect items
    const allItems: Zotero.Item[] = [];
    const emptyItemVariables: string[] = [];

    let result = text.replace(pattern, (fullMatch, varName) => {
        const resolution = resolutionMap.get(varName);
        if (!resolution) return fullMatch; // Unknown variable — keep placeholder
        const items = keepSearchable(resolution.items);
        allItems.push(...items);
        // Track item variables (text === '') that resolved to zero items. This
        // counts items dropped by library exclusion, so a variable left empty
        // by filtering reports the same "no items" hint as an empty selection.
        if (resolution.text === '' && items.length === 0) {
            emptyItemVariables.push(varName);
        }
        return resolution.text;
    });

    // Auto-attach context based on targetType (dedup items with variable-resolved ones)
    let collections: CollectionReference[] = [];
    let targetContextExcluded = false;
    if (targetType) {
        const context = resolveTargetContext(targetType);
        targetContextExcluded = context.itemsExcluded;
        if (context.items.length > 0) {
            const existingKeys = new Set(allItems.map(i => `${i.libraryID}-${i.key}`));
            for (const item of context.items) {
                if (!existingKeys.has(`${item.libraryID}-${item.key}`)) {
                    allItems.push(item);
                    existingKeys.add(`${item.libraryID}-${item.key}`);
                }
            }
        }
        collections = context.collections;
    }

    // Clean up formatting artifacts from empty resolutions
    if (matches.length > 0) {
        result = result
            .replace(/[ \t]{2,}/g, ' ')     // Collapse multiple spaces
            .replace(/\n{3,}/g, '\n\n')     // Collapse 3+ newlines to 2
            .trim();
    }

    return { text: result, items: allItems, collections, emptyItemVariables, targetContextExcluded };
}

// ---------------------------------------------------------------------------
// Target-type context resolution (synchronous — reads from Jotai store)
// ---------------------------------------------------------------------------

export interface TargetTypeContext {
    items: Zotero.Item[];
    collections: CollectionReference[];
}

/** What an action's target type binds to, with excluded libraries removed. */
export interface ResolvedTargetContext extends TargetTypeContext {
    /** The target resolved to items, but every one of them was dropped as
     *  belonging to an excluded library. */
    itemsExcluded: boolean;
    /** Same for collections. */
    collectionsExcluded: boolean;
}

/**
 * Resolve what an action's target type binds to right now, dropping libraries
 * the user excluded from Beaver.
 *
 * Synchronous on purpose: actions resolve their targets the moment the user
 * picks them, so the items land in the composer within the same click.
 *
 * `override` supplies the context instead of the live Zotero state — the
 * library context menu binds the rows the user right-clicked, which are not
 * always what the current selection resolves to.
 */
export function resolveTargetContext(
    targetType?: ActionTargetType,
    override?: TargetTypeContext,
): ResolvedTargetContext {
    if (!targetType) {
        return { items: [], collections: [], itemsExcluded: false, collectionsExcluded: false };
    }
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    const context = override ?? resolveTargetTypeContext(targetType);
    const items = keepSearchable(context.items);
    const collections = context.collections.filter(
        (collection) => searchableLibraryIds.includes(collection.library_id),
    );
    return {
        items,
        collections,
        itemsExcluded: context.items.length > 0 && items.length === 0,
        collectionsExcluded: context.collections.length > 0 && collections.length === 0,
    };
}

function isActionableItem(item: Zotero.Item): boolean {
    return agentItemFilter(item);
}

/**
 * The selected collections as wire references, following the shared
 * {@link pureCollectionSelection} rule: empty unless the collections-tree
 * selection is nothing but collections. Collections that no longer resolve
 * (deleted between selection and send) are dropped.
 */
function selectedCollectionReferences(): CollectionReference[] {
    const searchableLibraryIds = store.get(searchableLibraryIdsAtom);
    const selected = pureCollectionSelection(store.get(libraryViewAtom))
        .filter(info => searchableLibraryIds.includes(info.libraryId));
    const references: CollectionReference[] = [];
    for (const info of selected) {
        const collection = Zotero.Collections.get(info.collectionId) as Zotero.Collection | undefined;
        if (collection) references.push(collectionToReference(collection));
    }
    return references;
}

function resolveTargetTypeContext(targetType: ActionTargetType): TargetTypeContext {
    switch (targetType) {
        case 'items': {
            // Reader context: parent item + attachment (only if supported)
            const readerAttachment = store.get(currentReaderAttachmentAtom);
            if (readerAttachment && isActionableItem(readerAttachment)) {
                const parent = readerAttachment.parentItem;
                return { items: parent ? [parent, readerAttachment] : [readerAttachment], collections: [] };
            }
            // Library context: selected actionable regular items
            const selected = store.get(selectedZoteroItemsAtom);
            const regular = selected.filter((i: Zotero.Item) => i.isRegularItem() && isActionableItem(i));
            return { items: regular.slice(0, 10), collections: [] };
        }
        case 'attachment': {
            // Reader context: attachment open in reader (only if supported)
            const readerAttachment = store.get(currentReaderAttachmentAtom);
            if (readerAttachment && isActionableItem(readerAttachment)) {
                return { items: [readerAttachment], collections: [] };
            }
            // Library context: selected actionable attachments
            const selected = store.get(selectedZoteroItemsAtom);
            const attachments = selected.filter((i: Zotero.Item) => i.isAttachment() && isActionableItem(i));
            return { items: attachments.slice(0, 10), collections: [] };
        }
        case 'collection': {
            // Attach every selected collection, so an action launched over a
            // multi-collection selection reaches the model with all of them.
            return { items: [], collections: selectedCollectionReferences() };
        }
        case 'note': {
            const noteItem = store.get(currentNoteItemAtom);
            if (noteItem) return { items: [noteItem], collections: [] };
            // Fallback: selected notes in library view
            const selectedItems = store.get(selectedZoteroItemsAtom);
            const notes = selectedItems.filter((i: Zotero.Item) => i.isNote());
            return { items: notes.slice(0, 10), collections: [] };
        }
        case 'global':
            return { items: [], collections: [] };
    }
}

// ---------------------------------------------------------------------------
// Resolver Types & Registry
// ---------------------------------------------------------------------------

interface ResolvedVariable {
    /** Text replacement for the placeholder (empty string to just remove it) */
    text: string;
    /** Zotero items to add as message attachments */
    items: Zotero.Item[];
}

type VariableResolver = () => Promise<ResolvedVariable>;

const RESOLVERS: Record<string, VariableResolver> = {
    recent_items:       resolveRecentItems,
    recent_item:        resolveRecentPaper,
    selected_items:     resolveSelectedItems,
    open_attachment:    resolveOpenAttachment,
    open_note:          resolveOpenNote,
    active_item:        resolveActiveItem,
    current_collection: resolveCurrentCollection,
};

// ---------------------------------------------------------------------------
// Item Resolvers (return items, placeholder removed from text)
// ---------------------------------------------------------------------------

async function resolveRecentItems(): Promise<ResolvedVariable> {
    const items = await fetchRecentItems(5);
    return { text: '', items };
}

async function resolveRecentPaper(): Promise<ResolvedVariable> {
    const items = await fetchRecentItems(1);
    return { text: '', items };
}

async function resolveSelectedItems(): Promise<ResolvedVariable> {
    try {
        const zp = Zotero.getActiveZoteroPane?.();
        if (!zp) return { text: '', items: [] };

        const selectedItems: Zotero.Item[] = zp.getSelectedItems?.() || [];
        const regularItems = selectedItems.filter((item: Zotero.Item) => item.isRegularItem() && isActionableItem(item));
        return { text: '', items: regularItems.slice(0, 10) };
    } catch (e) {
        logger(`promptVariables: resolveSelectedItems error: ${e}`, 1);
        return { text: '', items: [] };
    }
}

/** Returns the attachment currently open in the reader */
async function resolveOpenAttachment(): Promise<ResolvedVariable> {
    try {
        const attachment = await getOpenReaderAttachment();
        return { text: '', items: attachment ? [attachment] : [] };
    } catch (e) {
        logger(`promptVariables: resolveOpenAttachment error: ${e}`, 1);
        return { text: '', items: [] };
    }
}

/** Returns the note item currently open in a tab, or empty */
async function resolveOpenNote(): Promise<ResolvedVariable> {
    try {
        const noteItem = store.get(currentNoteItemAtom);
        return { text: '', items: noteItem ? [noteItem] : [] };
    } catch (e) {
        logger(`promptVariables: resolveOpenNote error: ${e}`, 1);
        return { text: '', items: [] };
    }
}

/**
 * Active context item with fallback:
 *   1. Parent item of open attachment (+ the attachment), or just the attachment
 *   2. Note item open in a tab
 *   3. Selected items in library view
 *   4. Most recently added item
 */
async function resolveActiveItem(): Promise<ResolvedVariable> {
    try {
        // Each candidate is filtered before it is accepted, so a candidate in
        // an excluded library falls through to the next step instead of
        // resolving the variable to nothing.

        // 1. Reader: parent item (with attachment) or attachment itself
        const attachment = await getOpenReaderAttachment();
        if (attachment) {
            const parent = attachment.parentItem;
            const items = keepSearchable(parent ? [parent, attachment] : [attachment]);
            if (items.length > 0) {
                return { text: '', items };
            }
        }

        // 2. Note open in a tab
        const noteItem = store.get(currentNoteItemAtom);
        if (noteItem) {
            const items = keepSearchable([noteItem]);
            if (items.length > 0) {
                return { text: '', items };
            }
        }

        // 3. Selected items in library view
        const zp = Zotero.getActiveZoteroPane?.();
        if (zp) {
            const selectedItems: Zotero.Item[] = zp.getSelectedItems?.() || [];
            const regularItems = keepSearchable(
                selectedItems.filter((item: Zotero.Item) => item.isRegularItem() && isActionableItem(item)),
            );
            if (regularItems.length > 0) {
                return { text: '', items: regularItems.slice(0, 10) };
            }
        }

        // 4. Most recently added item (already scoped to a searchable library)
        const recentItems = await fetchRecentItems(1);
        return { text: '', items: recentItems };
    } catch (e) {
        logger(`promptVariables: resolveActiveItem error: ${e}`, 1);
        return { text: '', items: [] };
    }
}

// ---------------------------------------------------------------------------
// Text Resolvers (return text replacement, no items)
// ---------------------------------------------------------------------------

async function resolveCurrentCollection(): Promise<ResolvedVariable> {
    try {
        const names = selectedCollectionReferences()
            .map(ref => ref.name)
            .filter(name => !!name);
        if (names.length === 0) return { text: 'None selected', items: [] };
        return { text: names.map(name => `"${name}"`).join(', '), items: [] };
    } catch (e) {
        logger(`promptVariables: resolveCurrentCollection error: ${e}`, 1);
        return { text: '', items: [] };
    }
}

// ---------------------------------------------------------------------------
// Shared Helpers
// ---------------------------------------------------------------------------

/** Get the attachment item currently open in the reader, or null */
async function getOpenReaderAttachment(): Promise<Zotero.Item | null> {
    const win = Zotero.getMainWindow();
    if (win.Zotero_Tabs?.selectedType !== 'reader') return null;
    const reader = getCurrentReader(win);
    if (!reader?.itemID) return null;
    return await Zotero.Items.getAsync(reader.itemID) || null;
}

/** Fetch the N most recently added regular items from the user's library */
async function fetchRecentItems(limit: number): Promise<Zotero.Item[]> {
    try {
        const libraryID = Zotero.Libraries.userLibraryID;
        // Recent items are queried only from the personal library; if the user
        // excluded it from Beaver, surface nothing.
        if (!store.get(searchableLibraryIdsAtom).includes(libraryID)) return [];
        const itemIDs: number[] = [];

        await Zotero.DB.queryAsync(
            `SELECT i.itemID FROM items i
             LEFT JOIN itemNotes USING (itemID)
             LEFT JOIN itemAttachments USING (itemID)
             LEFT JOIN itemAnnotations USING (itemID)
             WHERE i.libraryID = ?
             AND itemNotes.itemID IS NULL
             AND itemAttachments.itemID IS NULL
             AND itemAnnotations.itemID IS NULL
             AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
             ORDER BY i.dateAdded DESC
             LIMIT ?`,
            [libraryID, limit],
            { onRow: (row: any) => { itemIDs.push(row.getResultByIndex(0) as number); } }
        );

        if (itemIDs.length === 0) return [];
        return await Zotero.Items.getAsync(itemIDs);
    } catch (e) {
        logger(`promptVariables: fetchRecentItems error: ${e}`, 1);
        return [];
    }
}

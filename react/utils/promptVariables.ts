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
 *   {{recent_papers}}      — (items) Last 5 recently added papers
 *   {{recent_paper}}       — (items) Most recently added paper
 *   {{selected_items}}     — (items) Currently selected items in the library view
 *   {{current_collection}} — (text)  Name of the currently selected collection
 */

import { logger } from '../../src/utils/logger';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Metadata for each supported variable (used for UI hints) */
export const PROMPT_VARIABLES: { name: string; description: string }[] = [
    { name: 'recent_papers',      description: 'Last 5 recently added papers' },
    { name: 'recent_paper',       description: 'Most recently added paper' },
    { name: 'selected_items',     description: 'Currently selected items' },
    { name: 'current_collection', description: 'Currently selected collection' },
];

/** Result of resolving prompt variables */
export interface PromptResolution {
    /** The prompt text with placeholders replaced (item placeholders removed) */
    text: string;
    /** Zotero items to add as message attachments */
    items: Zotero.Item[];
}

/**
 * Resolve {{variable}} placeholders in prompt text.
 * Returns the resolved text and any Zotero items that should be added as attachments.
 */
export async function resolvePromptVariables(text: string): Promise<PromptResolution> {
    const pattern = /\{\{(\w+)\}\}/g;
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) return { text, items: [] };

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

    let result = text.replace(pattern, (fullMatch, varName) => {
        const resolution = resolutionMap.get(varName);
        if (!resolution) return fullMatch; // Unknown variable — keep placeholder
        allItems.push(...resolution.items);
        return resolution.text;
    });

    // Clean up formatting artifacts from empty resolutions
    result = result
        .replace(/[ \t]{2,}/g, ' ')     // Collapse multiple spaces
        .replace(/\n{3,}/g, '\n\n')     // Collapse 3+ newlines to 2
        .trim();

    return { text: result, items: allItems };
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
    recent_papers:      resolveRecentPapers,
    recent_paper:       resolveRecentPaper,
    selected_items:     resolveSelectedItems,
    current_collection: resolveCurrentCollection,
};

// ---------------------------------------------------------------------------
// Item Resolvers (return items, placeholder removed from text)
// ---------------------------------------------------------------------------

async function resolveRecentPapers(): Promise<ResolvedVariable> {
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
        const regularItems = selectedItems.filter((item: Zotero.Item) => item.isRegularItem());
        return { text: '', items: regularItems.slice(0, 10) };
    } catch (e) {
        logger(`promptVariables: resolveSelectedItems error: ${e}`, 1);
        return { text: '', items: [] };
    }
}

// ---------------------------------------------------------------------------
// Text Resolvers (return text replacement, no items)
// ---------------------------------------------------------------------------

async function resolveCurrentCollection(): Promise<ResolvedVariable> {
    try {
        const zp = Zotero.getActiveZoteroPane?.();
        if (!zp) return { text: '', items: [] };
        const collection = zp.getSelectedCollection?.();
        return { text: collection?.name ? `"${collection?.name}"` : 'None selected', items: [] };
    } catch (e) {
        logger(`promptVariables: resolveCurrentCollection error: ${e}`, 1);
        return { text: '', items: [] };
    }
}

// ---------------------------------------------------------------------------
// Shared Helpers
// ---------------------------------------------------------------------------

/** Fetch the N most recently added regular items from the user's library */
async function fetchRecentItems(limit: number): Promise<Zotero.Item[]> {
    try {
        const libraryID = Zotero.Libraries.userLibraryID;
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

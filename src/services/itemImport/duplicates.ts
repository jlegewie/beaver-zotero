/**
 * Duplicate check for resolved item JSON, scoped to the target library.
 *
 * Bibliographic matching (DOI, ISBN, then title/creators/year) is
 * `batchFindExistingReferences`. Web content additionally matches an existing
 * item with exactly the same normalized URL, since pages rarely carry an
 * identifier and their titles change.
 */

import type { ZoteroItemJson } from '@beaver/agent-core/types/itemImport';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { logger } from '@beaver/agent-core/platform/logger';
import { batchFindExistingReferences } from '../../utils/batchFindExistingReferences';
import { libraryRefForLibraryID } from '../../utils/libraryIdentity';

export const WEB_CONTENT_ITEM_TYPES = new Set([
    'webpage',
    'blogPost',
    'forumPost',
    'newspaperArticle',
    'magazineArticle',
    'encyclopediaArticle',
    'presentation',
]);

function field(json: ZoteroItemJson, name: string): string | undefined {
    const value = json[name];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** URL variants an existing item may store for the same page (trailing slash on the path, http/https). */
export function urlVariants(url: string): string[] {
    const trimmed = url.trim().replace(/#.*$/, '');
    const variants = new Set<string>([trimmed]);
    // The slash belongs to the path, never to the query string.
    const queryStart = trimmed.indexOf('?');
    const base = queryStart >= 0 ? trimmed.slice(0, queryStart) : trimmed;
    const query = queryStart >= 0 ? trimmed.slice(queryStart) : '';
    variants.add(base.endsWith('/') ? base.slice(0, -1) + query : `${base}/${query}`);
    for (const value of Array.from(variants)) {
        if (value.startsWith('https://')) variants.add('http://' + value.slice(8));
        else if (value.startsWith('http://')) variants.add('https://' + value.slice(7));
    }
    return Array.from(variants);
}

/**
 * Regular items in `libraryID` whose URL field equals one of `urls`, keyed by
 * the matched URL. Attachments (snapshots, linked URLs), notes and annotations
 * are excluded: they are not bibliographic records, and a child attachment's
 * trashed parent would not show up in `deletedItems` for the child itself.
 */
async function findByUrl(urls: string[], libraryID: number): Promise<Map<string, number>> {
    const found = new Map<string, number>();
    if (!urls.length) return found;
    const fieldID = Zotero.ItemFields.getID('url');
    if (!fieldID) return found;
    const noteTypeID = Zotero.ItemTypes.getID('note') || 28;
    const attachmentTypeID = Zotero.ItemTypes.getID('attachment') || 3;
    const annotationTypeID = Zotero.ItemTypes.getID('annotation') || 1;
    const placeholders = urls.map(() => '?').join(', ');
    const sql = 'SELECT items.itemID, itemDataValues.value FROM items '
        + 'JOIN itemData ON itemData.itemID = items.itemID '
        + 'JOIN itemDataValues ON itemDataValues.valueID = itemData.valueID '
        + `WHERE items.libraryID = ? AND itemData.fieldID = ? AND itemDataValues.value IN (${placeholders}) `
        + 'AND items.itemTypeID NOT IN (?, ?, ?) '
        + 'AND items.itemID NOT IN (SELECT itemID FROM deletedItems)';
    await Zotero.DB.queryAsync(sql, [libraryID, fieldID, ...urls, noteTypeID, attachmentTypeID, annotationTypeID], {
        onRow: (row: any) => {
            const value = row.getResultByIndex(1);
            if (!found.has(value)) found.set(value, row.getResultByIndex(0));
        },
    });
    return found;
}

/**
 * Existing items in `libraryID` for each resolved entry, keyed by entry key.
 * Failures are logged and treated as "no duplicate": the check never blocks an import.
 */
export async function findExistingItems(
    entries: Array<{ key: string; json: ZoteroItemJson }>,
    libraryID: number,
): Promise<Map<string, ZoteroItemReference>> {
    const existing = new Map<string, ZoteroItemReference>();
    if (!entries.length) return existing;

    // Web pages without an identifier match on their URL only: generic titles
    // ("About us") would otherwise match unrelated pages.
    const bibliographic = entries.filter(({ json }) =>
        !WEB_CONTENT_ITEM_TYPES.has(json.itemType) || !!field(json, 'DOI') || !!field(json, 'ISBN'));
    try {
        const batch = await batchFindExistingReferences(
            bibliographic.map(({ key, json }) => ({
                id: key,
                // Book sections and conference papers carry the ISBN of the
                // volume they appear in, so only a book is identified by it.
                matchByISBN: json.itemType === 'book',
                data: {
                    title: field(json, 'title'),
                    date: field(json, 'date'),
                    DOI: field(json, 'DOI'),
                    ISBN: field(json, 'ISBN'),
                    creators: (json.creators ?? [])
                        .map((creator) => creator.lastName || creator.name)
                        .filter((name): name is string => !!name),
                },
            })),
            [libraryID],
        );
        for (const result of batch.results) {
            if (result.item) existing.set(result.id, result.item);
        }
    } catch (error) {
        logger(`itemImport/duplicates: reference check failed: ${error}`, 1);
    }

    const webEntries = entries.filter(({ key, json }) =>
        !existing.has(key) && WEB_CONTENT_ITEM_TYPES.has(json.itemType) && field(json, 'url'));
    if (webEntries.length) {
        try {
            const variantsByKey = new Map(webEntries.map(({ key, json }) => [key, urlVariants(field(json, 'url')!)]));
            const matches = await findByUrl(Array.from(new Set(Array.from(variantsByKey.values()).flat())), libraryID);
            for (const [key, variants] of variantsByKey) {
                const itemID = variants.map((variant) => matches.get(variant)).find((id) => id !== undefined);
                if (itemID === undefined) continue;
                const item = await Zotero.Items.getAsync(itemID);
                if (item) {
                    existing.set(key, {
                        library_id: item.libraryID,
                        zotero_key: item.key,
                        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
                    });
                }
            }
        } catch (error) {
            logger(`itemImport/duplicates: URL check failed: ${error}`, 1);
        }
    }
    return existing;
}

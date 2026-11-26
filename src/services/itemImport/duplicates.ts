/**
 * Duplicate check for resolved item JSON, scoped to the target library.
 *
 * Bibliographic matching (DOI, ISBN, a PubMed id in Extra, a trial's registry
 * URL or report number, then title/creators/year) is
 * `batchFindExistingReferences`, which also matches a record's URL. Web content
 * without an identifier matches on its URL only (`findItemsByUrl`, the same
 * normalized comparison), since pages rarely carry an identifier and their
 * titles change.
 */

import { itemJsonPmid, type ZoteroItemJson } from '@beaver/agent-core/types/itemImport';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { logger } from '@beaver/agent-core/platform/logger';
import { batchFindExistingReferences } from '../../utils/batchFindExistingReferences';
import { findItemsByUrl } from '../../utils/findItemsByUrl';

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
        !WEB_CONTENT_ITEM_TYPES.has(json.itemType) || !!field(json, 'DOI') || !!field(json, 'ISBN')
        || !!itemJsonPmid(json));
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
                    PMID: itemJsonPmid(json),
                    url: field(json, 'url'),
                    reportNumber: field(json, 'reportNumber'),
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

    // The bibliographic check already matched the others' URLs.
    const webEntries = entries.filter((entry) =>
        !bibliographic.includes(entry) && WEB_CONTENT_ITEM_TYPES.has(entry.json.itemType) && field(entry.json, 'url'));
    if (webEntries.length) {
        try {
            const matches = await findItemsByUrl(webEntries.map(({ key, json }) => ({ id: key, url: field(json, 'url')! })), [libraryID]);
            for (const [key, match] of matches) existing.set(key, match);
        } catch (error) {
            logger(`itemImport/duplicates: URL check failed: ${error}`, 1);
        }
    }
    return existing;
}

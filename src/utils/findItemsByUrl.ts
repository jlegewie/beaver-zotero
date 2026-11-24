/**
 * Find library items by the web page their URL field names.
 *
 * Both sides are compared in the normalized form behind `web-` ids
 * (`normalizeWebUrl`: scheme and host case, default port, fragment and
 * tracking parameters do not count), and each requested URL also matches its
 * http/https and trailing-slash variants (`urlVariants`), which are how the
 * same page is most often saved twice.
 *
 * Only regular items match: attachments (snapshots, linked URLs), notes and
 * annotations are not bibliographic records, and a child attachment of a
 * trashed item is not itself in `deletedItems`.
 */

import { tryNormalizeWebUrl } from '@beaver/agent-core/identity/webPages';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { logger } from '@beaver/agent-core/platform/logger';
import { libraryRefForLibraryID } from './libraryIdentity';

/** Hosts per query: each adds one LIKE clause. */
const HOSTS_PER_QUERY = 50;

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

/** The lowercased host of a normalized URL. */
function hostOf(normalized: string): string | null {
    const match = /^https?:\/\/(?:[^@/?]*@)?(\[[^\]]*\]|[^/:?]+)/.exec(normalized);
    return match ? match[1] : null;
}

/**
 * The first regular item in `libraryIds` whose URL names the same page as each
 * request, keyed by request id. A failed query is logged and matches nothing.
 */
export async function findItemsByUrl(
    requests: Array<{ id: string; url: string }>,
    libraryIds: number[],
): Promise<Map<string, ZoteroItemReference>> {
    const results = new Map<string, ZoteroItemReference>();
    if (!requests.length || !libraryIds.length) return results;
    const fieldID = Zotero.ItemFields.getID('url');
    if (!fieldID) return results;

    // Each request's own URL (exact) and its spellings (variants), normalized.
    const idsByUrl = new Map<string, Array<{ id: string; exact: boolean }>>();
    for (const { id, url } of requests) {
        const own = tryNormalizeWebUrl(url);
        for (const variant of urlVariants(url)) {
            const normalized = tryNormalizeWebUrl(variant);
            if (!normalized) continue;
            const ids = idsByUrl.get(normalized) ?? [];
            if (!ids.some((entry) => entry.id === id)) idsByUrl.set(normalized, [...ids, { id, exact: normalized === own }]);
        }
    }
    // An item storing the request's own URL wins over one storing a variant.
    const exactMatches = new Set<string>();
    const hosts = Array.from(new Set(Array.from(idsByUrl.keys()).map(hostOf).filter((host): host is string => !!host)));
    if (!hosts.length) return results;

    const excludedTypes = [
        Zotero.ItemTypes.getID('note') || 28,
        Zotero.ItemTypes.getID('attachment') || 3,
        Zotero.ItemTypes.getID('annotation') || 1,
    ];
    const libraryPlaceholders = libraryIds.map(() => '?').join(', ');
    for (let start = 0; start < hosts.length; start += HOSTS_PER_QUERY) {
        const chunk = hosts.slice(start, start + HOSTS_PER_QUERY);
        // The host narrows the scan; the comparison itself is on normalized URLs.
        const sql = `
            SELECT i.libraryID, i.key, idv.value
            FROM items i
            JOIN itemData id ON i.itemID = id.itemID
            JOIN itemDataValues idv ON id.valueID = idv.valueID
            WHERE i.libraryID IN (${libraryPlaceholders})
            AND id.fieldID = ?
            AND (${chunk.map(() => 'idv.value LIKE ?').join(' OR ')})
            AND i.itemTypeID NOT IN (?, ?, ?)
            AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
            ORDER BY i.itemID
        `;
        try {
            await Zotero.DB.queryAsync(sql, [...libraryIds, fieldID, ...chunk.map((host) => `%${host}%`), ...excludedTypes], {
                onRow: (row: any) => {
                    const normalized = tryNormalizeWebUrl(String(row.getResultByIndex(2) ?? ''));
                    const ids = normalized ? idsByUrl.get(normalized) : undefined;
                    if (!ids) return;
                    const libraryID = row.getResultByIndex(0);
                    const key = row.getResultByIndex(1);
                    for (const { id, exact } of ids) {
                        if (exactMatches.has(id) || (results.has(id) && !exact)) continue;
                        if (exact) exactMatches.add(id);
                        results.set(id, {
                            library_id: libraryID,
                            zotero_key: key,
                            library_ref: libraryRefForLibraryID(libraryID) ?? undefined,
                        });
                    }
                },
            });
        } catch (error) {
            logger(`findItemsByUrl: URL query failed: ${error}`, 1);
        }
    }
    return results;
}

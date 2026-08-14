/**
 * Per-scope change markers for a library, served on `list_libraries` as
 * `LibrarySummary.versions`.
 *
 * A client without a local Zotero (the Word add-in) caches a library's
 * collections and tags and needs an answer to "is my copy still good?". A TTL
 * is a guess and reconnect-invalidation is not enough, since Zotero stays
 * connected while the user creates a collection.
 *
 * Two properties make these usable:
 *
 * - **Opaque.** The client compares strings and re-fetches on a mismatch. How
 *   they are computed is free to change without a wire change, so nothing here
 *   is part of the contract except "it changes when the scope changes".
 * - **Per scope.** A collection cache must not be invalidated by an item edit,
 *   which is why this is not Zotero's `libraryVersion` — that bumps on any
 *   change, so for an actively-working user it would invalidate constantly.
 *
 * The markers are computed from the database at request time rather than kept
 * as notifier-driven counters, so they survive a plugin restart and cannot go
 * stale by missing an event. The trap they have to avoid is building on
 * `version` alone: that is the *server* version, and a locally-created or
 * locally-renamed collection carries version 0 until it syncs — exactly the
 * change a picker most needs to notice. Every local save updates
 * `clientDateModified`, so the collection marker leans on that, and the tag
 * marker on the itemTags rows themselves, which local edits change directly.
 */

import { logger } from '@beaver/agent-core/platform/logger';
import type { LibraryScopeVersions } from '@beaver/agent-core/protocol/agentProtocol';

/** FNV-1a offset basis. */
const HASH_SEED = 0x811c9dc5;

/**
 * Fold a string into a running FNV-1a hash.
 *
 * Order-dependent, so callers feed rows in a fixed order. A collision only
 * costs a missed refresh, and the inputs here are short structured strings.
 */
function hashInto(seed: number, value: string): number {
    let hash = seed;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
}

/** FNV-1a over one string, base36. Keeps user content out of a marker. */
function hashString(value: string): string {
    return hashInto(HASH_SEED, value).toString(36);
}

/**
 * Marker for the library's collections: a checksum of the rows themselves.
 *
 * Every field `list_collections` renders is in the hash — the id (which the
 * key and the row's identity follow from), the name and the parent — so the
 * marker changes exactly when the listing would, with no argument about which
 * mutation a given aggregate happens to catch. Aggregates were the wrong tool
 * here: `version` stays 0 for a local edit, `clientDateModified` has
 * second resolution, and sums cancel (renaming to a same-length name moves
 * nothing). A library has hundreds of collections at most, so hashing them all
 * is cheaper than the argument.
 *
 * Trashed collections are excluded, as they are from the listing.
 */
async function collectionsVersion(libraryId: number): Promise<string | undefined> {
    try {
        // Ordered, because the hash is order-dependent.
        const sql = `
            SELECT collectionID, collectionName, COALESCE(parentCollectionID, 0)
            FROM collections
            WHERE libraryID = ?
            AND collectionID NOT IN (SELECT collectionID FROM deletedCollections)
            ORDER BY collectionID
        `;
        let count = 0;
        let hash = HASH_SEED;
        await Zotero.DB.queryAsync(sql, [libraryId], {
            onRow: (row: any) => {
                count++;
                hash = hashInto(
                    hash,
                    `${row.getResultByIndex(0)}|${row.getResultByIndex(1)}|${row.getResultByIndex(2)}`
                );
            },
        });
        return `${count}:${hash.toString(36)}`;
    } catch (error) {
        logger(`getLibraryVersions: Error fingerprinting collections for library ${libraryId}: ${error}`, 2);
        return undefined;
    }
}

/**
 * Colored tags, as a marker component.
 *
 * Colors are part of what `list_tags` returns but live in synced settings
 * rather than in the tag rows, so nothing else here would notice a recolor.
 * Hashed because the input is user content — tag names — and a marker is
 * supposed to be opaque.
 */
function tagColorsMarker(libraryId: number): string {
    const colors = Zotero.Tags.getColors(libraryId);
    if (!colors || colors.size === 0) {
        return '';
    }
    const serialized = Array.from(colors.entries())
        .map(([name, info]: [string, any]) => `${name}=${info?.color ?? ''}`)
        .sort()
        .join(',');
    return hashString(serialized);
}

/**
 * Marker for the library's tags.
 *
 * Hashes the same grouped data `list_tags` reports: each tag's name and its
 * regular-item, attachment, note and annotation counts. Global aggregates are
 * insufficient here because different per-tag distributions can have the same
 * totals and weighted sums. The database still does the grouping, so only one
 * row per visible tag crosses into JavaScript rather than every assignment.
 *
 * Assignments to trashed objects are excluded, as they are from the listing.
 */
async function tagsVersion(libraryId: number): Promise<string | undefined> {
    try {
        // Ordered, because the hash is order-dependent. The type joins are 1:1
        // on itemID, so they do not multiply rows.
        const sql = `
            SELECT T.tagID, T.name,
                SUM(CASE WHEN IA.itemID IS NULL AND INo.itemID IS NULL AND IAn.itemID IS NULL THEN 1 ELSE 0 END),
                SUM(CASE WHEN IA.itemID IS NOT NULL THEN 1 ELSE 0 END),
                SUM(CASE WHEN INo.itemID IS NOT NULL THEN 1 ELSE 0 END),
                SUM(CASE WHEN IAn.itemID IS NOT NULL THEN 1 ELSE 0 END)
            FROM itemTags IT
            JOIN tags T ON IT.tagID = T.tagID
            JOIN items I ON IT.itemID = I.itemID
            LEFT JOIN itemAttachments IA ON I.itemID = IA.itemID
            LEFT JOIN itemNotes INo ON I.itemID = INo.itemID
            LEFT JOIN itemAnnotations IAn ON I.itemID = IAn.itemID
            WHERE I.libraryID = ?
            AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
            GROUP BY T.tagID, T.name
            ORDER BY T.tagID
        `;
        let count = 0;
        let hash = HASH_SEED;
        await Zotero.DB.queryAsync(sql, [libraryId], {
            onRow: (row: any) => {
                count++;
                const values = Array.from({ length: 6 }, (_, index) => row.getResultByIndex(index));
                hash = hashInto(hash, JSON.stringify(values));
            },
        });
        return `${count}:${hash.toString(36)}:${tagColorsMarker(libraryId)}`;
    } catch (error) {
        logger(`getLibraryVersions: Error fingerprinting tags for library ${libraryId}: ${error}`, 2);
        return undefined;
    }
}

/**
 * Compute the change markers for one library.
 *
 * A scope whose marker could not be computed is left out rather than filled
 * with a placeholder: a client reads an absent marker as "no freshness oracle
 * for this scope" and skips caching it, which a stand-in value would turn into
 * a stale cache that never refreshes.
 */
export async function getLibraryVersions(libraryId: number): Promise<LibraryScopeVersions | undefined> {
    const [collections, tags] = await Promise.all([
        collectionsVersion(libraryId),
        tagsVersion(libraryId),
    ]);

    if (collections === undefined && tags === undefined) {
        return undefined;
    }
    const versions: LibraryScopeVersions = {};
    if (collections !== undefined) versions.collections = collections;
    if (tags !== undefined) versions.tags = tags;
    return versions;
}

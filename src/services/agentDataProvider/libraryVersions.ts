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

/**
 * FNV-1a over a string, base36.
 *
 * Keeps a marker component opaque and short when it would otherwise embed user
 * content (tag names). A collision only costs a missed refresh, and these
 * inputs are a handful of short strings.
 */
function hashString(value: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/** Read one row of aggregates, by column index. */
async function queryAggregates(sql: string, params: any[], columns: number): Promise<string[] | null> {
    let values: string[] | null = null;
    await Zotero.DB.queryAsync(sql, params, {
        onRow: (row: any) => {
            const read: string[] = [];
            for (let i = 0; i < columns; i++) {
                read.push(String(row.getResultByIndex(i) ?? ''));
            }
            values = read;
        },
    });
    return values;
}

/**
 * Marker for the library's collections.
 *
 * Covers every way the collection list can change: creation and deletion move
 * the count and the max id, a rename or a move updates `clientDateModified`,
 * and `version` is included so a change pulled in by sync registers even if it
 * lands with an unchanged local timestamp.
 *
 * `clientDateModified` is only second-resolution, so the name and parent sums
 * carry the marker when two edits land inside one second — a rename that
 * changes the name's length, and any move, still move the value.
 *
 * Trashed collections are excluded, as they are from the listing, so trashing
 * or restoring one moves the count and the sums rather than resting on the
 * timestamp alone.
 */
async function collectionsVersion(libraryId: number): Promise<string | undefined> {
    try {
        const sql = `
            SELECT COUNT(*),
                COALESCE(MAX(collectionID), 0),
                COALESCE(MAX(version), 0),
                COALESCE(MAX(clientDateModified), ''),
                COALESCE(SUM(LENGTH(collectionName)), 0),
                COALESCE(SUM(COALESCE(parentCollectionID, 0)), 0)
            FROM collections
            WHERE libraryID = ?
            AND collectionID NOT IN (SELECT collectionID FROM deletedCollections)
        `;
        const values = await queryAggregates(sql, [libraryId], 6);
        return values ? values.join(':') : undefined;
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
 * Counted over the same rows `list_tags` reports on — tag assignments to
 * non-trashed objects — so trashing a tagged item registers as a change, as it
 * does in the listing. The assignment count moves whenever a tag is added to or
 * removed from anything, which is also what the per-tag counts in the listing
 * are built from.
 *
 * A rename repoints assignments at a different tag row, so it is caught by the
 * id sum rather than by the counts. The sum, not the maximum: `tags.name` is
 * unique across the whole database, so renaming to a name another library
 * already uses reuses that row's id — which can be lower than the one it
 * replaces, leaving every count and the maximum untouched.
 */
async function tagsVersion(libraryId: number): Promise<string | undefined> {
    try {
        const sql = `
            SELECT COUNT(*),
                COUNT(DISTINCT IT.tagID),
                COALESCE(MAX(IT.tagID), 0),
                COALESCE(SUM(IT.tagID), 0)
            FROM itemTags IT
            JOIN items I ON IT.itemID = I.itemID
            WHERE I.libraryID = ?
            AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
        `;
        const values = await queryAggregates(sql, [libraryId], 4);
        return values ? [...values, tagColorsMarker(libraryId)].join(':') : undefined;
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

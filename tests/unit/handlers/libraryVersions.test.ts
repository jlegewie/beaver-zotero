/**
 * `getLibraryVersions` — the cache-freshness markers on `list_libraries`.
 *
 * A client caches a library's collections and tags and re-fetches when the
 * marker changes, so the contract worth pinning is the one that makes that
 * safe: the marker must move for every change the corresponding listing would
 * show — including the local, unsynced ones a `version` column misses, and the
 * ones that leave every total untouched — and it must be absent, never a
 * placeholder, when it cannot be computed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { getLibraryVersions } from '../../../src/services/agentDataProvider/libraryVersions';

/** One collection row: id, name, parent id (0 for a top-level collection). */
type CollectionRow = [number, string, number];

/** One grouped tag row: id, name, then counts by object type. */
type TagRow = [number, string, number, number, number, number];

const queryAsync = vi.fn();
const getColors = vi.fn();

function isCollectionsQuery(sql: string): boolean {
    return sql.includes('FROM collections');
}

/** Serve the ordered collection and grouped tag rows. */
function serve(collections: CollectionRow[], tags: TagRow[]) {
    queryAsync.mockImplementation(async (sql: string, _params: any[], opts: any) => {
        if (isCollectionsQuery(sql)) {
            for (const row of collections) {
                opts.onRow({ getResultByIndex: (i: number) => row[i] });
            }
            return;
        }
        for (const row of tags) {
            opts.onRow({ getResultByIndex: (i: number) => row[i] });
        }
    });
}

/** Three collections, one of them nested. */
const COLLECTIONS: CollectionRow[] = [
    [10, 'Papers', 0],
    [11, 'Methods', 10],
    [12, 'Teaching', 0],
];

/** Two tags carried only by regular items. */
const TAGS: TagRow[] = [
    [55, 'methods', 4, 0, 0, 0],
    [326, 'teaching', 5, 0, 0, 0],
];

beforeEach(() => {
    vi.clearAllMocks();
    getColors.mockReturnValue(new Map());
    const zotero = (globalThis as any).Zotero;
    zotero.DB = { queryAsync };
    zotero.Tags = { getColors };
    serve(COLLECTIONS, TAGS);
});

describe('getLibraryVersions collections', () => {
    it('changes when a collection is renamed, even to a name of the same length', async () => {
        const before = (await getLibraryVersions(1))?.collections;

        // A local rename leaves `version` at 0, and clientDateModified only has
        // second resolution — so a marker built on aggregates could miss this.
        serve([[10, 'Drafts', 0], COLLECTIONS[1], COLLECTIONS[2]], TAGS);

        expect((await getLibraryVersions(1))?.collections).not.toBe(before);
    });

    it('changes when a collection is moved under another', async () => {
        const before = (await getLibraryVersions(1))?.collections;

        serve([COLLECTIONS[0], COLLECTIONS[1], [12, 'Teaching', 10]], TAGS);

        expect((await getLibraryVersions(1))?.collections).not.toBe(before);
    });

    it('changes when a collection is added or removed', async () => {
        const before = (await getLibraryVersions(1))?.collections;

        serve(COLLECTIONS.slice(0, 2), TAGS);

        expect((await getLibraryVersions(1))?.collections).not.toBe(before);
    });

    it('holds steady when nothing changed', async () => {
        const before = (await getLibraryVersions(1))?.collections;

        expect((await getLibraryVersions(1))?.collections).toBe(before);
    });

    it('reads the rows in a fixed order, since the checksum depends on it', async () => {
        await getLibraryVersions(1);

        const sql = queryAsync.mock.calls.map(([s]) => s).find(isCollectionsQuery);
        expect(sql).toContain('ORDER BY collectionID');
        // Scoped to what the listing shows, so trashing one is a change.
        expect(sql).toContain('NOT IN (SELECT collectionID FROM deletedCollections)');
    });
});

describe('getLibraryVersions tags', () => {
    it('changes when a tag is added to one more object', async () => {
        const before = (await getLibraryVersions(1))?.tags;

        serve(COLLECTIONS, [TAGS[0], [326, 'teaching', 6, 0, 0, 0]]);

        expect((await getLibraryVersions(1))?.tags).not.toBe(before);
    });

    it('changes when a rename repoints assignments at a lower tag id', async () => {
        const before = (await getLibraryVersions(1))?.tags;

        // Zotero may repoint the assignments to an existing tag row when the
        // new name already exists elsewhere in the database.
        serve(COLLECTIONS, [[12, 'approaches', 4, 0, 0, 0], TAGS[1]]);

        expect((await getLibraryVersions(1))?.tags).not.toBe(before);
    });

    it('changes when an assignment moves from an item to an attachment', async () => {
        const before = (await getLibraryVersions(1))?.tags;

        serve(COLLECTIONS, [[55, 'methods', 3, 1, 0, 0], TAGS[1]]);

        expect((await getLibraryVersions(1))?.tags).not.toBe(before);
    });

    it('changes when per-tag counts change but every aggregate sum stays equal', async () => {
        const distributed: TagRow[] = [
            [1, 'one', 1, 0, 0, 0],
            [2, 'two', 3, 0, 0, 0],
            [3, 'three', 1, 0, 0, 0],
        ];
        serve(COLLECTIONS, distributed);
        const before = (await getLibraryVersions(1))?.tags;

        // Both states have five assignments, three distinct tags and a
        // tag-ID-weighted sum of 10. Only the grouped counts differ.
        serve(COLLECTIONS, [
            [1, 'one', 2, 0, 0, 0],
            [2, 'two', 1, 0, 0, 0],
            [3, 'three', 2, 0, 0, 0],
        ]);

        expect((await getLibraryVersions(1))?.tags).not.toBe(before);
    });

    it('is library-wide: unmoved by a collection membership change', async () => {
        // Moving an already-tagged item into or out of a collection leaves
        // every grouped row identical — the item still exists, still carries
        // the tag — so the marker cannot see it, and a `collection_key`-scoped
        // list_tags response would go stale under it.
        //
        // Deliberate: folding membership in would invalidate every
        // library-wide tag cache on any item move, losing the per-scope
        // precision these markers exist for. The wire contract narrows instead
        // (LibraryScopeVersions.tags), so this pins the boundary rather than a
        // bug. Widening the marker means changing that contract too.
        const before = (await getLibraryVersions(1))?.tags;

        // The query has no collection join, so a membership change produces
        // exactly the same rows.
        serve(COLLECTIONS, TAGS);

        expect((await getLibraryVersions(1))?.tags).toBe(before);
    });

    it('changes when a tag colour changes', async () => {
        const before = (await getLibraryVersions(1))?.tags;

        getColors.mockReturnValue(new Map([['methods', { color: '#FF6666', position: 0 }]]));

        expect((await getLibraryVersions(1))?.tags).not.toBe(before);
    });

    it('keeps user content out of the marker', async () => {
        getColors.mockReturnValue(new Map([['methods', { color: '#FF6666', position: 0 }]]));

        // The markers travel to the backend and are documented as opaque, so
        // the colour component is hashed rather than spelled out.
        expect((await getLibraryVersions(1))?.tags).not.toContain('methods');
    });

    it('counts only assignments on non-trashed objects, as the listing does', async () => {
        await getLibraryVersions(1);

        const sql = queryAsync.mock.calls.map(([s]) => s).find((s) => !isCollectionsQuery(s));
        expect(sql).toContain('NOT IN (SELECT itemID FROM deletedItems)');
        // The per-type split the listing reports needs these joins.
        expect(sql).toContain('LEFT JOIN itemAttachments');
        expect(sql).toContain('LEFT JOIN itemNotes');
        expect(sql).toContain('LEFT JOIN itemAnnotations');
        expect(sql).toContain('GROUP BY T.tagID, T.name');
        expect(sql).toContain('ORDER BY T.tagID');
    });
});

describe('getLibraryVersions failures', () => {
    it('returns a marker per scope, kept independent', async () => {
        const versions = await getLibraryVersions(1);

        expect(versions?.collections).toBeTruthy();
        expect(versions?.tags).toBeTruthy();
        // A tag edit must not invalidate a collection cache, which is the whole
        // reason these are not one library version.
        expect(versions?.collections).not.toBe(versions?.tags);
    });

    it('omits a scope it could not compute instead of inventing one', async () => {
        queryAsync.mockImplementation(async (sql: string, _params: any[], opts: any) => {
            if (isCollectionsQuery(sql)) throw new Error('db is busy');
            for (const row of TAGS) {
                opts.onRow({ getResultByIndex: (i: number) => row[i] });
            }
        });

        const versions = await getLibraryVersions(1);

        expect(versions).not.toHaveProperty('collections');
        expect(versions?.tags).toBeTruthy();
    });

    it('returns nothing at all when no scope could be computed', async () => {
        queryAsync.mockRejectedValue(new Error('db is busy'));

        await expect(getLibraryVersions(1)).resolves.toBeUndefined();
    });
});

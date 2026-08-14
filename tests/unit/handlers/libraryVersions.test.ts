/**
 * `getLibraryVersions` — the cache-freshness markers on `list_libraries`.
 *
 * A client caches a library's collections and tags and re-fetches when the
 * marker changes, so the contract worth pinning is the one that makes that
 * safe: the marker must move for every change the corresponding listing would
 * show — including the local, unsynced ones a `version` column misses — and it
 * must be absent, never a placeholder, when it cannot be computed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { getLibraryVersions } from '../../../src/services/agentDataProvider/libraryVersions';

/** Columns of the single aggregate row each fingerprint query returns. */
type Row = (string | number)[];

const queryAsync = vi.fn();
const getColors = vi.fn();

function isCollectionsQuery(sql: string): boolean {
    return sql.includes('FROM collections');
}

/** Serve one row per fingerprint query. */
function serve(collections: Row, tags: Row) {
    queryAsync.mockImplementation(async (sql: string, _params: any[], opts: any) => {
        const values = isCollectionsQuery(sql) ? collections : tags;
        opts.onRow({ getResultByIndex: (i: number) => values[i] });
    });
}

/**
 * A library with three collections and two tags, at rest.
 *
 * Collections: count, max id, max version, max clientDateModified, name-length
 * sum, parent-id sum. Tags: assignment count, distinct tags, max tag id, tag-id
 * sum.
 */
const COLLECTIONS: Row = [3, 12, 40, '2026-08-13 10:00:00', 26, 12];
// Tag 55 on four objects and tag 326 on five: 4*55 + 5*326 = 1850.
const TAGS: Row = [9, 2, 326, 1850];

beforeEach(() => {
    vi.clearAllMocks();
    getColors.mockReturnValue(new Map());
    const zotero = (globalThis as any).Zotero;
    zotero.DB = { queryAsync };
    zotero.Tags = { getColors };
    serve(COLLECTIONS, TAGS);
});

describe('getLibraryVersions', () => {
    it('returns a marker per scope', async () => {
        const versions = await getLibraryVersions(1);

        expect(versions?.collections).toBeTruthy();
        expect(versions?.tags).toBeTruthy();
        // Scopes are independent: a tag edit must not invalidate a collection
        // cache, which is the whole reason these are not one library version.
        expect(versions?.collections).not.toBe(versions?.tags);
    });

    it('changes the collection marker for a local rename, which leaves version at 0', async () => {
        const before = (await getLibraryVersions(1))?.collections;

        // A locally-renamed collection keeps its server version and its id, and
        // the count is unchanged — only clientDateModified and the name move.
        serve([3, 12, 40, '2026-08-13 11:30:00', 29, 12], TAGS);

        expect((await getLibraryVersions(1))?.collections).not.toBe(before);
    });

    it('changes the collection marker for a rename inside the timestamp resolution', async () => {
        const before = (await getLibraryVersions(1))?.collections;

        // clientDateModified is only second-resolution, so a second edit in the
        // same second must still be caught — here by the name-length sum.
        serve([3, 12, 40, '2026-08-13 10:00:00', 31, 12], TAGS);

        expect((await getLibraryVersions(1))?.collections).not.toBe(before);
    });

    it('changes the collection marker when a collection is moved under another', async () => {
        const before = (await getLibraryVersions(1))?.collections;

        // Same collections, same names, same second — only the parent changed.
        serve([3, 12, 40, '2026-08-13 10:00:00', 26, 15], TAGS);

        expect((await getLibraryVersions(1))?.collections).not.toBe(before);
    });

    it('changes the collection marker when a collection is added or removed', async () => {
        const before = (await getLibraryVersions(1))?.collections;

        serve([4, 13, 40, '2026-08-13 10:00:00', 34, 12], TAGS);

        expect((await getLibraryVersions(1))?.collections).not.toBe(before);
    });

    it('changes the tag marker when a tag is added to one more item', async () => {
        const before = (await getLibraryVersions(1))?.tags;

        // Same tags in the library, one more assignment — which is what the
        // per-tag counts in the listing are built from.
        serve(COLLECTIONS, [10, 2, 326, 1850 + 326]);

        expect((await getLibraryVersions(1))?.tags).not.toBe(before);
    });

    it('changes the tag marker when a rename repoints assignments at a lower tag id', async () => {
        const before = (await getLibraryVersions(1))?.tags;

        // `tags.name` is unique database-wide, so renaming to a name another
        // library already uses reuses that row's id. Tag 55's four assignments
        // move to tag 12: the assignment count, the distinct count and the
        // maximum are all unchanged, and only the id sum notices.
        serve(COLLECTIONS, [9, 2, 326, 1850 - 4 * (55 - 12)]);

        expect((await getLibraryVersions(1))?.tags).not.toBe(before);
    });

    it('changes the tag marker when a tag colour changes', async () => {
        const before = (await getLibraryVersions(1))?.tags;

        getColors.mockReturnValue(new Map([['methods', { color: '#FF6666', position: 0 }]]));

        expect((await getLibraryVersions(1))?.tags).not.toBe(before);
    });

    it('counts only what the listings report on, so trashing moves a marker', async () => {
        await getLibraryVersions(1);

        const sqls: string[] = queryAsync.mock.calls.map(([sql]) => sql);
        expect(sqls.find(isCollectionsQuery)).toContain(
            'NOT IN (SELECT collectionID FROM deletedCollections)'
        );
        expect(sqls.find((sql) => !isCollectionsQuery(sql))).toContain(
            'NOT IN (SELECT itemID FROM deletedItems)'
        );
    });

    it('keeps user content out of the marker', async () => {
        getColors.mockReturnValue(new Map([['methods', { color: '#FF6666', position: 0 }]]));

        // The markers travel to the backend and are documented as opaque, so
        // the colour component is hashed rather than spelled out.
        expect((await getLibraryVersions(1))?.tags).not.toContain('methods');
    });

    it('aggregates the columns the cases above depend on', async () => {
        // The scenarios are expressed in mocked rows, so without this a marker
        // built from the wrong columns would still pass them all.
        await getLibraryVersions(1);

        const sqls: string[] = queryAsync.mock.calls.map(([sql]) => sql);
        const collectionsSql = sqls.find(isCollectionsQuery);
        const tagsSql = sqls.find((sql) => !isCollectionsQuery(sql));

        expect(collectionsSql).toContain('MAX(clientDateModified)');
        expect(collectionsSql).toContain('SUM(LENGTH(collectionName))');
        expect(collectionsSql).toContain('SUM(COALESCE(parentCollectionID, 0))');
        expect(tagsSql).toContain('COUNT(DISTINCT IT.tagID)');
        expect(tagsSql).toContain('SUM(IT.tagID)');
    });

    it('omits a scope it could not compute instead of inventing one', async () => {
        queryAsync.mockImplementation(async (sql: string, _params: any[], opts: any) => {
            if (isCollectionsQuery(sql)) throw new Error('db is busy');
            opts.onRow({ getResultByIndex: (i: number) => TAGS[i] });
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

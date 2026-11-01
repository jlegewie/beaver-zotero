import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDBConnection } from '../../../mocks/mockDBConnection';

const engine = vi.hoisted(() => ({ value: 'word_index' as 'fts5' | 'word_index' | 'none' }));
const coverageReads = vi.hoisted(() => ({ count: 0 }));

vi.mock('../../../../src/services/zoteroFulltext/zoteroIndex', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/services/zoteroFulltext/zoteroIndex')>();
    return {
        ...actual,
        detectEngine: async () => engine.value,
        countLibraryCoverage: (...args: Parameters<typeof actual.countLibraryCoverage>) => {
            coverageReads.count++;
            return actual.countLibraryCoverage(...args);
        },
    };
});
vi.mock('../../../../src/services/zoteroFulltext/languages', () => ({
    countLibraryLanguages: async () => new Map([['de', 10]]),
    prominentLanguages: (counts: Map<string, number>) => [...counts.keys()],
}));

import { getZoteroFulltextState, resetZoteroFulltextStateCache } from '../../../../src/services/zoteroFulltext/state';
import { listScopeAttachments } from '../../../../src/services/zoteroFulltext/zoteroIndex';

let db: MockDBConnection;

async function add(id: number, libraryID: number, options: {
    mime?: string; path?: string; fulltext?: [number | null, number | null, number | null, number | null, number?];
} = {}) {
    await db.queryAsync('INSERT INTO items VALUES (?, ?, ?)', [id, libraryID, `KEY${String(id).padStart(5, '0')}`]);
    await db.queryAsync('INSERT INTO itemAttachments VALUES (?, 0, 0, ?, ?, NULL)', [
        id, options.mime ?? 'application/pdf', options.path ?? 'storage:file.pdf',
    ]);
    if (options.fulltext) {
        const [indexedPages, totalPages, indexedChars, totalChars, synced = 0] = options.fulltext;
        await db.queryAsync('INSERT INTO fulltextItems VALUES (?, ?, ?, ?, ?, ?)', [id, indexedPages, totalPages, indexedChars, totalChars, synced]);
    }
}

describe('getZoteroFulltextState', () => {
    beforeEach(async () => {
        engine.value = 'word_index';
        coverageReads.count = 0;
        resetZoteroFulltextStateCache();
        db = new MockDBConnection();
        await db.queryAsync('CREATE TABLE items (itemID INTEGER PRIMARY KEY, libraryID INTEGER, key TEXT)');
        await db.queryAsync('CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INTEGER, linkMode INTEGER, contentType TEXT, path TEXT, storageHash TEXT)');
        await db.queryAsync('CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY)');
        await db.queryAsync('CREATE TABLE fulltextItems (itemID INTEGER PRIMARY KEY, indexedPages INT, totalPages INT, indexedChars INT, totalChars INT, synced INT)');
        Object.assign(Zotero, {
            DB: db,
            Libraries: { userLibraryID: 1 },
            Groups: { getGroupIDFromLibraryID: (id: number) => (id === 2 ? 7 : false) },
            Attachments: { LINK_MODE_LINKED_URL: 3 },
            Beaver: { libraryScopeInitialized: true, searchableLibraryIds: [1, 2] },
        });
        await add(1, 1, { fulltext: [10, 10, null, null] });
        await add(2, 1, { fulltext: [5, 10, null, null] });
        await add(3, 1, { mime: 'application/epub+zip', path: 'storage:book.epub', fulltext: [null, null, 100, 100] });
        await add(4, 1, { fulltext: [3, 3, null, null, 4] });
        await add(5, 1);
        await add(6, 1, { fulltext: [1, 1, null, null] });
        await db.queryAsync('INSERT INTO deletedItems VALUES (6)');
        await add(7, 1, { mime: 'text/plain', path: 'storage:notes.txt', fulltext: [null, null, 5, 5] });
        await add(8, 2, { mime: 'text/html', path: 'storage:page.html', fulltext: [null, null, 0, 50] });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await db.closeDatabase();
    });

    it('counts each library with one aggregate that agrees with the scope listing', async () => {
        const state = await getZoteroFulltextState();
        expect(state?.libraries).toEqual([
            { library_ref: 'u', total: 5, indexed: 3, partial: 1 },
            { library_ref: 'g7', total: 1, indexed: 0, partial: 0 },
        ]);
        const listed = await listScopeAttachments({ libraryIds: [1] }, 'word_index');
        expect(listed.length).toBe(5);
        expect(listed.filter((a) => a.indexed).length).toBe(3);
        expect(listed.filter((a) => a.partial).length).toBe(1);
    });

    it('counts an attachment as indexed on FTS5 only once it is in the content index', async () => {
        engine.value = 'fts5';
        await db.queryAsync("ATTACH DATABASE ':memory:' AS ftindex");
        await db.queryAsync('CREATE TABLE ftindex.fulltextIndexState (itemID INTEGER PRIMARY KEY)');
        await db.queryAsync('INSERT INTO ftindex.fulltextIndexState VALUES (1)');
        const state = await getZoteroFulltextState();
        expect(state?.libraries[0]).toEqual({ library_ref: 'u', total: 5, indexed: 1, partial: 0 });
    });

    it('reports no coverage without an index', async () => {
        engine.value = 'none';
        expect(await getZoteroFulltextState()).toEqual({ version: 1, engine: 'none', libraries: [], languages: ['de'] });
        expect(coverageReads.count).toBe(0);
    });

    it('reuses a recent reading and refreshes an old one in the background', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        await getZoteroFulltextState();
        await add(9, 1, { fulltext: [2, 2, null, null] });
        expect((await getZoteroFulltextState())?.libraries[0].total).toBe(5);
        expect(coverageReads.count).toBe(1);

        now.mockReturnValue(1_000_000 + 11 * 60_000);
        // The old reading is served while the new one is read
        expect((await getZoteroFulltextState())?.libraries[0].total).toBe(5);
        expect(coverageReads.count).toBe(2);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect((await getZoteroFulltextState())?.libraries[0].total).toBe(6);
        expect(coverageReads.count).toBe(2);
    });

    it('waits for a fresh reading after a long idle', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
        await getZoteroFulltextState();
        await add(9, 1, { fulltext: [2, 2, null, null] });
        now.mockReturnValue(1_000_000 + 61 * 60_000);
        expect((await getZoteroFulltextState())?.libraries[0].total).toBe(6);
        expect(coverageReads.count).toBe(2);
    });

    it('reads afresh when the searchable libraries change', async () => {
        await getZoteroFulltextState();
        Zotero.Beaver!.searchableLibraryIds = [1];
        expect((await getZoteroFulltextState())?.libraries.map((library) => library.library_ref)).toEqual(['u']);
        expect(coverageReads.count).toBe(2);
    });
});

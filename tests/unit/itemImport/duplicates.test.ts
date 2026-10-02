import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/batchFindExistingReferences', () => ({ batchFindExistingReferences: vi.fn() }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ libraryRefForLibraryID: vi.fn() }));

import { MockDBConnection } from '../../mocks/mockDBConnection';
import { createSeedContext, createZoteroSchema, installZoteroDB, seedZoteroItem } from '../../helpers/zoteroSchemaSeed';
import { batchFindExistingReferences } from '../../../src/utils/batchFindExistingReferences';
import { findExistingItems, urlVariants } from '../../../src/services/itemImport/duplicates';

describe('urlVariants', () => {
    it('toggles the trailing slash on the path and the scheme', () => {
        expect(urlVariants('https://example.org/page').sort()).toEqual([
            'http://example.org/page', 'http://example.org/page/', 'https://example.org/page', 'https://example.org/page/',
        ]);
    });

    it('adds the slash to the path, never to the query string', () => {
        const variants = urlVariants('https://example.org/page?id=1');
        expect(variants).toContain('https://example.org/page/?id=1');
        expect(variants).not.toContain('https://example.org/page?id=1/');
        expect(urlVariants('https://example.org/page/?id=1')).toContain('https://example.org/page?id=1');
    });

    it('drops the fragment', () => {
        expect(urlVariants('https://example.org/page#section')).toContain('https://example.org/page');
    });
});

describe('findExistingItems URL matching', () => {
    const URL_FIELD_ID = 1;
    const PAGE_URL = 'https://example.org/page';
    let conn: MockDBConnection;
    let ctx: ReturnType<typeof createSeedContext>;
    let previousDB: unknown;
    let previousItems: unknown;

    async function seedWithUrl(item: Parameters<typeof seedZoteroItem>[2], url: string): Promise<number> {
        const itemID = await seedZoteroItem(conn, ctx, item);
        await conn.queryAsync('INSERT OR IGNORE INTO itemDataValues (valueID, value) VALUES (?, ?)', [1000 + itemID, url]);
        await conn.queryAsync(
            'INSERT INTO itemData (itemID, fieldID, valueID) SELECT ?, ?, valueID FROM itemDataValues WHERE value = ?',
            [itemID, URL_FIELD_ID, url],
        );
        return itemID;
    }

    const blogPost = { key: 'NEW', json: { itemType: 'blogPost', title: 'A post', url: PAGE_URL } };

    beforeEach(async () => {
        previousDB = Zotero.DB;
        previousItems = (Zotero as any).Items;
        conn = new MockDBConnection();
        await createZoteroSchema(conn);
        installZoteroDB(conn);
        ctx = createSeedContext();
        vi.mocked(batchFindExistingReferences).mockResolvedValue({ results: [] } as any);
        vi.mocked(Zotero.ItemFields.getID).mockImplementation((name: string) =>
            name === 'url' ? URL_FIELD_ID : ((globalThis as any).__TEST_FIELD_IDS[name] ?? 0));
        (Zotero as any).Items = {
            getAsync: vi.fn(async (itemID: number) => ({ libraryID: 1, key: `K${String(itemID).padStart(7, '0')}` })),
        };
    });

    afterEach(async () => {
        await conn.closeDatabase();
        (Zotero as any).DB = previousDB;
        (Zotero as any).Items = previousItems;
        vi.mocked(Zotero.ItemFields.getID).mockImplementation((name: string) =>
            (globalThis as any).__TEST_FIELD_IDS[name] ?? 0);
    });

    it('matches a regular item that stores a variant of the URL', async () => {
        const itemID = await seedWithUrl({ itemType: 'blogPost', title: 'Old title' }, 'http://example.org/page/');

        const existing = await findExistingItems([blogPost], 1);

        expect(existing.get('NEW')).toMatchObject({ library_id: 1, zotero_key: `K${String(itemID).padStart(7, '0')}` });
    });

    it('ignores a standalone attachment with the same URL', async () => {
        await seedWithUrl({ itemType: 'attachment', title: 'Snapshot' }, PAGE_URL);

        const existing = await findExistingItems([blogPost], 1);

        expect(existing.has('NEW')).toBe(false);
    });

    it('ignores the child attachment of a trashed item', async () => {
        await seedWithUrl({ itemType: 'blogPost', title: 'A post', deleted: true }, PAGE_URL);
        await seedWithUrl({ itemType: 'attachment', title: 'Snapshot' }, PAGE_URL);

        const existing = await findExistingItems([blogPost], 1);

        expect(existing.has('NEW')).toBe(false);
    });
});

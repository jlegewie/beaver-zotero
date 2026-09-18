import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { queryLibraryAttachmentIds } from '../../../src/services/documentExtraction/attachmentInventory';

describe('current library attachment inventory', () => {
    let db: MockDBConnection;
    let previousDB: typeof Zotero.DB;
    let previousAttachments: typeof Zotero.Attachments;
    beforeEach(async () => {
        db = new MockDBConnection();
        previousDB = Zotero.DB;
        previousAttachments = Zotero.Attachments;
        (Zotero as any).DB = { queryAsync: db.queryAsync.bind(db) };
        (Zotero as any).Attachments = { LINK_MODE_LINKED_URL: 3 };
        await db.queryAsync('CREATE TABLE items (itemID INTEGER PRIMARY KEY, libraryID INTEGER)');
        await db.queryAsync('CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INTEGER, linkMode INTEGER, contentType TEXT)');
        await db.queryAsync('CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY)');
        await db.queryAsync('INSERT INTO items VALUES (1,1),(2,1),(3,1),(4,1),(5,1),(6,2),(7,1),(8,1)');
        await db.queryAsync(`INSERT INTO itemAttachments VALUES
            (1,NULL,0,'application/pdf'), (2,NULL,0,'APPLICATION/EPUB+ZIP'),
            (3,NULL,3,'text/html'), (4,NULL,0,'application/pdf'),
            (5,8,0,'application/pdf'), (6,NULL,0,'application/pdf'), (7,NULL,0,'image/png')`);
        await db.queryAsync('INSERT INTO deletedItems VALUES (4),(8)');
    });
    afterEach(async () => {
        (Zotero as any).DB = previousDB;
        (Zotero as any).Attachments = previousAttachments;
        await db.closeDatabase();
    });
    it('excludes linked URLs, trashed attachments, trashed parents and other libraries', async () => {
        expect(await queryLibraryAttachmentIds(1)).toEqual([1, 2, 7]);
    });
    it('preserves preparation MIME filtering without narrowing the complete census', async () => {
        expect(await queryLibraryAttachmentIds(1, {
            contentTypes: ['application/pdf', 'application/epub+zip', 'text/html', 'application/xhtml+xml'],
        })).toEqual([1, 2]);
    });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

describe('BeaverDB - derived attachment embedding text', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    const row = (overrides: Partial<Parameters<BeaverDB['upsertAttachmentEmbeddingText']>[0]> = {}) => ({
        libraryId: 1, zoteroKey: 'ATTACH01', itemId: 9, contentKind: 'pdf' as const,
        fileMtimeMs: 10, fileSizeBytes: 20, fileHash: 'hash', extractionSource: 'native' as const, textVersion: 1,
        title: 'Derived title', titleSource: 'document', keywords: 'a, b',
        body: 'Body text', bodySource: 'abstract' as const,
        ...overrides,
    });

    const embedding = (itemId: number, extra: Record<string, unknown> = {}) => ({
        item_id: itemId, library_id: 1, zotero_key: `KEY${itemId}`, version: 1,
        client_date_modified: '2024-01-01 00:00:00', content_hash: `hash${itemId}`,
        embedding: new Uint8Array([1, 2, 3, 4]), dimensions: 4, model_id: 'test-model',
        ...extra,
    });

    it('stores, replaces and reads derived text by attachment', async () => {
        await db.upsertAttachmentEmbeddingText(row(), 100);
        await db.upsertAttachmentEmbeddingText(row({ body: 'Replaced', bodySource: 'opening' }), 200);

        const rows = await db.getAttachmentEmbeddingTexts([
            { libraryId: 1, zoteroKey: 'ATTACH01' },
            { libraryId: 1, zoteroKey: 'MISSING1' },
        ]);

        expect(rows.size).toBe(1);
        expect(rows.get('1/ATTACH01')).toEqual({ ...row({ body: 'Replaced', bodySource: 'opening' }), updatedAt: 200 });
    });

    it('keeps a row pending until the index applies it, unless it is re-derived meanwhile', async () => {
        await db.upsertAttachmentEmbeddingText(row(), 100);
        await db.upsertAttachmentEmbeddingText(row({ zoteroKey: 'ATTACH02', itemId: 10 }), 300);
        await db.upsertAttachmentEmbeddingText(row({ libraryId: 2, zoteroKey: 'ATTACH03', itemId: 11 }), 100);
        expect(await db.getPendingAttachmentEmbeddingTextIds([1])).toEqual([9, 10]);

        await db.clearAttachmentEmbeddingTextPending([9, 10], 200);
        expect(await db.getPendingAttachmentEmbeddingTextIds([1])).toEqual([10]);

        // Re-deriving marks the row pending again.
        await db.upsertAttachmentEmbeddingText(row(), 400);
        expect(await db.getPendingAttachmentEmbeddingTextIds([1, 2])).toEqual([9, 10, 11]);
    });

    it('deletes rows by attachment, by key and outside the searchable libraries', async () => {
        await db.upsertAttachmentEmbeddingText(row());
        await db.upsertAttachmentEmbeddingText(row({ zoteroKey: 'ATTACH02', itemId: 10 }));
        await db.upsertAttachmentEmbeddingText(row({ libraryId: 2, zoteroKey: 'ATTACH03', itemId: 11 }));

        await db.deleteAttachmentEmbeddingTextsOutsideLibraries([1]);
        expect(await db.getAttachmentEmbeddingTextKeys(2)).toEqual([]);

        await db.deleteAttachmentEmbeddingTextsByItemIds([9]);
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual(['ATTACH02']);

        await db.deleteAttachmentEmbeddingTexts([{ libraryId: 1, zoteroKey: 'ATTACH02' }]);
        await db.upsertAttachmentEmbeddingText(row({ libraryId: 3, zoteroKey: 'ATTACH04', itemId: 12 }));
        await db.deleteAttachmentEmbeddingTextsOutsideLibraries([]);
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual([]);
        expect(await db.getAttachmentEmbeddingTextKeys(3)).toEqual([]);
    });

    it('records the embedding source and finds units by their source attachment', async () => {
        await db.upsertEmbedding(embedding(1));
        await db.upsertEmbeddingsBatch([
            embedding(2, { source: 'attachment_text', source_attachment_id: 9 }),
            embedding(3, { source: 'attachment_text', source_attachment_id: 10 }),
        ]);

        expect(await db.getUnitIdsBySourceAttachment([9, 11])).toEqual([2]);
        expect(await db.getEmbeddingSources([1, 2, 4])).toEqual(new Map([
            [1, { source: 'metadata', sourceAttachmentId: null }],
            [2, { source: 'attachment_text', sourceAttachmentId: 9 }],
        ]));
        expect((await db.getEmbedding(3))).toMatchObject({ source: 'attachment_text', source_attachment_id: 10 });

        // Re-embedding from metadata clears the reverse link.
        await db.upsertEmbedding(embedding(2));
        expect(await db.getUnitIdsBySourceAttachment([9])).toEqual([]);
    });

    it('adds the source columns to an existing embeddings table', async () => {
        const legacy = new MockDBConnection();
        await legacy.queryAsync(`CREATE TABLE embeddings (
            item_id INTEGER NOT NULL, library_id INTEGER NOT NULL, zotero_key TEXT NOT NULL,
            version INTEGER NOT NULL, client_date_modified TEXT NOT NULL, content_hash TEXT NOT NULL,
            embedding BLOB NOT NULL, dimensions INTEGER NOT NULL, model_id TEXT NOT NULL,
            indexed_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (item_id))`);
        await legacy.queryAsync(`INSERT INTO embeddings
            (item_id, library_id, zotero_key, version, client_date_modified, content_hash, embedding, dimensions, model_id)
            VALUES (5, 1, 'KEY5', 1, '2024-01-01 00:00:00', 'h', X'01', 1, 'm')`);
        const legacyDb = new BeaverDB(legacy as any);
        try {
            await legacyDb.initDatabase('0.99.0');
            expect(await legacyDb.getEmbeddingSources([5])).toEqual(new Map([
                [5, { source: 'metadata', sourceAttachmentId: null }],
            ]));
        } finally {
            await legacy.closeDatabase();
        }
    });

    it('reads ledger rows for specific attachments', async () => {
        for (const key of ['ATTACH01', 'ATTACH02', 'ATTACH03']) {
            await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: key, itemId: 1, contentKind: 'pdf' });
        }
        const rows = await db.getAttachmentProcessingStatesByRefs(
            ['ATTACH01', 'ATTACH03', 'MISSING1'].map(zoteroKey => ({ libraryId: 1, zoteroKey })),
        );
        expect(rows.map(r => r.zoteroKey).sort()).toEqual(['ATTACH01', 'ATTACH03']);
    });
});

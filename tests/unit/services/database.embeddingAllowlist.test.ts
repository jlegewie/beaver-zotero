import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

describe('BeaverDB - embedding allowlist lookups', () => {
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

    const insertEmbedding = async (itemId: number, libraryId: number) => {
        await db.upsertEmbedding({
            item_id: itemId,
            library_id: libraryId,
            zotero_key: `KEY${itemId}`,
            version: 1,
            client_date_modified: '2024-01-01 00:00:00',
            content_hash: `hash${itemId}`,
            embedding: new Uint8Array([1, 2, 3, 4]),
            dimensions: 4,
            model_id: 'test-model',
        });
    };

    it('returns no results for an empty allowlist', async () => {
        await insertEmbedding(1, 1);

        await expect(db.getEmbeddingsByItemIds([])).resolves.toEqual([]);
    });

    it('returns no results for an explicit empty library scope', async () => {
        await insertEmbedding(1, 1);

        await expect(db.getEmbeddingsByItemIds([1], [])).resolves.toEqual([]);
    });

    it('applies the library restriction on top of the allowlist', async () => {
        await insertEmbedding(1, 1);
        await insertEmbedding(2, 2);

        const records = await db.getEmbeddingsByItemIds([1, 2], [1]);

        expect(records.map(r => r.item_id)).toEqual([1]);
    });

    it('returns every matching row for an allowlist larger than the parameter limit', async () => {
        const itemIds = Array.from({ length: 2500 }, (_, i) => i + 1);
        for (const itemId of itemIds) {
            await insertEmbedding(itemId, 1);
        }

        // Zotero's SQLite backend rejects statements over 999 bound parameters,
        // so assert the chunking directly — the test connection accepts far more.
        const queryAsync = vi.spyOn(conn, 'queryAsync');
        const records = await db.getEmbeddingsByItemIds(itemIds, [1]);

        expect(records).toHaveLength(itemIds.length);
        expect(new Set(records.map(r => r.item_id))).toEqual(new Set(itemIds));
        expect(queryAsync.mock.calls.length).toBeGreaterThan(1);
        for (const [, params] of queryAsync.mock.calls) {
            expect((params as unknown[]).length).toBeLessThanOrEqual(999);
        }
    });

    it('stays within the parameter limit when the library filter is oversized', async () => {
        await insertEmbedding(1, 1);
        await insertEmbedding(2, 2);

        const libraryIds = Array.from({ length: 1200 }, (_, i) => i + 1);
        const queryAsync = vi.spyOn(conn, 'queryAsync');
        const records = await db.getEmbeddingsByItemIds([1, 2], libraryIds.filter(id => id !== 2));

        for (const [, params] of queryAsync.mock.calls) {
            expect((params as unknown[]).length).toBeLessThanOrEqual(999);
        }
        // The library restriction still holds even though it is too large for SQL.
        expect(records.map(r => r.item_id)).toEqual([1]);
    });
});

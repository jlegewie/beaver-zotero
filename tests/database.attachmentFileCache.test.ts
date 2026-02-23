/**
 * Tests for BeaverDB attachment_file_cache SQL methods.
 *
 * Uses better-sqlite3 as a real SQLite backend so every SQL statement
 * (including ON CONFLICT, COALESCE, CASE) is exercised against real SQLite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BeaverDB, AttachmentFileCacheRecord } from '../src/services/database';
import { MockDBConnection } from './mocks/mockDBConnection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid record (omitting cached_at which is auto-set). */
function makeRecord(overrides: Partial<Omit<AttachmentFileCacheRecord, 'cached_at'>> = {}): Omit<AttachmentFileCacheRecord, 'cached_at'> {
    return {
        item_id: 100,
        library_id: 1,
        zotero_key: 'ABCD1234',
        file_path: '/data/storage/ABCD1234/test.pdf',
        file_mtime_ms: 1700000000000,
        file_size_bytes: 123456,
        content_type: 'application/pdf',
        page_count: 10,
        page_labels: null,
        has_text_layer: true,
        needs_ocr: false,
        is_encrypted: false,
        is_invalid: false,
        extraction_version: '1',
        has_content_cache: false,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('BeaverDB — attachment_file_cache methods', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;

    beforeEach(async () => {
        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        // Create only the table under test (initDatabase creates all tables;
        // we call it with a dummy version to set up schema).
        await db.initDatabase('0.99.0');
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    // ===================================================================
    // upsertAttachmentFileCache
    // ===================================================================

    describe('upsertAttachmentFileCache', () => {
        it('inserts a new row with correct field values', async () => {
            const rec = makeRecord({ page_count: 42, has_text_layer: true, needs_ocr: false });
            await db.upsertAttachmentFileCache(rec);

            const result = await db.getAttachmentFileCache(100);
            expect(result).not.toBeNull();
            expect(result!.item_id).toBe(100);
            expect(result!.library_id).toBe(1);
            expect(result!.zotero_key).toBe('ABCD1234');
            expect(result!.file_path).toBe('/data/storage/ABCD1234/test.pdf');
            expect(result!.file_mtime_ms).toBe(1700000000000);
            expect(result!.file_size_bytes).toBe(123456);
            expect(result!.content_type).toBe('application/pdf');
            expect(result!.page_count).toBe(42);
            expect(result!.has_text_layer).toBe(true);
            expect(result!.needs_ocr).toBe(false);
            expect(result!.is_encrypted).toBe(false);
            expect(result!.is_invalid).toBe(false);
            expect(result!.extraction_version).toBe('1');
            expect(result!.has_content_cache).toBe(false);
            expect(result!.cached_at).toBeTruthy();
        });

        it('stores booleans as integers 0/1', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ is_encrypted: true, is_invalid: true }));
            const rawDB = conn.getRawDB();
            const row = rawDB.prepare('SELECT is_encrypted, is_invalid FROM attachment_file_cache WHERE item_id = 100').get() as any;
            expect(row.is_encrypted).toBe(1);
            expect(row.is_invalid).toBe(1);
        });

        it('stores null for nullable boolean fields', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ has_text_layer: null, needs_ocr: null }));
            const rawDB = conn.getRawDB();
            const row = rawDB.prepare('SELECT has_text_layer, needs_ocr FROM attachment_file_cache WHERE item_id = 100').get() as any;
            expect(row.has_text_layer).toBeNull();
            expect(row.needs_ocr).toBeNull();
        });

        it('serializes page_labels as JSON', async () => {
            const labels: Record<number, string> = { 0: 'i', 1: 'ii', 2: '1' };
            await db.upsertAttachmentFileCache(makeRecord({ page_labels: labels }));
            const rawDB = conn.getRawDB();
            const row = rawDB.prepare('SELECT page_labels_json FROM attachment_file_cache WHERE item_id = 100').get() as any;
            expect(JSON.parse(row.page_labels_json)).toEqual(labels);
        });

        it('stores null page_labels as NULL in DB', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ page_labels: null }));
            const rawDB = conn.getRawDB();
            const row = rawDB.prepare('SELECT page_labels_json FROM attachment_file_cache WHERE item_id = 100').get() as any;
            expect(row.page_labels_json).toBeNull();
        });

        it('updates existing row — all fields overwritten', async () => {
            await db.upsertAttachmentFileCache(makeRecord());
            await db.upsertAttachmentFileCache(makeRecord({
                file_path: '/new/path.pdf',
                page_count: 99,
                has_content_cache: true,
            }));

            const result = await db.getAttachmentFileCache(100);
            expect(result!.file_path).toBe('/new/path.pdf');
            expect(result!.page_count).toBe(99);
            expect(result!.has_content_cache).toBe(true);
        });
    });

    // ===================================================================
    // insertAttachmentFileCacheIfNotExists
    // ===================================================================

    describe('insertAttachmentFileCacheIfNotExists', () => {
        it('inserts a new row and returns true', async () => {
            const inserted = await db.insertAttachmentFileCacheIfNotExists(makeRecord());
            expect(inserted).toBe(true);

            const result = await db.getAttachmentFileCache(100);
            expect(result).not.toBeNull();
            expect(result!.item_id).toBe(100);
        });

        it('returns false and does NOT overwrite existing row', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ page_count: 42, has_content_cache: true }));

            const inserted = await db.insertAttachmentFileCacheIfNotExists(
                makeRecord({ page_count: 1, has_content_cache: false })
            );
            expect(inserted).toBe(false);

            // Original values preserved
            const result = await db.getAttachmentFileCache(100);
            expect(result!.page_count).toBe(42);
            expect(result!.has_content_cache).toBe(true);
        });
    });

    // ===================================================================
    // upsertAttachmentFileCachePreserveContentFields
    // ===================================================================

    describe('upsertAttachmentFileCachePreserveContentFields', () => {
        it('inserts a new row normally when no conflict', async () => {
            await db.upsertAttachmentFileCachePreserveContentFields(makeRecord({ page_count: 5 }));
            const result = await db.getAttachmentFileCache(100);
            expect(result!.page_count).toBe(5);
        });

        it('preserves has_content_cache=true when incoming is false', async () => {
            // First: set has_content_cache to true
            await db.upsertAttachmentFileCache(makeRecord({ has_content_cache: true }));

            // Then: upsert with has_content_cache=false via preserve method
            await db.upsertAttachmentFileCachePreserveContentFields(
                makeRecord({ has_content_cache: false })
            );

            const result = await db.getAttachmentFileCache(100);
            // OR-merge: true stays true
            expect(result!.has_content_cache).toBe(true);
        });

        it('upgrades has_content_cache from false to true', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ has_content_cache: false }));

            await db.upsertAttachmentFileCachePreserveContentFields(
                makeRecord({ has_content_cache: true })
            );

            const result = await db.getAttachmentFileCache(100);
            expect(result!.has_content_cache).toBe(true);
        });

        it('preserves existing page_labels when incoming is null', async () => {
            const labels = { 0: 'i', 1: 'ii' };
            await db.upsertAttachmentFileCache(makeRecord({ page_labels: labels }));

            await db.upsertAttachmentFileCachePreserveContentFields(
                makeRecord({ page_labels: null })
            );

            const result = await db.getAttachmentFileCache(100);
            expect(result!.page_labels).toEqual(labels);
        });

        it('overwrites page_labels when incoming is non-null', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ page_labels: { 0: 'old' } }));

            const newLabels = { 0: 'A', 1: 'B', 2: 'C' };
            await db.upsertAttachmentFileCachePreserveContentFields(
                makeRecord({ page_labels: newLabels })
            );

            const result = await db.getAttachmentFileCache(100);
            expect(result!.page_labels).toEqual(newLabels);
        });

        it('writes page_labels when existing row has null labels', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ page_labels: null }));

            const labels = { 0: 'i' };
            await db.upsertAttachmentFileCachePreserveContentFields(
                makeRecord({ page_labels: labels })
            );

            const result = await db.getAttachmentFileCache(100);
            expect(result!.page_labels).toEqual(labels);
        });

        it('still updates non-preserved fields (file_path, page_count, etc.)', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ page_count: 10, file_path: '/old.pdf' }));

            await db.upsertAttachmentFileCachePreserveContentFields(
                makeRecord({ page_count: 20, file_path: '/new.pdf' })
            );

            const result = await db.getAttachmentFileCache(100);
            expect(result!.page_count).toBe(20);
            expect(result!.file_path).toBe('/new.pdf');
        });
    });

    // ===================================================================
    // upsertAttachmentFileCacheBatch
    // ===================================================================

    describe('upsertAttachmentFileCacheBatch', () => {
        it('does nothing for empty array', async () => {
            await db.upsertAttachmentFileCacheBatch([]);
            const count = await db.getAttachmentFileCacheCount();
            expect(count).toBe(0);
        });

        it('inserts multiple records in a transaction', async () => {
            const records = [
                makeRecord({ item_id: 1, zotero_key: 'KEY00001' }),
                makeRecord({ item_id: 2, zotero_key: 'KEY00002' }),
                makeRecord({ item_id: 3, zotero_key: 'KEY00003' }),
            ];
            await db.upsertAttachmentFileCacheBatch(records);

            const count = await db.getAttachmentFileCacheCount();
            expect(count).toBe(3);

            const r1 = await db.getAttachmentFileCache(1);
            expect(r1!.zotero_key).toBe('KEY00001');
        });

        it('updates existing rows on conflict', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 1, page_count: 5 }));
            await db.upsertAttachmentFileCacheBatch([
                makeRecord({ item_id: 1, page_count: 50 }),
                makeRecord({ item_id: 2, page_count: 20 }),
            ]);

            const r1 = await db.getAttachmentFileCache(1);
            expect(r1!.page_count).toBe(50);
            const r2 = await db.getAttachmentFileCache(2);
            expect(r2!.page_count).toBe(20);
        });
    });

    // ===================================================================
    // getAttachmentFileCache / getAttachmentFileCacheByKey
    // ===================================================================

    describe('getAttachmentFileCache', () => {
        it('returns null for non-existent item', async () => {
            const result = await db.getAttachmentFileCache(999);
            expect(result).toBeNull();
        });

        it('correctly converts nullable booleans — null stays null', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ has_text_layer: null, needs_ocr: null }));
            const result = await db.getAttachmentFileCache(100);
            expect(result!.has_text_layer).toBeNull();
            expect(result!.needs_ocr).toBeNull();
        });

        it('correctly converts booleans — 0→false, 1→true', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ has_text_layer: false, needs_ocr: true }));
            const result = await db.getAttachmentFileCache(100);
            expect(result!.has_text_layer).toBe(false);
            expect(result!.needs_ocr).toBe(true);
        });

        it('deserializes page_labels from JSON', async () => {
            const labels = { 0: 'i', 1: 'ii', 2: '1', 3: '2' };
            await db.upsertAttachmentFileCache(makeRecord({ page_labels: labels }));
            const result = await db.getAttachmentFileCache(100);
            expect(result!.page_labels).toEqual(labels);
        });

        it('handles malformed page_labels JSON gracefully', async () => {
            // Write garbage JSON directly
            const rawDB = conn.getRawDB();
            rawDB.prepare(`
                INSERT INTO attachment_file_cache
                    (item_id, library_id, zotero_key, file_path, file_mtime_ms, file_size_bytes,
                     content_type, extraction_version, page_labels_json, cached_at)
                VALUES (999, 1, 'MALFORM1', '/x.pdf', 0, 0, 'application/pdf', '1', '{broken', datetime('now'))
            `).run();

            const result = await db.getAttachmentFileCache(999);
            expect(result).not.toBeNull();
            expect(result!.page_labels).toBeNull();
        });
    });

    describe('getAttachmentFileCacheByKey', () => {
        it('returns record by library_id + zotero_key', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ library_id: 5, zotero_key: 'XYZ12345' }));
            const result = await db.getAttachmentFileCacheByKey(5, 'XYZ12345');
            expect(result).not.toBeNull();
            expect(result!.item_id).toBe(100);
        });

        it('returns null for non-existent key', async () => {
            const result = await db.getAttachmentFileCacheByKey(1, 'NOPE0000');
            expect(result).toBeNull();
        });
    });

    // ===================================================================
    // getAttachmentFileCacheBatch
    // ===================================================================

    describe('getAttachmentFileCacheBatch', () => {
        it('returns map of found items, ignoring missing', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 1 }));
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 3 }));

            const result = await db.getAttachmentFileCacheBatch([1, 2, 3]);
            expect(result.size).toBe(2);
            expect(result.has(1)).toBe(true);
            expect(result.has(2)).toBe(false);
            expect(result.has(3)).toBe(true);
        });

        it('returns empty map for empty input', async () => {
            const result = await db.getAttachmentFileCacheBatch([]);
            expect(result.size).toBe(0);
        });

        it('handles >500 items (chunking)', async () => {
            // Insert 600 records
            const records = Array.from({ length: 600 }, (_, i) =>
                makeRecord({ item_id: i + 1, zotero_key: `KEY${String(i).padStart(5, '0')}` })
            );
            await db.upsertAttachmentFileCacheBatch(records);

            const ids = Array.from({ length: 600 }, (_, i) => i + 1);
            const result = await db.getAttachmentFileCacheBatch(ids);
            expect(result.size).toBe(600);
        });
    });

    // ===================================================================
    // deleteAttachmentFileCache / deleteAttachmentFileCacheByLibrary
    // ===================================================================

    describe('deleteAttachmentFileCache', () => {
        it('deletes existing row', async () => {
            await db.upsertAttachmentFileCache(makeRecord());
            await db.deleteAttachmentFileCache(100);
            const result = await db.getAttachmentFileCache(100);
            expect(result).toBeNull();
        });

        it('does not error when deleting non-existent row', async () => {
            await expect(db.deleteAttachmentFileCache(999)).resolves.toBeUndefined();
        });
    });

    describe('deleteAttachmentFileCacheByLibrary', () => {
        it('deletes all rows for a library, leaves other libraries', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 1, library_id: 1 }));
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 2, library_id: 1 }));
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 3, library_id: 2 }));

            await db.deleteAttachmentFileCacheByLibrary(1);

            expect(await db.getAttachmentFileCache(1)).toBeNull();
            expect(await db.getAttachmentFileCache(2)).toBeNull();
            expect(await db.getAttachmentFileCache(3)).not.toBeNull();
        });
    });

    // ===================================================================
    // updateContentCacheFlag
    // ===================================================================

    describe('updateContentCacheFlag', () => {
        it('sets flag to true', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ has_content_cache: false }));
            await db.updateContentCacheFlag(100, true);
            const result = await db.getAttachmentFileCache(100);
            expect(result!.has_content_cache).toBe(true);
        });

        it('sets flag to false', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ has_content_cache: true }));
            await db.updateContentCacheFlag(100, false);
            const result = await db.getAttachmentFileCache(100);
            expect(result!.has_content_cache).toBe(false);
        });

        it('does not change other fields', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ page_count: 42, file_path: '/a.pdf' }));
            await db.updateContentCacheFlag(100, true);
            const result = await db.getAttachmentFileCache(100);
            expect(result!.page_count).toBe(42);
            expect(result!.file_path).toBe('/a.pdf');
        });
    });

    // ===================================================================
    // getAttachmentFileCacheCount
    // ===================================================================

    describe('getAttachmentFileCacheCount', () => {
        it('returns 0 for empty table', async () => {
            expect(await db.getAttachmentFileCacheCount()).toBe(0);
        });

        it('returns total count without library filter', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 1, library_id: 1 }));
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 2, library_id: 2 }));
            expect(await db.getAttachmentFileCacheCount()).toBe(2);
        });

        it('returns count filtered by library', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 1, library_id: 1 }));
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 2, library_id: 1 }));
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 3, library_id: 2 }));
            expect(await db.getAttachmentFileCacheCount(1)).toBe(2);
            expect(await db.getAttachmentFileCacheCount(2)).toBe(1);
            expect(await db.getAttachmentFileCacheCount(99)).toBe(0);
        });
    });

    // ===================================================================
    // getAllAttachmentFileCache
    // ===================================================================

    describe('getAllAttachmentFileCache', () => {
        it('returns all records ordered by library_id, item_id', async () => {
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 5, library_id: 2 }));
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 1, library_id: 1 }));
            await db.upsertAttachmentFileCache(makeRecord({ item_id: 3, library_id: 2 }));

            const all = await db.getAllAttachmentFileCache();
            expect(all).toHaveLength(3);
            expect(all[0].item_id).toBe(1);
            expect(all[0].library_id).toBe(1);
            expect(all[1].item_id).toBe(3);
            expect(all[1].library_id).toBe(2);
            expect(all[2].item_id).toBe(5);
            expect(all[2].library_id).toBe(2);
        });

        it('returns empty array for empty table', async () => {
            const all = await db.getAllAttachmentFileCache();
            expect(all).toHaveLength(0);
        });
    });

    // ===================================================================
    // Index existence
    // ===================================================================

    describe('indexes', () => {
        it('creates idx_afc_library index', async () => {
            const rawDB = conn.getRawDB();
            const indexes = rawDB.prepare(
                "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='attachment_file_cache'"
            ).all() as any[];
            const names = indexes.map((r: any) => r.name);
            expect(names).toContain('idx_afc_library');
            expect(names).toContain('idx_afc_library_key');
        });
    });
});

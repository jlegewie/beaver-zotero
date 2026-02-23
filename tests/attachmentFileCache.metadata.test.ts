/**
 * Tests for AttachmentFileCache — Tier 1 (metadata) operations.
 *
 * Uses a real BeaverDB backed by better-sqlite3.  IOUtils is mocked
 * for file-signature checks (stat).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BeaverDB, AttachmentFileCacheRecord } from '../src/services/database';
import { AttachmentFileCache, EXTRACTION_VERSION } from '../src/services/attachmentFileCache';
import { MockDBConnection } from './mocks/mockDBConnection';

// Cast globals for type-safe mock access
const mockIOUtils = (globalThis as any).IOUtils as {
    exists: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    readUTF8: ReturnType<typeof vi.fn>;
    writeUTF8: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    getChildren: ReturnType<typeof vi.fn>;
    makeDirectory: ReturnType<typeof vi.fn>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
        extraction_version: EXTRACTION_VERSION,
        has_content_cache: false,
        ...overrides,
    };
}

/** Helper to configure IOUtils.stat to return a matching file signature. */
function mockFileStat(mtime: number, size: number) {
    mockIOUtils.stat.mockResolvedValue({ lastModified: mtime, size });
}

/** Helper to configure IOUtils.stat to throw (file not found). */
function mockFileStatMissing() {
    mockIOUtils.stat.mockRejectedValue(new Error('file not found'));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AttachmentFileCache — metadata (Tier 1)', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;
    let cache: AttachmentFileCache;

    beforeEach(async () => {
        vi.clearAllMocks();

        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');

        cache = new AttachmentFileCache(db);
        // Skip init() — we don't need the disk directory for metadata-only tests.
        // Set the contentCacheDir directly for path construction in invalidate.
        (cache as any).contentCacheDir = '/mock/profile/beaver/content-cache';
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    // ===================================================================
    // getMetadata
    // ===================================================================

    describe('getMetadata', () => {
        it('returns null when no record exists (DB miss)', async () => {
            mockFileStat(1700000000000, 123456);
            const result = await cache.getMetadata(999, '/any.pdf');
            expect(result).toBeNull();
        });

        it('returns record from DB and populates memory cache', async () => {
            const rec = makeRecord();
            await db.upsertAttachmentFileCache(rec);
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes);

            const result = await cache.getMetadata(100, rec.file_path);
            expect(result).not.toBeNull();
            expect(result!.item_id).toBe(100);

            // Verify it's now in memory cache (second call should not hit DB)
            const spy = vi.spyOn(db, 'getAttachmentFileCache');
            const result2 = await cache.getMetadata(100, rec.file_path);
            expect(result2).not.toBeNull();
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        it('returns record from memory cache without DB call', async () => {
            const rec = makeRecord();
            await cache.setMetadata(rec);
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes);

            const spy = vi.spyOn(db, 'getAttachmentFileCache');
            const result = await cache.getMetadata(100, rec.file_path);
            expect(result).not.toBeNull();
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        it('returns null and invalidates when extraction_version mismatches', async () => {
            const rec = makeRecord({ extraction_version: 'old' });
            await db.upsertAttachmentFileCache(rec);
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes);
            mockIOUtils.exists.mockResolvedValue(false); // content file doesn't exist

            const result = await cache.getMetadata(100, rec.file_path);
            expect(result).toBeNull();

            // DB row should be deleted
            const dbRow = await db.getAttachmentFileCache(100);
            expect(dbRow).toBeNull();
        });

        it('returns null and invalidates when file mtime changes', async () => {
            const rec = makeRecord();
            await db.upsertAttachmentFileCache(rec);
            mockIOUtils.exists.mockResolvedValue(false);

            // Mtime changed
            mockFileStat(rec.file_mtime_ms + 1000, rec.file_size_bytes);

            const result = await cache.getMetadata(100, rec.file_path);
            expect(result).toBeNull();
        });

        it('returns null and invalidates when file size changes', async () => {
            const rec = makeRecord();
            await db.upsertAttachmentFileCache(rec);
            mockIOUtils.exists.mockResolvedValue(false);

            // Size changed
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes + 100);

            const result = await cache.getMetadata(100, rec.file_path);
            expect(result).toBeNull();
        });

        it('returns null and invalidates when file_path changes', async () => {
            const rec = makeRecord();
            await db.upsertAttachmentFileCache(rec);
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes);
            mockIOUtils.exists.mockResolvedValue(false);

            const result = await cache.getMetadata(100, '/different/path.pdf');
            expect(result).toBeNull();
        });

        it('returns null and invalidates when file no longer exists', async () => {
            const rec = makeRecord();
            await db.upsertAttachmentFileCache(rec);
            mockFileStatMissing();
            mockIOUtils.exists.mockResolvedValue(false);

            const result = await cache.getMetadata(100, rec.file_path);
            expect(result).toBeNull();
        });
    });

    // ===================================================================
    // getMetadataByKey
    // ===================================================================

    describe('getMetadataByKey', () => {
        it('returns fresh record', async () => {
            const rec = makeRecord();
            await db.upsertAttachmentFileCache(rec);
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes);

            const result = await cache.getMetadataByKey(1, 'ABCD1234', rec.file_path);
            expect(result).not.toBeNull();
            expect(result!.item_id).toBe(100);
        });

        it('returns null and invalidates for stale record', async () => {
            const rec = makeRecord();
            await db.upsertAttachmentFileCache(rec);
            mockFileStat(rec.file_mtime_ms + 999, rec.file_size_bytes);
            mockIOUtils.exists.mockResolvedValue(false);

            const result = await cache.getMetadataByKey(1, 'ABCD1234', rec.file_path);
            expect(result).toBeNull();
        });

        it('returns null for non-existent key', async () => {
            const result = await cache.getMetadataByKey(1, 'NOPE0000', '/x.pdf');
            expect(result).toBeNull();
        });
    });

    // ===================================================================
    // getMetadataBatch
    // ===================================================================

    describe('getMetadataBatch', () => {
        it('returns map with fresh entries only', async () => {
            const rec1 = makeRecord({ item_id: 1, zotero_key: 'KEY00001', file_path: '/a.pdf' });
            const rec2 = makeRecord({ item_id: 2, zotero_key: 'KEY00002', file_path: '/b.pdf', file_mtime_ms: 2000 });
            await db.upsertAttachmentFileCache(rec1);
            await db.upsertAttachmentFileCache(rec2);

            // rec1 fresh, rec2 stale (different mtime)
            mockIOUtils.stat.mockImplementation(async (path: string) => {
                if (path === '/a.pdf') return { lastModified: rec1.file_mtime_ms, size: rec1.file_size_bytes };
                if (path === '/b.pdf') return { lastModified: 9999, size: rec2.file_size_bytes };
                throw new Error('not found');
            });
            mockIOUtils.exists.mockResolvedValue(false);

            const result = await cache.getMetadataBatch([
                { itemId: 1, filePath: '/a.pdf' },
                { itemId: 2, filePath: '/b.pdf' },
                { itemId: 3, filePath: '/c.pdf' }, // does not exist
            ]);

            expect(result.size).toBe(1);
            expect(result.has(1)).toBe(true);
            expect(result.has(2)).toBe(false);
            expect(result.has(3)).toBe(false);
        });

        it('uses memory cache for items already fetched', async () => {
            const rec = makeRecord({ item_id: 1, file_path: '/a.pdf' });
            await cache.setMetadata(rec);
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes);

            const dbSpy = vi.spyOn(db, 'getAttachmentFileCacheBatch');
            const result = await cache.getMetadataBatch([
                { itemId: 1, filePath: '/a.pdf' },
            ]);
            expect(result.size).toBe(1);
            // DB batch should be called with empty array since item was in memory
            expect(dbSpy).not.toHaveBeenCalled();
            dbSpy.mockRestore();
        });
    });

    // ===================================================================
    // setMetadata
    // ===================================================================

    describe('setMetadata', () => {
        it('stores record in DB and memory cache', async () => {
            const rec = makeRecord();
            await cache.setMetadata(rec);

            // Check DB
            const dbRow = await db.getAttachmentFileCache(100);
            expect(dbRow).not.toBeNull();
            expect(dbRow!.page_count).toBe(10);

            // Check memory (bypass DB)
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes);
            const dbSpy = vi.spyOn(db, 'getAttachmentFileCache');
            const result = await cache.getMetadata(100, rec.file_path);
            expect(result).not.toBeNull();
            expect(dbSpy).not.toHaveBeenCalled();
            dbSpy.mockRestore();
        });
    });

    // ===================================================================
    // setMetadataPreservingContentFields
    // ===================================================================

    describe('setMetadataPreservingContentFields', () => {
        it('updates DB with merge and refreshes memory cache', async () => {
            // Pre-populate with has_content_cache=true and page_labels
            await db.upsertAttachmentFileCache(makeRecord({
                has_content_cache: true,
                page_labels: { 0: 'i' },
            }));

            // Now call preserve method with has_content_cache=false and page_labels=null
            await cache.setMetadataPreservingContentFields(makeRecord({
                has_content_cache: false,
                page_labels: null,
                page_count: 99,
            }));

            // Memory cache should reflect merged values
            mockFileStat(1700000000000, 123456);
            const result = await cache.getMetadata(100, '/data/storage/ABCD1234/test.pdf');
            expect(result).not.toBeNull();
            expect(result!.has_content_cache).toBe(true); // preserved
            expect(result!.page_labels).toEqual({ 0: 'i' }); // preserved
            expect(result!.page_count).toBe(99); // updated
        });
    });

    // ===================================================================
    // setMetadataIfNotExists
    // ===================================================================

    describe('setMetadataIfNotExists', () => {
        it('inserts when no row exists and returns true', async () => {
            const inserted = await cache.setMetadataIfNotExists(makeRecord());
            expect(inserted).toBe(true);

            mockFileStat(1700000000000, 123456);
            const result = await cache.getMetadata(100, '/data/storage/ABCD1234/test.pdf');
            expect(result).not.toBeNull();
        });

        it('returns false and does NOT overwrite when row exists', async () => {
            await cache.setMetadata(makeRecord({ page_count: 42 }));
            const inserted = await cache.setMetadataIfNotExists(makeRecord({ page_count: 1 }));
            expect(inserted).toBe(false);

            mockFileStat(1700000000000, 123456);
            const result = await cache.getMetadata(100, '/data/storage/ABCD1234/test.pdf');
            expect(result!.page_count).toBe(42);
        });
    });

    // ===================================================================
    // setMetadataBatch
    // ===================================================================

    describe('setMetadataBatch', () => {
        it('does nothing for empty array', async () => {
            await cache.setMetadataBatch([]);
            const count = await db.getAttachmentFileCacheCount();
            expect(count).toBe(0);
        });

        it('stores all records in DB and memory cache', async () => {
            const records = [
                makeRecord({ item_id: 1, zotero_key: 'KEY00001', file_path: '/a.pdf' }),
                makeRecord({ item_id: 2, zotero_key: 'KEY00002', file_path: '/b.pdf' }),
            ];
            await cache.setMetadataBatch(records);

            expect(await db.getAttachmentFileCacheCount()).toBe(2);

            // Verify memory cache populated
            mockFileStat(1700000000000, 123456);
            const dbSpy = vi.spyOn(db, 'getAttachmentFileCache');
            await cache.getMetadata(1, '/a.pdf');
            expect(dbSpy).not.toHaveBeenCalled();
            dbSpy.mockRestore();
        });
    });

    // ===================================================================
    // deleteMetadata / deleteMetadataByLibrary
    // ===================================================================

    describe('deleteMetadata', () => {
        it('removes from DB and memory cache', async () => {
            await cache.setMetadata(makeRecord());
            await cache.deleteMetadata(100);

            const dbRow = await db.getAttachmentFileCache(100);
            expect(dbRow).toBeNull();

            // Memory cache also cleared — will fall through to DB (which returns null)
            mockFileStat(1700000000000, 123456);
            const result = await cache.getMetadata(100, '/data/storage/ABCD1234/test.pdf');
            expect(result).toBeNull();
        });
    });

    describe('deleteMetadataByLibrary', () => {
        it('removes all entries for a library from DB and memory', async () => {
            await cache.setMetadata(makeRecord({ item_id: 1, library_id: 1, file_path: '/a.pdf' }));
            await cache.setMetadata(makeRecord({ item_id: 2, library_id: 1, file_path: '/b.pdf' }));
            await cache.setMetadata(makeRecord({ item_id: 3, library_id: 2, file_path: '/c.pdf' }));

            await cache.deleteMetadataByLibrary(1);

            expect(await db.getAttachmentFileCacheCount(1)).toBe(0);
            expect(await db.getAttachmentFileCacheCount(2)).toBe(1);

            // Memory cache also cleared for library 1
            mockFileStat(1700000000000, 123456);
            expect(await cache.getMetadata(1, '/a.pdf')).toBeNull();
            expect(await cache.getMetadata(2, '/b.pdf')).toBeNull();
            // Library 2 still in memory
            const r = await cache.getMetadata(3, '/c.pdf');
            expect(r).not.toBeNull();
        });
    });

    // ===================================================================
    // Memory cache LRU eviction
    // ===================================================================

    describe('memory cache eviction', () => {
        it('evicts oldest entry when capacity (500) is exceeded', async () => {
            // Insert 500 entries
            for (let i = 1; i <= 500; i++) {
                await cache.setMetadata(makeRecord({
                    item_id: i,
                    zotero_key: `K${String(i).padStart(7, '0')}`,
                    file_path: `/path/${i}.pdf`,
                }));
            }

            // Item 1 should be in memory
            mockFileStat(1700000000000, 123456);
            const dbSpy = vi.spyOn(db, 'getAttachmentFileCache');
            await cache.getMetadata(1, '/path/1.pdf');
            expect(dbSpy).not.toHaveBeenCalled();

            // Add item 501 — should evict item 1
            await cache.setMetadata(makeRecord({
                item_id: 501,
                zotero_key: 'K0000501',
                file_path: '/path/501.pdf',
            }));

            dbSpy.mockClear();
            // Now item 1 should require DB lookup
            await cache.getMetadata(1, '/path/1.pdf');
            expect(dbSpy).toHaveBeenCalledWith(1);

            dbSpy.mockRestore();
        });
    });

    // ===================================================================
    // clearMemoryCache
    // ===================================================================

    describe('clearMemoryCache', () => {
        it('clears memory cache and write locks', async () => {
            await cache.setMetadata(makeRecord());
            cache.clearMemoryCache();

            // After clearing, getMetadata should hit DB
            mockFileStat(1700000000000, 123456);
            const dbSpy = vi.spyOn(db, 'getAttachmentFileCache');
            await cache.getMetadata(100, '/data/storage/ABCD1234/test.pdf');
            expect(dbSpy).toHaveBeenCalledWith(100);
            dbSpy.mockRestore();
        });
    });

    // ===================================================================
    // getStats
    // ===================================================================

    describe('getStats', () => {
        it('returns correct counts', async () => {
            await cache.setMetadata(makeRecord({ item_id: 1 }));
            await cache.setMetadata(makeRecord({ item_id: 2 }));

            const stats = await cache.getStats();
            expect(stats.metadata_count).toBe(2);
            expect(stats.memory_cache_size).toBe(2);
            expect(stats.content_cache_dir).toBe('/mock/profile/beaver/content-cache');
        });
    });
});

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
            // Pre-populate with has_content_cache=true, page_labels, and OCR state
            await db.upsertAttachmentFileCache(makeRecord({
                has_content_cache: true,
                page_labels: { 0: 'i' },
                needs_ocr: true,
                has_text_layer: false,
            }));

            // Now call preserve method with has_content_cache=false, page_labels=null,
            // and null OCR fields — all should be preserved from existing record
            await cache.setMetadataPreservingContentFields(makeRecord({
                has_content_cache: false,
                page_labels: null,
                needs_ocr: null,
                has_text_layer: null,
                page_count: 99,
            }));

            // Memory cache should reflect merged values
            mockFileStat(1700000000000, 123456);
            const result = await cache.getMetadata(100, '/data/storage/ABCD1234/test.pdf');
            expect(result).not.toBeNull();
            expect(result!.has_content_cache).toBe(true); // preserved
            expect(result!.page_labels).toEqual({ 0: 'i' }); // preserved
            expect(result!.needs_ocr).toBe(true); // preserved
            expect(result!.has_text_layer).toBe(false); // preserved
            expect(result!.page_count).toBe(99); // updated
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

    // ===================================================================
    // getPageLabelsSync
    // ===================================================================

    describe('getPageLabelsSync', () => {
        it('returns labels from record in memory cache', async () => {
            const labels = { 0: 'A', 1: 'B' };
            await cache.setMetadata(makeRecord({ page_labels: labels }));

            expect(cache.getPageLabelsSync(100)).toEqual(labels);
        });

        it('returns null when no record exists', () => {
            expect(cache.getPageLabelsSync(999)).toBeNull();
        });

        it('returns null for record with page_labels=null', async () => {
            await cache.setMetadata(makeRecord({ page_labels: null }));
            expect(cache.getPageLabelsSync(100)).toBeNull();
        });

        it('returns null for record with page_labels={} (resolved, no labels)', async () => {
            await cache.setMetadata(makeRecord({ page_labels: {} }));
            expect(cache.getPageLabelsSync(100)).toBeNull();
        });
    });

    // ===================================================================
    // hasResolvedPageLabels
    // ===================================================================

    describe('hasResolvedPageLabels', () => {
        it('returns false when no record exists', () => {
            expect(cache.hasResolvedPageLabels(999)).toBe(false);
        });

        it('returns false when record has page_labels=null (not checked)', async () => {
            await cache.setMetadata(makeRecord({ page_labels: null }));
            expect(cache.hasResolvedPageLabels(100)).toBe(false);
        });

        it('returns true when record has page_labels={} (checked, none found)', async () => {
            await cache.setMetadata(makeRecord({ page_labels: {} }));
            expect(cache.hasResolvedPageLabels(100)).toBe(true);
        });

        it('returns true when record has populated page_labels', async () => {
            await cache.setMetadata(makeRecord({ page_labels: { 0: 'i', 1: '1' } }));
            expect(cache.hasResolvedPageLabels(100)).toBe(true);
        });

        it('returns false after record is deleted', async () => {
            await cache.setMetadata(makeRecord({ page_labels: { 0: 'A' } }));
            await cache.deleteMetadata(100);
            expect(cache.hasResolvedPageLabels(100)).toBe(false);
        });
    });

    // ===================================================================
    // ensureInMemoryCache
    // ===================================================================

    describe('ensureInMemoryCache', () => {
        it('loads record from DB into memory cache', async () => {
            await db.upsertAttachmentFileCache(makeRecord());
            expect((cache as any).memoryCache.has(100)).toBe(false);

            await cache.ensureInMemoryCache(100);
            expect((cache as any).memoryCache.has(100)).toBe(true);
        });

        it('is a no-op when record is already in memory', async () => {
            await cache.setMetadata(makeRecord());

            const dbSpy = vi.spyOn(db, 'getAttachmentFileCache');
            await cache.ensureInMemoryCache(100);
            expect(dbSpy).not.toHaveBeenCalled();
            dbSpy.mockRestore();
        });

        it('is a no-op when record does not exist in DB', async () => {
            await cache.ensureInMemoryCache(999);
            expect((cache as any).memoryCache.has(999)).toBe(false);
        });
    });

    // ===================================================================
    // Error-state metadata (encrypted, OCR, invalid)
    // ===================================================================

    describe('error-state metadata', () => {
        it('caches and returns is_encrypted=true record', async () => {
            const rec = makeRecord({
                is_encrypted: true,
                page_count: null,
                has_text_layer: null,
                needs_ocr: null,
            });
            await cache.setMetadata(rec);
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes);

            const result = await cache.getMetadata(100, rec.file_path);
            expect(result).not.toBeNull();
            expect(result!.is_encrypted).toBe(true);
        });

        it('caches and returns needs_ocr=true record', async () => {
            const rec = makeRecord({
                needs_ocr: true,
                has_text_layer: false,
            });
            await cache.setMetadata(rec);
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes);

            const result = await cache.getMetadata(100, rec.file_path);
            expect(result).not.toBeNull();
            expect(result!.needs_ocr).toBe(true);
            expect(result!.has_text_layer).toBe(false);
        });

        it('caches and returns is_invalid=true record', async () => {
            const rec = makeRecord({
                is_invalid: true,
                page_count: null,
            });
            await cache.setMetadata(rec);
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes);

            const result = await cache.getMetadata(100, rec.file_path);
            expect(result).not.toBeNull();
            expect(result!.is_invalid).toBe(true);
        });

        it('encrypted record returns from memory on second read (no DB hit)', async () => {
            const rec = makeRecord({ is_encrypted: true });
            await cache.setMetadata(rec);
            mockFileStat(rec.file_mtime_ms, rec.file_size_bytes);

            // First read (from memory, setMetadata already populated it)
            await cache.getMetadata(100, rec.file_path);

            const dbSpy = vi.spyOn(db, 'getAttachmentFileCache');
            const result = await cache.getMetadata(100, rec.file_path);
            expect(result!.is_encrypted).toBe(true);
            expect(dbSpy).not.toHaveBeenCalled();
            dbSpy.mockRestore();
        });

        it('needs_ocr=null record is distinguishable from needs_ocr=true/false', async () => {
            // Incomplete extraction — needs_ocr not yet determined
            const incomplete = makeRecord({ needs_ocr: null, has_text_layer: null });
            await cache.setMetadata(incomplete);
            mockFileStat(incomplete.file_mtime_ms, incomplete.file_size_bytes);

            const result = await cache.getMetadata(100, incomplete.file_path);
            expect(result!.needs_ocr).toBeNull();

            // Complete extraction — needs_ocr resolved
            await cache.setMetadata(makeRecord({ needs_ocr: false, has_text_layer: true }));
            const result2 = await cache.getMetadata(100, incomplete.file_path);
            expect(result2!.needs_ocr).toBe(false);
        });
    });

    // ===================================================================
    // Concurrent handler metadata races
    // ===================================================================

    describe('concurrent handler metadata races', () => {
        it('setMetadataPreservingContentFields preserves has_content_cache=true from earlier write', async () => {
            // Content was written first
            await cache.setMetadata(makeRecord({ has_content_cache: true }));

            // Pages handler updates metadata without content flag
            await cache.setMetadataPreservingContentFields(makeRecord({
                has_content_cache: false,
                page_count: 99,
            }));

            mockFileStat(1700000000000, 123456);
            const result = await cache.getMetadata(100, '/data/storage/ABCD1234/test.pdf');
            expect(result!.has_content_cache).toBe(true);
            expect(result!.page_count).toBe(99);
        });

        it('setMetadataPreservingContentFields preserves page_labels from earlier write when incoming is null', async () => {
            // Pages handler wrote labels first
            await cache.setMetadata(makeRecord({ page_labels: { 0: 'i', 1: '1' } }));

            // Second pages request with null labels should preserve existing
            await cache.setMetadataPreservingContentFields(makeRecord({
                page_labels: null,
                page_count: 10,
            }));

            mockFileStat(1700000000000, 123456);
            const result = await cache.getMetadata(100, '/data/storage/ABCD1234/test.pdf');
            expect(result!.page_labels).toEqual({ 0: 'i', 1: '1' });
        });

        it('setMetadataPreservingContentFields preserves needs_ocr from earlier write when incoming is null', async () => {
            // Authoritative handler wrote OCR status
            await cache.setMetadata(makeRecord({ needs_ocr: true, has_text_layer: false }));

            // Preload writes page-label-only record (needs_ocr: null)
            await cache.setMetadataPreservingContentFields(makeRecord({
                needs_ocr: null,
                has_text_layer: null,
                page_labels: { 0: 'iv' },
            }));

            mockFileStat(1700000000000, 123456);
            const result = await cache.getMetadata(100, '/data/storage/ABCD1234/test.pdf');
            expect(result!.needs_ocr).toBe(true);        // preserved
            expect(result!.has_text_layer).toBe(false);   // preserved
            expect(result!.page_labels).toEqual({ 0: 'iv' }); // updated
        });

        it('setMetadataPreservingContentFields overwrites needs_ocr when incoming is non-null', async () => {
            // Preload wrote partial record first (needs_ocr: null)
            await cache.setMetadata(makeRecord({ needs_ocr: null, has_text_layer: null }));

            // Authoritative handler writes full record
            await cache.setMetadataPreservingContentFields(makeRecord({
                needs_ocr: false,
                has_text_layer: true,
            }));

            mockFileStat(1700000000000, 123456);
            const result = await cache.getMetadata(100, '/data/storage/ABCD1234/test.pdf');
            expect(result!.needs_ocr).toBe(false);      // overwritten with non-null
            expect(result!.has_text_layer).toBe(true);   // overwritten with non-null
        });
    });

    // ===================================================================
    // Multi-library isolation
    // ===================================================================

    describe('multi-library isolation', () => {
        it('stores and retrieves records from different libraries independently', async () => {
            const rec1 = makeRecord({
                item_id: 1,
                library_id: 1,
                zotero_key: 'USER0001',
                file_path: '/user-lib/USER0001/a.pdf',
                page_count: 10,
            });
            const rec2 = makeRecord({
                item_id: 2,
                library_id: 5,
                zotero_key: 'GROUP001',
                file_path: '/group-lib/GROUP001/b.pdf',
                page_count: 20,
            });

            await cache.setMetadata(rec1);
            await cache.setMetadata(rec2);

            mockIOUtils.stat.mockImplementation(async (path: string) => {
                if (path.includes('user-lib') || path.includes('group-lib')) {
                    return { lastModified: 1700000000000, size: 123456 };
                }
                throw new Error('not found');
            });

            const r1 = await cache.getMetadata(1, '/user-lib/USER0001/a.pdf');
            const r2 = await cache.getMetadata(2, '/group-lib/GROUP001/b.pdf');

            expect(r1!.library_id).toBe(1);
            expect(r1!.page_count).toBe(10);
            expect(r2!.library_id).toBe(5);
            expect(r2!.page_count).toBe(20);
        });

        it('getMetadataBatch returns records from multiple libraries', async () => {
            const rec1 = makeRecord({ item_id: 1, library_id: 1, file_path: '/a.pdf' });
            const rec2 = makeRecord({ item_id: 2, library_id: 2, file_path: '/b.pdf' });

            await cache.setMetadata(rec1);
            await cache.setMetadata(rec2);

            mockFileStat(1700000000000, 123456);

            const result = await cache.getMetadataBatch([
                { itemId: 1, filePath: '/a.pdf' },
                { itemId: 2, filePath: '/b.pdf' },
            ]);

            expect(result.size).toBe(2);
            expect(result.get(1)!.library_id).toBe(1);
            expect(result.get(2)!.library_id).toBe(2);
        });

        it('deleteMetadataByLibrary only affects target library', async () => {
            await cache.setMetadata(makeRecord({ item_id: 1, library_id: 1, file_path: '/a.pdf' }));
            await cache.setMetadata(makeRecord({ item_id: 2, library_id: 1, file_path: '/b.pdf' }));
            await cache.setMetadata(makeRecord({ item_id: 3, library_id: 2, file_path: '/c.pdf' }));

            await cache.deleteMetadataByLibrary(1);

            expect(await db.getAttachmentFileCacheCount(1)).toBe(0);
            expect(await db.getAttachmentFileCacheCount(2)).toBe(1);

            // Library 2 still in memory cache
            mockFileStat(1700000000000, 123456);
            expect(await cache.getMetadata(3, '/c.pdf')).not.toBeNull();
        });
    });

    // ===================================================================
    // Memory cache LRU behavior — refresh on re-insert
    // ===================================================================

    describe('memory cache ordering', () => {
        it('Map.set on existing key preserves insertion order (FIFO, not LRU)', async () => {
            // Insert 500 entries
            for (let i = 1; i <= 500; i++) {
                await cache.setMetadata(makeRecord({
                    item_id: i,
                    zotero_key: `K${String(i).padStart(7, '0')}`,
                    file_path: `/path/${i}.pdf`,
                }));
            }

            // Re-set item 1 via setMetadataPreservingContentFields
            // This calls Map.set() which does NOT change insertion order
            await cache.setMetadataPreservingContentFields(makeRecord({
                item_id: 1,
                zotero_key: 'K0000001',
                file_path: '/path/1.pdf',
                page_count: 99,
            }));

            // Add item 501 — evicts item 1 because it's still first by insertion order
            await cache.setMetadata(makeRecord({
                item_id: 501,
                zotero_key: 'K0000501',
                file_path: '/path/501.pdf',
            }));

            mockFileStat(1700000000000, 123456);

            // Item 1 was evicted from memory, falls back to DB
            const dbSpy = vi.spyOn(db, 'getAttachmentFileCache');
            const r1 = await cache.getMetadata(1, '/path/1.pdf');
            expect(r1).not.toBeNull();
            expect(r1!.page_count).toBe(99);
            expect(dbSpy).toHaveBeenCalledWith(1); // loaded from DB
            dbSpy.mockRestore();
        });

        it('item 2 remains in memory after item 1 is evicted', async () => {
            // Insert 500 entries
            for (let i = 1; i <= 500; i++) {
                await cache.setMetadata(makeRecord({
                    item_id: i,
                    zotero_key: `K${String(i).padStart(7, '0')}`,
                    file_path: `/path/${i}.pdf`,
                }));
            }

            // Add item 501 — evicts item 1
            await cache.setMetadata(makeRecord({
                item_id: 501,
                zotero_key: 'K0000501',
                file_path: '/path/501.pdf',
            }));

            mockFileStat(1700000000000, 123456);

            // Item 2 is second-oldest and should still be in memory
            const dbSpy = vi.spyOn(db, 'getAttachmentFileCache');
            await cache.getMetadata(2, '/path/2.pdf');
            expect(dbSpy).not.toHaveBeenCalled();
            dbSpy.mockRestore();
        });
    });

    // ===================================================================
    // Error recovery
    // ===================================================================

    describe('error recovery', () => {
        it('setMetadata propagates DB write errors to caller', async () => {
            const spy = vi.spyOn(db, 'upsertAttachmentFileCache')
                .mockRejectedValue(new Error('disk full'));

            await expect(cache.setMetadata(makeRecord())).rejects.toThrow('disk full');

            // Memory cache should NOT be populated (error happened before putMemoryCache)
            expect((cache as any).memoryCache.has(100)).toBe(false);

            spy.mockRestore();
        });

        it('getMetadata returns null when IOUtils.stat throws', async () => {
            await cache.setMetadata(makeRecord());
            mockIOUtils.stat.mockRejectedValue(new Error('permission denied'));
            mockIOUtils.exists.mockResolvedValue(false);

            // isStale returns true when stat fails (file not accessible)
            const result = await cache.getMetadata(100, '/data/storage/ABCD1234/test.pdf');
            expect(result).toBeNull();
        });
    });
});

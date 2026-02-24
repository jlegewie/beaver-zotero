/**
 * Tests for AttachmentFileCache — Startup GC (runStartupGC) and
 * orphan content file removal (removeOrphanContentFiles).
 *
 * IOUtils is fully mocked to simulate file system operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BeaverDB } from '../src/services/database';
import {
    AttachmentFileCache,
    EXTRACTION_VERSION,
} from '../src/services/attachmentFileCache';
import { MockDBConnection } from './mocks/mockDBConnection';

// Cast globals for typed mock access
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

function makeRecord(overrides: any = {}) {
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AttachmentFileCache — startup GC', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;
    let cache: AttachmentFileCache;

    beforeEach(async () => {
        vi.clearAllMocks();

        conn = new MockDBConnection();
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');

        cache = new AttachmentFileCache(db);
        (cache as any).contentCacheDir = '/mock/profile/beaver/content-cache';
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    // ===================================================================
    // runStartupGC — stale extraction version
    // ===================================================================

    describe('runStartupGC — stale extraction version', () => {
        it('removes metadata row for stale extraction version', async () => {
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 1,
                extraction_version: 'old-version',
                has_content_cache: false,
            }));

            mockIOUtils.exists.mockResolvedValue(false);
            mockIOUtils.getChildren.mockResolvedValue([]);

            await cache.runStartupGC();

            expect(await db.getAttachmentFileCache(1)).toBeNull();
        });

        it('removes content file when stale record has has_content_cache=true', async () => {
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 2,
                extraction_version: 'old-version',
                has_content_cache: true,
            }));

            mockIOUtils.exists.mockImplementation(async (path: string) => {
                // Content file exists for removal
                if (path.includes('.json')) return true;
                return false;
            });
            mockIOUtils.getChildren.mockResolvedValue([]);

            await cache.runStartupGC();

            expect(await db.getAttachmentFileCache(2)).toBeNull();
            expect(mockIOUtils.remove).toHaveBeenCalled();
        });

        it('does not remove content file when stale record has has_content_cache=false', async () => {
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 3,
                extraction_version: 'old-version',
                has_content_cache: false,
            }));

            mockIOUtils.exists.mockResolvedValue(false);
            mockIOUtils.getChildren.mockResolvedValue([]);

            await cache.runStartupGC();

            expect(mockIOUtils.remove).not.toHaveBeenCalled();
        });
    });

    // ===================================================================
    // runStartupGC — source file missing
    // ===================================================================

    describe('runStartupGC — source file missing', () => {
        it('removes metadata when source PDF no longer exists', async () => {
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 10,
                extraction_version: EXTRACTION_VERSION,
                file_path: '/data/storage/GONE/missing.pdf',
                has_content_cache: false,
            }));

            // Source file does not exist
            mockIOUtils.exists.mockResolvedValue(false);
            mockIOUtils.getChildren.mockResolvedValue([]);

            await cache.runStartupGC();

            expect(await db.getAttachmentFileCache(10)).toBeNull();
        });

        it('removes metadata + content when source file is missing and has_content_cache=true', async () => {
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 11,
                extraction_version: EXTRACTION_VERSION,
                file_path: '/data/storage/GONE/missing.pdf',
                has_content_cache: true,
            }));

            mockIOUtils.exists.mockImplementation(async (path: string) => {
                // Source file does not exist, but content cache file does
                if (path.includes('.json')) return true;
                return false;
            });
            mockIOUtils.getChildren.mockResolvedValue([]);

            await cache.runStartupGC();

            expect(await db.getAttachmentFileCache(11)).toBeNull();
            expect(mockIOUtils.remove).toHaveBeenCalled();
        });

        it('removes metadata when IOUtils.exists throws for source file', async () => {
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 12,
                extraction_version: EXTRACTION_VERSION,
                has_content_cache: false,
            }));

            mockIOUtils.exists.mockRejectedValue(new Error('permission denied'));
            mockIOUtils.getChildren.mockResolvedValue([]);

            await cache.runStartupGC();

            expect(await db.getAttachmentFileCache(12)).toBeNull();
        });
    });

    // ===================================================================
    // runStartupGC — fresh records untouched
    // ===================================================================

    describe('runStartupGC — fresh records', () => {
        it('leaves fresh records untouched', async () => {
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 20,
                extraction_version: EXTRACTION_VERSION,
                file_path: '/data/storage/FRESH/good.pdf',
                has_content_cache: true,
            }));

            // Source file exists
            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.getChildren.mockResolvedValue([]);

            await cache.runStartupGC();

            // Record should still be present
            const record = await db.getAttachmentFileCache(20);
            expect(record).not.toBeNull();
            expect(record!.item_id).toBe(20);
        });

        it('processes mix of stale and fresh records correctly', async () => {
            // Fresh record
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 30,
                zotero_key: 'FRESH001',
                extraction_version: EXTRACTION_VERSION,
                file_path: '/data/storage/FRESH001/ok.pdf',
                has_content_cache: false,
            }));
            // Stale extraction version
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 31,
                zotero_key: 'STALE001',
                extraction_version: 'old',
                file_path: '/data/storage/STALE001/old.pdf',
                has_content_cache: false,
            }));
            // Source file missing
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 32,
                zotero_key: 'GONE0001',
                extraction_version: EXTRACTION_VERSION,
                file_path: '/data/storage/GONE0001/missing.pdf',
                has_content_cache: false,
            }));

            mockIOUtils.exists.mockImplementation(async (path: string) => {
                if (path.includes('FRESH001')) return true;
                return false;
            });
            mockIOUtils.getChildren.mockResolvedValue([]);

            await cache.runStartupGC();

            expect(await db.getAttachmentFileCache(30)).not.toBeNull();
            expect(await db.getAttachmentFileCache(31)).toBeNull();
            expect(await db.getAttachmentFileCache(32)).toBeNull();
        });
    });

    // ===================================================================
    // runStartupGC — empty database and disk
    // ===================================================================

    describe('runStartupGC — empty state', () => {
        it('does not error with empty database and empty disk', async () => {
            mockIOUtils.getChildren.mockResolvedValue([]);
            await expect(cache.runStartupGC()).resolves.toBeUndefined();
        });

        it('handles getChildren throwing (cache dir does not exist)', async () => {
            mockIOUtils.getChildren.mockRejectedValue(new Error('not found'));
            await expect(cache.runStartupGC()).resolves.toBeUndefined();
        });
    });

    // ===================================================================
    // removeOrphanContentFiles
    // ===================================================================

    describe('removeOrphanContentFiles (via runStartupGC)', () => {
        it('removes orphan JSON files that have no metadata row', async () => {
            // No metadata rows — any content files on disk are orphans
            mockIOUtils.exists.mockResolvedValue(false);
            mockIOUtils.getChildren
                .mockResolvedValueOnce(['/mock/profile/beaver/content-cache/1'])  // library dirs
                .mockResolvedValueOnce(['/mock/profile/beaver/content-cache/1/ORPHAN01.json']);  // files in lib 1

            await cache.runStartupGC();

            // The orphan file should be removed
            expect(mockIOUtils.remove).toHaveBeenCalledWith(
                '/mock/profile/beaver/content-cache/1/ORPHAN01.json'
            );
        });

        it('preserves content files that have matching metadata rows', async () => {
            // Insert a record with has_content_cache=true
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 40,
                library_id: 1,
                zotero_key: 'VALID001',
                extraction_version: EXTRACTION_VERSION,
                file_path: '/data/storage/VALID001/good.pdf',
                has_content_cache: true,
            }));

            // Source file exists for the record
            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.getChildren
                .mockResolvedValueOnce(['/mock/profile/beaver/content-cache/1'])
                .mockResolvedValueOnce(['/mock/profile/beaver/content-cache/1/VALID001.json']);

            await cache.runStartupGC();

            // File should NOT be removed
            expect(mockIOUtils.remove).not.toHaveBeenCalled();
        });

        it('removes orphan but preserves valid in same library dir', async () => {
            // Valid record
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 50,
                library_id: 2,
                zotero_key: 'KEEP0001',
                extraction_version: EXTRACTION_VERSION,
                file_path: '/data/storage/KEEP0001/good.pdf',
                has_content_cache: true,
            }));

            // Source file exists
            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.getChildren
                .mockResolvedValueOnce(['/mock/profile/beaver/content-cache/2'])
                .mockResolvedValueOnce([
                    '/mock/profile/beaver/content-cache/2/KEEP0001.json',
                    '/mock/profile/beaver/content-cache/2/ORPHAN01.json',
                ]);

            await cache.runStartupGC();

            // Only the orphan should be removed
            expect(mockIOUtils.remove).toHaveBeenCalledTimes(1);
            expect(mockIOUtils.remove).toHaveBeenCalledWith(
                '/mock/profile/beaver/content-cache/2/ORPHAN01.json'
            );
        });

        it('ignores non-JSON files in cache directories', async () => {
            mockIOUtils.exists.mockResolvedValue(false);
            mockIOUtils.getChildren
                .mockResolvedValueOnce(['/mock/profile/beaver/content-cache/1'])
                .mockResolvedValueOnce([
                    '/mock/profile/beaver/content-cache/1/notes.txt',
                    '/mock/profile/beaver/content-cache/1/.DS_Store',
                ]);

            await cache.runStartupGC();

            // Non-JSON files should not be touched
            expect(mockIOUtils.remove).not.toHaveBeenCalled();
        });

        it('ignores non-numeric directory names', async () => {
            mockIOUtils.exists.mockResolvedValue(false);
            mockIOUtils.getChildren
                .mockResolvedValueOnce([
                    '/mock/profile/beaver/content-cache/tmp',
                    '/mock/profile/beaver/content-cache/.hidden',
                ]);

            await cache.runStartupGC();

            // No files should be processed — dirs are non-numeric so skipped
            expect(mockIOUtils.remove).not.toHaveBeenCalled();
        });

        it('handles errors listing a library directory gracefully', async () => {
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 60,
                library_id: 1,
                zotero_key: 'VALID001',
                extraction_version: EXTRACTION_VERSION,
                has_content_cache: true,
            }));

            // Source file exists (record is fresh)
            mockIOUtils.exists.mockResolvedValue(true);
            // First getChildren for top-level dirs succeeds, second (listing dir) throws
            mockIOUtils.getChildren
                .mockResolvedValueOnce(['/mock/profile/beaver/content-cache/1'])
                .mockRejectedValueOnce(new Error('permission denied'));

            // Should not throw
            await expect(cache.runStartupGC()).resolves.toBeUndefined();
        });

        it('skips records with has_content_cache=false when building valid keys set', async () => {
            // Record exists but has_content_cache is false — its content file is an orphan
            await db.upsertAttachmentFileCache(makeRecord({
                item_id: 70,
                library_id: 1,
                zotero_key: 'NOCACHE1',
                extraction_version: EXTRACTION_VERSION,
                file_path: '/data/storage/NOCACHE1/ok.pdf',
                has_content_cache: false,
            }));

            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.getChildren
                .mockResolvedValueOnce(['/mock/profile/beaver/content-cache/1'])
                .mockResolvedValueOnce(['/mock/profile/beaver/content-cache/1/NOCACHE1.json']);

            await cache.runStartupGC();

            // File should be removed because record has has_content_cache=false
            expect(mockIOUtils.remove).toHaveBeenCalledWith(
                '/mock/profile/beaver/content-cache/1/NOCACHE1.json'
            );
        });
    });

    // ===================================================================
    // clearMemoryCache
    // ===================================================================

    describe('clearMemoryCache', () => {
        it('clears memory cache and write locks', async () => {
            await cache.setMetadata(makeRecord({ item_id: 80 }));
            expect((cache as any).memoryCache.size).toBe(1);

            cache.clearMemoryCache();

            expect((cache as any).memoryCache.size).toBe(0);
            expect((cache as any).contentWriteLocks.size).toBe(0);
        });
    });
});

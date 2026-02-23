/**
 * Tests for AttachmentFileCache — Tier 2 (content pages on disk) and
 * concurrent write serialization.
 *
 * IOUtils is fully mocked to simulate file read/write/exists operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BeaverDB } from '../src/services/database';
import {
    AttachmentFileCache,
    EXTRACTION_VERSION,
    CachedPageContent,
    AttachmentContentCache,
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

function makePage(index: number, content?: string): CachedPageContent {
    return {
        index,
        label: `p${index + 1}`,
        content: content ?? `Content of page ${index}`,
        width: 612,
        height: 792,
    };
}

function makeContentCache(overrides: Partial<AttachmentContentCache> = {}): AttachmentContentCache {
    return {
        extraction_version: EXTRACTION_VERSION,
        file_signature: { mtime_ms: 1700000000000, size_bytes: 123456 },
        total_pages: 10,
        pages_by_index: {},
        ...overrides,
    };
}

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

describe('AttachmentFileCache — content (Tier 2)', () => {
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
    // getContentRange
    // ===================================================================

    describe('getContentRange', () => {
        it('returns null when content file does not exist', async () => {
            mockIOUtils.exists.mockResolvedValue(false);
            const result = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 0, 2);
            expect(result).toBeNull();
        });

        it('returns pages for a full cache hit', async () => {
            const pages: Record<number, CachedPageContent> = {
                0: makePage(0),
                1: makePage(1),
                2: makePage(2),
            };
            const cacheData = makeContentCache({ pages_by_index: pages });

            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.readUTF8.mockResolvedValue(JSON.stringify(cacheData));
            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

            const result = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 0, 2);
            expect(result).not.toBeNull();
            expect(result).toHaveLength(3);
            expect(result![0].content).toBe('Content of page 0');
            expect(result![2].content).toBe('Content of page 2');
        });

        it('returns null for partial miss (one page missing)', async () => {
            const pages: Record<number, CachedPageContent> = {
                0: makePage(0),
                // page 1 missing
                2: makePage(2),
            };
            const cacheData = makeContentCache({ pages_by_index: pages });

            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.readUTF8.mockResolvedValue(JSON.stringify(cacheData));
            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

            const result = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 0, 2);
            expect(result).toBeNull();
        });

        it('returns null and removes file when extraction_version mismatches', async () => {
            const cacheData = makeContentCache({ extraction_version: 'old-version' });

            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.readUTF8.mockResolvedValue(JSON.stringify(cacheData));

            const result = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 0, 0);
            expect(result).toBeNull();
            expect(mockIOUtils.remove).toHaveBeenCalled();
        });

        it('returns null and removes file when file signature is stale (mtime)', async () => {
            const cacheData = makeContentCache({
                pages_by_index: { 0: makePage(0) },
            });

            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.readUTF8.mockResolvedValue(JSON.stringify(cacheData));
            // Different mtime
            mockIOUtils.stat.mockResolvedValue({ lastModified: 9999, size: 123456 });

            const result = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 0, 0);
            expect(result).toBeNull();
            expect(mockIOUtils.remove).toHaveBeenCalled();
        });

        it('returns null and removes file when file signature is stale (size)', async () => {
            const cacheData = makeContentCache({
                pages_by_index: { 0: makePage(0) },
            });

            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.readUTF8.mockResolvedValue(JSON.stringify(cacheData));
            // Different size
            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 999 });

            const result = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 0, 0);
            expect(result).toBeNull();
        });

        it('returns null for corrupted JSON', async () => {
            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.readUTF8.mockResolvedValue('{corrupted json');

            const result = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 0, 0);
            expect(result).toBeNull();
        });
    });

    // ===================================================================
    // setContentPages
    // ===================================================================

    describe('setContentPages', () => {
        it('does nothing for empty pages array', async () => {
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, []);
            expect(mockIOUtils.writeUTF8).not.toHaveBeenCalled();
        });

        it('creates new content file with pages', async () => {
            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockResolvedValue(false);

            const pages = [makePage(0), makePage(1)];
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, pages);

            expect(mockIOUtils.writeUTF8).toHaveBeenCalledTimes(1);
            const written = JSON.parse(mockIOUtils.writeUTF8.mock.calls[0][1]) as AttachmentContentCache;
            expect(written.extraction_version).toBe(EXTRACTION_VERSION);
            expect(written.total_pages).toBe(10);
            expect(written.pages_by_index[0].content).toBe('Content of page 0');
            expect(written.pages_by_index[1].content).toBe('Content of page 1');
        });

        it('merges pages into existing content file', async () => {
            const existingCache = makeContentCache({
                pages_by_index: { 0: makePage(0, 'existing page 0') },
            });

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            // First call: ensureLibraryDir, second: read existing
            mockIOUtils.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
            mockIOUtils.readUTF8.mockResolvedValue(JSON.stringify(existingCache));

            const newPages = [makePage(1, 'new page 1'), makePage(2, 'new page 2')];
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, newPages);

            const written = JSON.parse(mockIOUtils.writeUTF8.mock.calls[0][1]) as AttachmentContentCache;
            // Existing page preserved
            expect(written.pages_by_index[0].content).toBe('existing page 0');
            // New pages added
            expect(written.pages_by_index[1].content).toBe('new page 1');
            expect(written.pages_by_index[2].content).toBe('new page 2');
        });

        it('starts fresh when file signature changed', async () => {
            const existingCache = makeContentCache({
                file_signature: { mtime_ms: 1111, size_bytes: 2222 }, // different
                pages_by_index: { 0: makePage(0, 'old') },
            });

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
            mockIOUtils.readUTF8.mockResolvedValue(JSON.stringify(existingCache));

            const pages = [makePage(5, 'new')];
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, pages);

            const written = JSON.parse(mockIOUtils.writeUTF8.mock.calls[0][1]) as AttachmentContentCache;
            // Old page 0 should be gone (fresh start)
            expect(written.pages_by_index[0]).toBeUndefined();
            expect(written.pages_by_index[5].content).toBe('new');
        });

        it('starts fresh when extraction version changed', async () => {
            const existingCache = makeContentCache({
                extraction_version: 'old',
                pages_by_index: { 0: makePage(0, 'old') },
            });

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
            mockIOUtils.readUTF8.mockResolvedValue(JSON.stringify(existingCache));

            const pages = [makePage(3, 'new')];
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, pages);

            const written = JSON.parse(mockIOUtils.writeUTF8.mock.calls[0][1]) as AttachmentContentCache;
            expect(written.pages_by_index[0]).toBeUndefined();
            expect(written.pages_by_index[3].content).toBe('new');
        });

        it('updates has_content_cache flag in metadata', async () => {
            // Pre-populate a metadata row
            await db.upsertAttachmentFileCache(makeRecord({ has_content_cache: false }));

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockResolvedValue(false);

            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, [makePage(0)]);

            const meta = await db.getAttachmentFileCache(100);
            expect(meta!.has_content_cache).toBe(true);
        });

        it('does not downgrade has_content_cache from true', async () => {
            // Already true
            await db.upsertAttachmentFileCache(makeRecord({ has_content_cache: true }));

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockResolvedValue(false);

            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, [makePage(0)]);

            const meta = await db.getAttachmentFileCache(100);
            expect(meta!.has_content_cache).toBe(true);
        });

        it('handles IOUtils.stat failure gracefully (skips write)', async () => {
            mockIOUtils.stat.mockRejectedValue(new Error('disk error'));
            mockIOUtils.exists.mockResolvedValue(false);

            // Should not throw
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, [makePage(0)]);
            expect(mockIOUtils.writeUTF8).not.toHaveBeenCalled();
        });
    });

    // ===================================================================
    // Concurrent write serialization
    // ===================================================================

    describe('concurrent writes', () => {
        it('serializes two concurrent writes to the same key — no lost pages', async () => {
            // Each call will read "no existing file", write its pages
            let writeCount = 0;
            let lastWritten: AttachmentContentCache | null = null;

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockImplementation(async () => {
                // For ensureLibraryDir: return true
                // For content file: first call=false, second call reads what first wrote
                return writeCount > 0;
            });
            mockIOUtils.writeUTF8.mockImplementation(async (_path: string, content: string) => {
                lastWritten = JSON.parse(content);
                writeCount++;
            });
            mockIOUtils.readUTF8.mockImplementation(async () => {
                // When second write reads, return what first write wrote
                return lastWritten ? JSON.stringify(lastWritten) : '{}';
            });

            // Fire two writes concurrently
            const p1 = cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, [makePage(0, 'from-write-1')]);
            const p2 = cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, [makePage(1, 'from-write-2')]);

            await Promise.all([p1, p2]);

            // Both writes should have completed
            expect(writeCount).toBe(2);
            // The final file should contain both pages
            expect(lastWritten!.pages_by_index[0]?.content).toBe('from-write-1');
            expect(lastWritten!.pages_by_index[1]?.content).toBe('from-write-2');
        });

        it('writes for different keys execute independently', async () => {
            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockResolvedValue(false);

            const writes: string[] = [];
            mockIOUtils.writeUTF8.mockImplementation(async (path: string) => {
                writes.push(path);
            });

            const p1 = cache.setContentPages(1, 'KEY00001', '/a.pdf', 5, [makePage(0)]);
            const p2 = cache.setContentPages(1, 'KEY00002', '/b.pdf', 5, [makePage(0)]);

            await Promise.all([p1, p2]);

            // Both should write (to different paths)
            expect(writes).toHaveLength(2);
            expect(writes.some(p => p.includes('KEY00001'))).toBe(true);
            expect(writes.some(p => p.includes('KEY00002'))).toBe(true);
        });

        it('error in one write does not block subsequent writes', async () => {
            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockResolvedValue(false);

            let callCount = 0;
            mockIOUtils.writeUTF8.mockImplementation(async () => {
                callCount++;
                if (callCount === 1) throw new Error('disk full');
            });

            // First write will fail
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, [makePage(0)]);
            // Second write should still succeed
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, [makePage(1)]);

            expect(callCount).toBe(2);
        });

        it('cleans up write lock after chain settles', async () => {
            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockResolvedValue(false);
            mockIOUtils.writeUTF8.mockResolvedValue(undefined);

            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, [makePage(0)]);

            // Allow microtasks to settle
            await new Promise(r => setTimeout(r, 10));

            const locks = (cache as any).contentWriteLocks as Map<string, Promise<void>>;
            expect(locks.has('1/ABCD1234')).toBe(false);
        });
    });

    // ===================================================================
    // deleteContent / deleteContentByLibrary
    // ===================================================================

    describe('deleteContent', () => {
        it('removes content file when it exists', async () => {
            mockIOUtils.exists.mockResolvedValue(true);
            await cache.deleteContent(1, 'ABCD1234');
            expect(mockIOUtils.remove).toHaveBeenCalled();
        });

        it('does not error when file does not exist', async () => {
            mockIOUtils.exists.mockResolvedValue(false);
            await expect(cache.deleteContent(1, 'NOPE0000')).resolves.toBeUndefined();
        });
    });

    describe('deleteContentByLibrary', () => {
        it('removes library directory recursively', async () => {
            mockIOUtils.exists.mockResolvedValue(true);
            await cache.deleteContentByLibrary(1);
            expect(mockIOUtils.remove).toHaveBeenCalledWith(
                expect.stringContaining('1'),
                { recursive: true }
            );
        });

        it('does not error when directory does not exist', async () => {
            mockIOUtils.exists.mockResolvedValue(false);
            await expect(cache.deleteContentByLibrary(99)).resolves.toBeUndefined();
        });
    });

    // ===================================================================
    // invalidate / invalidateByLibrary
    // ===================================================================

    describe('invalidate', () => {
        it('removes metadata (DB + memory) and content file', async () => {
            await cache.setMetadata(makeRecord());
            mockIOUtils.exists.mockResolvedValue(true);

            await cache.invalidate(100, 1, 'ABCD1234');

            // DB gone
            expect(await db.getAttachmentFileCache(100)).toBeNull();
            // Content file removal attempted
            expect(mockIOUtils.remove).toHaveBeenCalled();
        });
    });

    describe('invalidateByLibrary', () => {
        it('removes all metadata and content for a library', async () => {
            await cache.setMetadata(makeRecord({ item_id: 1, library_id: 5 }));
            await cache.setMetadata(makeRecord({ item_id: 2, library_id: 5 }));

            mockIOUtils.exists.mockResolvedValue(true);
            await cache.invalidateByLibrary(5);

            expect(await db.getAttachmentFileCacheCount(5)).toBe(0);
            expect(mockIOUtils.remove).toHaveBeenCalled();
        });
    });

    // ===================================================================
    // Overlapping range extension (test #81)
    // ===================================================================

    describe('overlapping range extension', () => {
        it('merges new pages into existing cache — overlapping ranges preserve all pages', async () => {
            // Simulate two sequential setContentPages calls, where the second
            // reads back what the first wrote and merges.
            let storedData: string | null = null;

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.writeUTF8.mockImplementation(async (_path: string, content: string) => {
                storedData = content;
            });
            mockIOUtils.readUTF8.mockImplementation(async () => {
                return storedData ?? '';
            });

            // First write: pages 0-4
            mockIOUtils.exists.mockResolvedValue(false);
            const firstBatch = Array.from({ length: 5 }, (_, i) => makePage(i, `page-${i}`));
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, firstBatch);

            expect(storedData).not.toBeNull();
            const afterFirst = JSON.parse(storedData!) as AttachmentContentCache;
            expect(Object.keys(afterFirst.pages_by_index)).toHaveLength(5);

            // Second write: pages 3-7 (overlaps 3-4, adds 5-7)
            mockIOUtils.exists.mockResolvedValue(true);
            const secondBatch = Array.from({ length: 5 }, (_, i) => makePage(i + 3, `page-${i + 3}-v2`));
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, secondBatch);

            const afterSecond = JSON.parse(storedData!) as AttachmentContentCache;
            // Pages 0-7 should all be present
            expect(Object.keys(afterSecond.pages_by_index)).toHaveLength(8);
            // Pages 0-2 preserved from first write
            expect(afterSecond.pages_by_index[0].content).toBe('page-0');
            expect(afterSecond.pages_by_index[1].content).toBe('page-1');
            expect(afterSecond.pages_by_index[2].content).toBe('page-2');
            // Pages 3-4 overwritten by second write
            expect(afterSecond.pages_by_index[3].content).toBe('page-3-v2');
            expect(afterSecond.pages_by_index[4].content).toBe('page-4-v2');
            // Pages 5-7 added by second write
            expect(afterSecond.pages_by_index[5].content).toBe('page-5-v2');
            expect(afterSecond.pages_by_index[6].content).toBe('page-6-v2');
            expect(afterSecond.pages_by_index[7].content).toBe('page-7-v2');
        });

        it('getContentRange returns null for partial miss after partial cache', async () => {
            const pages: Record<number, CachedPageContent> = {};
            for (let i = 0; i < 5; i++) pages[i] = makePage(i);
            const cacheData = makeContentCache({ pages_by_index: pages, total_pages: 10 });

            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.readUTF8.mockResolvedValue(JSON.stringify(cacheData));
            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });

            // Pages 0-4 cached, requesting 2-7 — pages 5-7 missing
            const result = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 2, 7);
            expect(result).toBeNull();

            // Pages 0-4 should still be a hit
            const hit = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 0, 4);
            expect(hit).toHaveLength(5);
        });
    });

    // ===================================================================
    // Entire document after partial cache (test #82)
    // ===================================================================

    describe('entire document after partial cache', () => {
        it('fills remaining pages to complete entire document', async () => {
            let storedData: string | null = null;

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.writeUTF8.mockImplementation(async (_path: string, content: string) => {
                storedData = content;
            });
            mockIOUtils.readUTF8.mockImplementation(async () => {
                return storedData ?? '';
            });

            // First write: pages 0-4 of a 10-page doc
            mockIOUtils.exists.mockResolvedValue(false);
            const firstBatch = Array.from({ length: 5 }, (_, i) => makePage(i, `page-${i}`));
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, firstBatch);

            // Second write: pages 5-9 to complete the doc
            mockIOUtils.exists.mockResolvedValue(true);
            const secondBatch = Array.from({ length: 5 }, (_, i) => makePage(i + 5, `page-${i + 5}`));
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, secondBatch);

            const final = JSON.parse(storedData!) as AttachmentContentCache;
            expect(Object.keys(final.pages_by_index)).toHaveLength(10);
            for (let i = 0; i < 10; i++) {
                expect(final.pages_by_index[i].content).toBe(`page-${i}`);
            }
        });
    });

    // ===================================================================
    // Content file missing while metadata says has_content_cache (test #111)
    // ===================================================================

    describe('content file deleted while metadata present', () => {
        it('getContentRange returns null when content file is missing', async () => {
            // Metadata says has_content_cache=true
            await db.upsertAttachmentFileCache(makeRecord({ has_content_cache: true }));

            // But the JSON file doesn't exist on disk
            mockIOUtils.exists.mockResolvedValue(false);

            const result = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 0, 4);
            expect(result).toBeNull();
        });

        it('subsequent setContentPages writes fresh file after deletion', async () => {
            let storedData: string | null = null;

            await db.upsertAttachmentFileCache(makeRecord({ has_content_cache: true }));

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockResolvedValue(false); // file deleted
            mockIOUtils.writeUTF8.mockImplementation(async (_path: string, content: string) => {
                storedData = content;
            });

            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, [makePage(0)]);

            expect(storedData).not.toBeNull();
            const written = JSON.parse(storedData!) as AttachmentContentCache;
            expect(written.pages_by_index[0]).toBeDefined();
            expect(written.total_pages).toBe(10);
        });
    });

    // ===================================================================
    // Multi-library content isolation (test #113)
    // ===================================================================

    describe('multi-library content isolation', () => {
        it('stores content files in separate library subdirectories', async () => {
            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockResolvedValue(false);

            const writePaths: string[] = [];
            mockIOUtils.writeUTF8.mockImplementation(async (path: string) => {
                writePaths.push(path);
            });

            await cache.setContentPages(1, 'USER0001', '/a.pdf', 5, [makePage(0)]);
            await cache.setContentPages(5, 'GROUP001', '/b.pdf', 5, [makePage(0)]);

            expect(writePaths).toHaveLength(2);
            expect(writePaths[0]).toContain('/1/USER0001.json');
            expect(writePaths[1]).toContain('/5/GROUP001.json');
        });
    });

    // ===================================================================
    // Rapid sequential writes (test #134)
    // ===================================================================

    describe('rapid sequential writes', () => {
        it('five sequential writes to same key produce correct merged result', async () => {
            let storedData: string | null = null;

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.writeUTF8.mockImplementation(async (_path: string, content: string) => {
                storedData = content;
            });
            mockIOUtils.readUTF8.mockImplementation(async () => {
                return storedData ?? '';
            });

            // First write creates the file
            mockIOUtils.exists.mockResolvedValueOnce(false);
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 50, [makePage(0, 'w1')]);

            // Subsequent writes merge
            for (let w = 1; w <= 4; w++) {
                mockIOUtils.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
                await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 50, [makePage(w, `w${w + 1}`)]);
            }

            const final = JSON.parse(storedData!) as AttachmentContentCache;
            expect(Object.keys(final.pages_by_index)).toHaveLength(5);
            expect(final.pages_by_index[0].content).toBe('w1');
            expect(final.pages_by_index[1].content).toBe('w2');
            expect(final.pages_by_index[2].content).toBe('w3');
            expect(final.pages_by_index[3].content).toBe('w4');
            expect(final.pages_by_index[4].content).toBe('w5');
        });

        it('concurrent fire-and-forget writes serialize correctly', async () => {
            let storedData: string | null = null;
            let writeCount = 0;

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.writeUTF8.mockImplementation(async (_path: string, content: string) => {
                storedData = content;
                writeCount++;
            });
            mockIOUtils.readUTF8.mockImplementation(async () => {
                return storedData ?? '';
            });
            mockIOUtils.exists.mockImplementation(async () => {
                return storedData !== null;
            });

            // Fire 5 writes simultaneously
            const promises = Array.from({ length: 5 }, (_, i) =>
                cache.setContentPages(1, 'ABCD1234', '/a.pdf', 50, [makePage(i, `concurrent-${i}`)])
            );
            await Promise.all(promises);

            expect(writeCount).toBe(5);
            const final = JSON.parse(storedData!) as AttachmentContentCache;
            // All 5 pages should be present (serialized writes merge correctly)
            expect(Object.keys(final.pages_by_index)).toHaveLength(5);
            for (let i = 0; i < 5; i++) {
                expect(final.pages_by_index[i].content).toBe(`concurrent-${i}`);
            }
        });
    });

    // ===================================================================
    // Error recovery — content tier (test #123, #125, #126)
    // ===================================================================

    describe('error recovery — content tier', () => {
        it('DB flag update failure does not prevent content file write', async () => {
            // Pre-populate metadata
            await db.upsertAttachmentFileCache(makeRecord({ has_content_cache: false }));

            mockIOUtils.stat.mockResolvedValue({ lastModified: 1700000000000, size: 123456 });
            mockIOUtils.exists.mockResolvedValue(false);

            // Make the DB flag update fail
            const spy = vi.spyOn(db, 'updateContentCacheFlag')
                .mockRejectedValue(new Error('disk full'));

            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, [makePage(0)]);

            // Content file was still written
            expect(mockIOUtils.writeUTF8).toHaveBeenCalledTimes(1);

            spy.mockRestore();
        });

        it('IOUtils.stat failure in setContentPages skips write gracefully', async () => {
            mockIOUtils.stat.mockRejectedValue(new Error('file vanished'));
            mockIOUtils.exists.mockResolvedValue(false);

            // Should not throw
            await cache.setContentPages(1, 'ABCD1234', '/a.pdf', 10, [makePage(0)]);
            expect(mockIOUtils.writeUTF8).not.toHaveBeenCalled();
        });

        it('corrupted content cache JSON triggers fresh extraction on next read', async () => {
            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.readUTF8.mockResolvedValue('not valid json {{{');

            const result = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 0, 0);
            expect(result).toBeNull();
        });

        it('IOUtils.readUTF8 failure returns null from getContentRange', async () => {
            mockIOUtils.exists.mockResolvedValue(true);
            mockIOUtils.readUTF8.mockRejectedValue(new Error('I/O error'));

            const result = await cache.getContentRange(1, 'ABCD1234', '/a.pdf', 0, 0);
            expect(result).toBeNull();
        });
    });
});

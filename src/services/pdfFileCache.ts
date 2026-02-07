/**
 * PDF File Metadata Cache
 *
 * Two-tier cache (in-memory LRU + SQLite) for immutable PDF file properties:
 * page count, encryption status, OCR needs. Validated by file modification
 * time on every read to guarantee correctness.
 */

import { logger } from '../utils/logger';
import { AttachmentFileCacheRecord } from './database';

/**
 * Application-level cache entry with boolean types (vs SQLite integer booleans).
 */
export interface PDFFileCacheEntry {
    item_id: number;
    library_id: number;
    file_mtime: number;
    page_count: number | null;
    is_encrypted: boolean;
    is_invalid_pdf: boolean;
    needs_ocr: boolean | null;
    ocr_primary_reason: string | null;
}

/**
 * Convert a DB record (SQLite integer booleans) to an application-level entry.
 */
function recordToEntry(record: AttachmentFileCacheRecord): PDFFileCacheEntry {
    return {
        item_id: record.item_id,
        library_id: record.library_id,
        file_mtime: record.file_mtime,
        page_count: record.page_count,
        is_encrypted: record.is_encrypted === 1,
        is_invalid_pdf: record.is_invalid_pdf === 1,
        needs_ocr: record.needs_ocr === null ? null : record.needs_ocr === 1,
        ocr_primary_reason: record.ocr_primary_reason,
    };
}

/**
 * Convert an application-level entry to a DB record format.
 */
function entryToRecord(entry: PDFFileCacheEntry): Omit<AttachmentFileCacheRecord, 'cached_at'> {
    return {
        item_id: entry.item_id,
        library_id: entry.library_id,
        file_mtime: entry.file_mtime,
        page_count: entry.page_count,
        is_encrypted: entry.is_encrypted ? 1 : 0,
        is_invalid_pdf: entry.is_invalid_pdf ? 1 : 0,
        needs_ocr: entry.needs_ocr === null ? null : (entry.needs_ocr ? 1 : 0),
        ocr_primary_reason: entry.ocr_primary_reason,
    };
}

/**
 * Get the file modification time for an attachment.
 * Returns null if the mtime cannot be determined.
 */
async function getFileMtime(attachment: Zotero.Item): Promise<number | null> {
    try {
        const mtime = await attachment.attachmentModificationTime;
        if (mtime && mtime > 0) {
            return mtime;
        }
        return null;
    } catch {
        return null;
    }
}

export class PDFFileCache {
    private memoryCache: Map<number, PDFFileCacheEntry>;
    private readonly MAX_SIZE = 500;

    constructor() {
        this.memoryCache = new Map();
    }

    /**
     * Get a cached entry for an attachment, validating mtime.
     * Returns null on cache miss or stale entry.
     *
     * Lookup order:
     * 1. In-memory map (fastest)
     * 2. SQLite table (persists across sessions)
     * Both are validated against current file mtime.
     */
    async get(attachment: Zotero.Item): Promise<PDFFileCacheEntry | null> {
        const itemId = attachment.id;

        // Get current mtime for validation
        const currentMtime = await getFileMtime(attachment);
        if (currentMtime === null) {
            // Can't validate — treat as miss
            return null;
        }

        // 1. Check memory cache
        const memEntry = this.memoryCache.get(itemId);
        if (memEntry) {
            if (memEntry.file_mtime === currentMtime) {
                return memEntry;
            }
            // Stale — remove from memory
            this.memoryCache.delete(itemId);
        }

        // 2. Check SQLite
        const db = addon.db;
        if (!db) return null;

        try {
            const record = await db.getAttachmentFileCache(itemId);
            if (record && record.file_mtime === currentMtime) {
                const entry = recordToEntry(record);
                // Promote to memory cache
                this.setMemory(itemId, entry);
                return entry;
            }
        } catch (e) {
            logger(`PDFFileCache.get: SQLite lookup failed for item ${itemId}: ${e}`, 1);
        }

        return null;
    }

    /**
     * Store a cache entry in both memory and SQLite.
     */
    async set(entry: PDFFileCacheEntry): Promise<void> {
        // Write to memory
        this.setMemory(entry.item_id, entry);

        // Write to SQLite
        const db = addon.db;
        if (!db) return;

        try {
            await db.upsertAttachmentFileCache(entryToRecord(entry));
        } catch (e) {
            logger(`PDFFileCache.set: SQLite write failed for item ${entry.item_id}: ${e}`, 1);
        }
    }

    /**
     * Invalidate cache entries by item IDs (both memory and SQLite).
     */
    async invalidate(itemIds: number[]): Promise<void> {
        if (itemIds.length === 0) return;

        // Remove from memory
        for (const id of itemIds) {
            this.memoryCache.delete(id);
        }

        // Remove from SQLite
        const db = addon.db;
        if (!db) return;

        try {
            await db.deleteAttachmentFileCache(itemIds);
        } catch (e) {
            logger(`PDFFileCache.invalidate: SQLite delete failed: ${e}`, 1);
        }
    }

    /**
     * Invalidate all cache entries for a library.
     */
    async invalidateLibrary(libraryId: number): Promise<void> {
        // Remove matching entries from memory
        for (const [id, entry] of this.memoryCache) {
            if (entry.library_id === libraryId) {
                this.memoryCache.delete(id);
            }
        }

        // Remove from SQLite
        const db = addon.db;
        if (!db) return;

        try {
            await db.deleteAttachmentFileCacheByLibrary(libraryId);
        } catch (e) {
            logger(`PDFFileCache.invalidateLibrary: SQLite delete failed for library ${libraryId}: ${e}`, 1);
        }
    }

    /**
     * Clear the in-memory cache (SQLite entries remain for next session).
     */
    clearMemory(): void {
        this.memoryCache.clear();
    }

    /**
     * Write to in-memory cache with LRU eviction.
     */
    private setMemory(itemId: number, entry: PDFFileCacheEntry): void {
        // Delete first so re-insertion moves to end (Map preserves insertion order)
        this.memoryCache.delete(itemId);
        this.memoryCache.set(itemId, entry);

        // Evict oldest entries if over capacity
        if (this.memoryCache.size > this.MAX_SIZE) {
            const firstKey = this.memoryCache.keys().next().value;
            if (firstKey !== undefined) {
                this.memoryCache.delete(firstKey);
            }
        }
    }
}

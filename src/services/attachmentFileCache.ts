/**
 * Attachment File Cache Service
 *
 * Two-tier cache for PDF attachment metadata and page content:
 * - Tier 1 (metadata): SQLite via BeaverDB + in-memory Map
 * - Tier 2 (page content): JSON files on disk under <profileDir>/beaver/content-cache/
 *
 * Staleness is determined by comparing file mtime+size and extraction version.
 * Stale entries are invalidated immediately on read.
 */

import { BeaverDB, AttachmentFileCacheRecord } from './database';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Bump this when the extraction output semantics change.
 * All cached data with a different version will be treated as stale.
 */
export const EXTRACTION_VERSION = '1';

/** Maximum entries in the in-memory metadata cache. */
const MEMORY_CACHE_MAX = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileSignature {
    mtime_ms: number;
    size_bytes: number;
}

export interface CachedPageContent {
    index: number;
    label?: string;
    content: string;
    width: number;
    height: number;
}

/**
 * Sparse page map — supports caching only requested ranges on first run.
 */
export interface AttachmentContentCache {
    extraction_version: string;
    file_signature: FileSignature;
    total_pages: number;
    pages_by_index: Record<number, CachedPageContent>;
}

export interface AttachmentFileCacheStats {
    metadata_count: number;
    memory_cache_size: number;
    content_cache_dir: string;
}

// Re-export the record type for consumers
export type { AttachmentFileCacheRecord };

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class AttachmentFileCache {
    private db: BeaverDB;
    private memoryCache = new Map<number, AttachmentFileCacheRecord>();
    private contentCacheDir: string = '';
    /** Per-key promise chain to serialize read-modify-write on content files. */
    private contentWriteLocks = new Map<string, Promise<void>>();

    constructor(db: BeaverDB) {
        this.db = db;
    }

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    /**
     * Create the content-cache directory under the Zotero profile.
     * Must be called once after construction (before any content operations).
     */
    async init(): Promise<void> {
        const profileDir = Zotero.File.pathToFile(Zotero.Profile.dir);
        const beaverDir = profileDir.clone();
        beaverDir.append('beaver');
        if (!beaverDir.exists()) {
            beaverDir.create(Ci.nsIFile.DIRECTORY_TYPE ?? 1, 0o700);
        }

        const cacheDir = beaverDir.clone();
        cacheDir.append('content-cache');
        if (!cacheDir.exists()) {
            cacheDir.create(Ci.nsIFile.DIRECTORY_TYPE ?? 1, 0o700);
        }

        this.contentCacheDir = cacheDir.path;
    }

    /**
     * Remove stale/orphan entries and files at startup.
     */
    async runStartupGC(): Promise<void> {
        try {
            const allRecords = await this.db.getAllAttachmentFileCache();
            let removedMetadata = 0;
            let removedContent = 0;

            for (const record of allRecords) {
                let shouldRemove = false;

                // Remove if extraction version is stale
                if (record.extraction_version !== EXTRACTION_VERSION) {
                    shouldRemove = true;
                }

                // Remove if the source file no longer exists
                if (!shouldRemove) {
                    try {
                        const exists = await IOUtils.exists(record.file_path);
                        if (!exists) {
                            shouldRemove = true;
                        }
                    } catch {
                        shouldRemove = true;
                    }
                }

                if (shouldRemove) {
                    await this.db.deleteAttachmentFileCache(record.item_id);
                    this.memoryCache.delete(record.item_id);
                    removedMetadata++;

                    // Remove content file if it exists
                    await this.removeContentFile(record.library_id, record.zotero_key);
                    removedContent++;
                }
            }

            // Remove orphan content files (content files without metadata rows)
            await this.removeOrphanContentFiles(allRecords);

            if (removedMetadata > 0 || removedContent > 0) {
                logger(`AttachmentFileCache GC: removed ${removedMetadata} metadata rows, ${removedContent} content files`);
            }
        } catch (error) {
            logger(`AttachmentFileCache.runStartupGC error: ${error}`, 1);
        }
    }

    /**
     * Synchronous lookup of page labels from the in-memory metadata cache.
     * Returns populated labels when available, null otherwise.
     *
     * Returns null for:
     * - no record at all
     * - record with `page_labels: null` (labels not yet checked)
     * - record with `page_labels: {}` (checked, none found)
     *
     * Designed for use in synchronous rendering paths (e.g., citation export).
     * Call `getMetadata` first to populate the cache if needed.
     */
    getPageLabelsSync(itemId: number): Record<number, string> | null {
        const labels = this.memoryCache.get(itemId)?.page_labels;
        if (!labels || Object.keys(labels).length === 0) return null;
        return labels;
    }

    /** Clear the in-memory metadata cache and pending write locks. */
    clearMemoryCache(): void {
        this.memoryCache.clear();
        this.contentWriteLocks.clear();
    }

    // -----------------------------------------------------------------------
    // Metadata (Tier 1)
    // -----------------------------------------------------------------------

    /**
     * Get metadata for an attachment by item ID.
     * Returns the cached record if fresh, or null if stale/missing.
     *
     * @param itemId - Zotero item ID
     * @param filePath - Current file path (for staleness check)
     */
    async getMetadata(itemId: number, filePath: string): Promise<AttachmentFileCacheRecord | null> {
        // Check memory cache first
        let record = this.memoryCache.get(itemId) ?? null;
        let source: 'memory' | 'db' | null = record ? 'memory' : null;

        // Fall back to DB
        if (!record) {
            record = await this.db.getAttachmentFileCache(itemId);
            if (record) {
                source = 'db';
                this.putMemoryCache(itemId, record);
            }
        }

        if (!record) {
            logger(`AttachmentFileCache.getMetadata: miss item=${itemId}`);
            return null;
        }

        // Staleness check
        const stale = await this.isStale(record, filePath);
        if (stale) {
            logger(`AttachmentFileCache.getMetadata: stale item=${itemId}, invalidating`);
            await this.invalidate(itemId, record.library_id, record.zotero_key);
            return null;
        }

        logger(`AttachmentFileCache.getMetadata: hit item=${itemId} source=${source} pages=${record.page_count ?? '?'} ocr=${record.needs_ocr}`);
        return record;
    }

    /**
     * Get metadata for an attachment by library ID and Zotero key.
     */
    async getMetadataByKey(libraryId: number, zoteroKey: string, filePath: string): Promise<AttachmentFileCacheRecord | null> {
        const record = await this.db.getAttachmentFileCacheByKey(libraryId, zoteroKey);
        if (!record) return null;

        this.putMemoryCache(record.item_id, record);

        const stale = await this.isStale(record, filePath);
        if (stale) {
            await this.invalidate(record.item_id, libraryId, zoteroKey);
            return null;
        }

        return record;
    }

    /**
     * Get metadata for multiple attachments by item IDs.
     * Returns a Map of item_id -> record (only fresh entries).
     */
    async getMetadataBatch(items: Array<{ itemId: number; filePath: string }>): Promise<Map<number, AttachmentFileCacheRecord>> {
        const result = new Map<number, AttachmentFileCacheRecord>();
        const idsToFetch: number[] = [];

        // Check memory cache first
        for (const { itemId, filePath } of items) {
            const cached = this.memoryCache.get(itemId);
            if (cached) {
                const stale = await this.isStale(cached, filePath);
                if (!stale) {
                    result.set(itemId, cached);
                } else {
                    await this.invalidate(itemId, cached.library_id, cached.zotero_key);
                }
            } else {
                idsToFetch.push(itemId);
            }
        }

        // Fetch remaining from DB
        if (idsToFetch.length > 0) {
            const dbRecords = await this.db.getAttachmentFileCacheBatch(idsToFetch);
            const filePathMap = new Map(items.map(i => [i.itemId, i.filePath]));

            for (const [itemId, record] of dbRecords) {
                const filePath = filePathMap.get(itemId)!;
                const stale = await this.isStale(record, filePath);
                if (!stale) {
                    this.putMemoryCache(itemId, record);
                    result.set(itemId, record);
                } else {
                    await this.invalidate(itemId, record.library_id, record.zotero_key);
                }
            }
        }

        return result;
    }

    /**
     * Store metadata for an attachment (full upsert — overwrites all fields).
     */
    async setMetadata(input: Omit<AttachmentFileCacheRecord, 'cached_at'>): Promise<void> {
        logger(`AttachmentFileCache.setMetadata: item=${input.item_id} key=${input.zotero_key} pages=${input.page_count ?? '?'}`);
        await this.db.upsertAttachmentFileCache(input);
        const record: AttachmentFileCacheRecord = {
            ...input,
            cached_at: new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ''),
        };
        this.putMemoryCache(input.item_id, record);
    }

    /**
     * Store metadata for multiple attachments.
     */
    async setMetadataBatch(inputs: Array<Omit<AttachmentFileCacheRecord, 'cached_at'>>): Promise<void> {
        if (inputs.length === 0) return;
        logger(`AttachmentFileCache.setMetadataBatch: ${inputs.length} items [${inputs.slice(0, 5).map(i => i.item_id).join(', ')}${inputs.length > 5 ? ', ...' : ''}]`);
        await this.db.upsertAttachmentFileCacheBatch(inputs);
        const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
        for (const input of inputs) {
            this.putMemoryCache(input.item_id, { ...input, cached_at: now });
        }
    }

    /**
     * Delete metadata for an attachment.
     */
    async deleteMetadata(itemId: number): Promise<void> {
        logger(`AttachmentFileCache.deleteMetadata: item=${itemId}`);
        await this.db.deleteAttachmentFileCache(itemId);
        this.memoryCache.delete(itemId);
    }

    /**
     * Delete all metadata for a library.
     */
    async deleteMetadataByLibrary(libraryId: number): Promise<void> {
        await this.db.deleteAttachmentFileCacheByLibrary(libraryId);
        // Clear memory cache entries for this library
        for (const [id, record] of this.memoryCache) {
            if (record.library_id === libraryId) {
                this.memoryCache.delete(id);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Content (Tier 2 — disk)
    // -----------------------------------------------------------------------

    /**
     * Get cached page content for a range of pages.
     * Returns null if any page in the range is missing from the cache.
     *
     * @param libraryId - Zotero library ID
     * @param zoteroKey - Zotero item key
     * @param filePath - Current file path (for staleness check)
     * @param startIndex - 0-based start page index (inclusive)
     * @param endIndex - 0-based end page index (inclusive)
     */
    async getContentRange(
        libraryId: number,
        zoteroKey: string,
        filePath: string,
        startIndex: number,
        endIndex: number
    ): Promise<CachedPageContent[] | null> {
        const contentFile = this.getContentFilePath(libraryId, zoteroKey);

        try {
            const exists = await IOUtils.exists(contentFile);
            if (!exists) return null;

            const raw = await IOUtils.readUTF8(contentFile);
            const cache: AttachmentContentCache = JSON.parse(raw);

            // Check extraction version
            if (cache.extraction_version !== EXTRACTION_VERSION) {
                await this.removeContentFile(libraryId, zoteroKey);
                return null;
            }

            // Check file signature staleness
            const sig = await this.getFileSignature(filePath);
            if (!sig ||
                sig.mtime_ms !== cache.file_signature.mtime_ms ||
                sig.size_bytes !== cache.file_signature.size_bytes) {
                await this.removeContentFile(libraryId, zoteroKey);
                return null;
            }

            // Check all pages in range exist in the sparse map
            const pages: CachedPageContent[] = [];
            for (let i = startIndex; i <= endIndex; i++) {
                const page = cache.pages_by_index[i];
                if (!page) return null; // partial miss
                pages.push(page);
            }

            return pages;
        } catch {
            return null;
        }
    }

    /**
     * Store or merge page content into the disk cache.
     * Existing pages are preserved; new pages are added.
     *
     * Concurrent writes to the same attachment are serialized via a per-key
     * promise chain to prevent the read-modify-write cycle from losing pages.
     */
    async setContentPages(
        libraryId: number,
        zoteroKey: string,
        filePath: string,
        totalPages: number,
        pages: CachedPageContent[]
    ): Promise<void> {
        if (pages.length === 0) return;

        const lockKey = `${libraryId}/${zoteroKey}`;
        const prev = this.contentWriteLocks.get(lockKey) ?? Promise.resolve();
        const next = prev.then(() =>
            this.doSetContentPages(libraryId, zoteroKey, filePath, totalPages, pages)
        ).catch((error) => {
            logger(`AttachmentFileCache.setContentPages error for ${lockKey}: ${error}`, 1);
        });
        this.contentWriteLocks.set(lockKey, next);

        // Clean up the lock entry once this operation settles, but only if it's
        // still the tail of the chain (a newer call may have appended already).
        next.then(() => {
            if (this.contentWriteLocks.get(lockKey) === next) {
                this.contentWriteLocks.delete(lockKey);
            }
        });

        return next;
    }

    /** Inner implementation — always called under the per-key lock. */
    private async doSetContentPages(
        libraryId: number,
        zoteroKey: string,
        filePath: string,
        totalPages: number,
        pages: CachedPageContent[]
    ): Promise<void> {
        const contentFile = this.getContentFilePath(libraryId, zoteroKey);

        // Get file signature
        const sig = await this.getFileSignature(filePath);
        if (!sig) return;

        // Load existing cache or create new
        let cache: AttachmentContentCache;
        try {
            const exists = await IOUtils.exists(contentFile);
            if (exists) {
                const raw = await IOUtils.readUTF8(contentFile);
                cache = JSON.parse(raw);

                // If signature or version changed, start fresh
                if (cache.extraction_version !== EXTRACTION_VERSION ||
                    cache.file_signature.mtime_ms !== sig.mtime_ms ||
                    cache.file_signature.size_bytes !== sig.size_bytes) {
                    cache = {
                        extraction_version: EXTRACTION_VERSION,
                        file_signature: sig,
                        total_pages: totalPages,
                        pages_by_index: {},
                    };
                }
            } else {
                cache = {
                    extraction_version: EXTRACTION_VERSION,
                    file_signature: sig,
                    total_pages: totalPages,
                    pages_by_index: {},
                };
            }
        } catch {
            cache = {
                extraction_version: EXTRACTION_VERSION,
                file_signature: sig,
                total_pages: totalPages,
                pages_by_index: {},
            };
        }

        // Merge pages
        for (const page of pages) {
            cache.pages_by_index[page.index] = page;
        }

        // Ensure library directory exists
        await this.ensureLibraryDir(libraryId);

        // Write file
        const json = JSON.stringify(cache);
        const cachedCount = Object.keys(cache.pages_by_index).length;
        logger(`AttachmentFileCache.setContentPages: writing ${pages.length} pages for ${libraryId}/${zoteroKey} (${cachedCount}/${cache.total_pages} total cached)`);
        await IOUtils.writeUTF8(contentFile, json);
    }

    /**
     * Delete content cache for a specific attachment.
     */
    async deleteContent(libraryId: number, zoteroKey: string): Promise<void> {
        await this.removeContentFile(libraryId, zoteroKey);
    }

    /**
     * Delete all content cache files for a library.
     */
    async deleteContentByLibrary(libraryId: number): Promise<void> {
        const libDir = PathUtils.join(this.contentCacheDir, String(libraryId));
        try {
            const exists = await IOUtils.exists(libDir);
            if (exists) {
                await IOUtils.remove(libDir, { recursive: true });
            }
        } catch (error) {
            logger(`AttachmentFileCache.deleteContentByLibrary error: ${error}`, 1);
        }
    }

    // -----------------------------------------------------------------------
    // Invalidation
    // -----------------------------------------------------------------------

    /**
     * Invalidate both tiers for a specific attachment.
     */
    async invalidate(itemId: number, libraryId: number, zoteroKey: string): Promise<void> {
        logger(`AttachmentFileCache.invalidate: item=${itemId} key=${zoteroKey}`);
        await this.db.deleteAttachmentFileCache(itemId);
        this.memoryCache.delete(itemId);
        await this.removeContentFile(libraryId, zoteroKey);
    }

    /**
     * Invalidate all cache entries for a library.
     */
    async invalidateByLibrary(libraryId: number): Promise<void> {
        logger(`AttachmentFileCache.invalidateByLibrary: library=${libraryId}`);
        await this.deleteMetadataByLibrary(libraryId);
        await this.deleteContentByLibrary(libraryId);
    }

    // -----------------------------------------------------------------------
    // Stats
    // -----------------------------------------------------------------------

    async getStats(): Promise<AttachmentFileCacheStats> {
        const count = await this.db.getAttachmentFileCacheCount();
        return {
            metadata_count: count,
            memory_cache_size: this.memoryCache.size,
            content_cache_dir: this.contentCacheDir,
        };
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Check whether a cached record is stale.
     */
    private async isStale(record: AttachmentFileCacheRecord, filePath: string): Promise<boolean> {
        // Extraction version mismatch
        if (record.extraction_version !== EXTRACTION_VERSION) {
            return true;
        }

        // File path changed
        if (record.file_path !== filePath) {
            return true;
        }

        // Check file signature (mtime + size)
        const sig = await this.getFileSignature(filePath);
        if (!sig) {
            // File no longer exists
            return true;
        }

        if (sig.mtime_ms !== record.file_mtime_ms || sig.size_bytes !== record.file_size_bytes) {
            return true;
        }

        return false;
    }

    /**
     * Get mtime and size for a file path.
     */
    private async getFileSignature(filePath: string): Promise<FileSignature | null> {
        try {
            const stat = await IOUtils.stat(filePath);
            return {
                mtime_ms: stat.lastModified ?? 0,
                size_bytes: stat.size ?? 0,
            };
        } catch {
            return null;
        }
    }

    /**
     * Add an entry to the memory cache, evicting oldest entries if needed.
     */
    private putMemoryCache(itemId: number, record: AttachmentFileCacheRecord): void {
        // Evict oldest entries if at capacity
        if (this.memoryCache.size >= MEMORY_CACHE_MAX && !this.memoryCache.has(itemId)) {
            const firstKey = this.memoryCache.keys().next().value;
            if (firstKey !== undefined) {
                this.memoryCache.delete(firstKey);
            }
        }
        this.memoryCache.set(itemId, record);
    }

    /**
     * Get the disk path for a content cache file.
     */
    private getContentFilePath(libraryId: number, zoteroKey: string): string {
        return PathUtils.join(this.contentCacheDir, String(libraryId), `${zoteroKey}.json`);
    }

    /**
     * Ensure the library subdirectory exists in the content cache.
     */
    private async ensureLibraryDir(libraryId: number): Promise<void> {
        const dir = PathUtils.join(this.contentCacheDir, String(libraryId));
        try {
            const exists = await IOUtils.exists(dir);
            if (!exists) {
                await IOUtils.makeDirectory(dir, { createAncestors: true });
            }
        } catch {
            // Directory may already exist from a concurrent call
        }
    }

    /**
     * Remove a content cache file (silently ignores if missing).
     */
    private async removeContentFile(libraryId: number, zoteroKey: string): Promise<void> {
        const filePath = this.getContentFilePath(libraryId, zoteroKey);
        try {
            const exists = await IOUtils.exists(filePath);
            if (exists) {
                await IOUtils.remove(filePath);
            }
        } catch {
            // Silently ignore removal failures
        }
    }

    /**
     * Remove orphan content files that don't have a corresponding metadata row.
     */
    private async removeOrphanContentFiles(validRecords: AttachmentFileCacheRecord[]): Promise<void> {
        // Build a set of valid content file keys: "libraryId/zoteroKey"
        const validKeys = new Set(
            validRecords.map(r => `${r.library_id}/${r.zotero_key}`)
        );

        try {
            // List library subdirectories
            const entries = await IOUtils.getChildren(this.contentCacheDir);
            for (const entry of entries) {
                const entryName = PathUtils.filename(entry);
                const libraryId = parseInt(entryName, 10);
                if (isNaN(libraryId)) continue;

                // List JSON files in this library directory
                try {
                    const files = await IOUtils.getChildren(entry);
                    for (const file of files) {
                        const fileName = PathUtils.filename(file);
                        if (!fileName.endsWith('.json')) continue;
                        const zoteroKey = fileName.replace('.json', '');
                        const key = `${libraryId}/${zoteroKey}`;

                        if (!validKeys.has(key)) {
                            try {
                                await IOUtils.remove(file);
                            } catch {
                                // Ignore individual file removal failures
                            }
                        }
                    }
                } catch {
                    // Ignore errors listing library directory
                }
            }
        } catch {
            // Content cache dir might not have any entries yet
        }
    }
}

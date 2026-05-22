import { BeaverDB } from './database';
import type {
    DocumentCacheErrorCode,
    DocumentCacheExtractionMode,
    DocumentCacheMetadataInput,
    DocumentCacheMetadataRecord,
    DocumentCachePageLabels,
    DocumentCachePayloadRecord,
} from './database';
import { getFileSignature, isRemoteFilePath, type FileSignature } from './documentFileIdentity';
import { logger } from '../utils/logger';
import { gzipString, gunzipToString } from '../utils/gzip';
import { SCHEMA_VERSION } from '../beaver-extract/schema/schema';
import type { BeaverExtractResult } from '../beaver-extract/schema/schema';
import {
    validateMarkdownExtractResult,
    validateStructuredExtractResult,
} from '../beaver-extract/schema/validators';

export const DOCUMENT_METADATA_FORMAT_VERSION = 1;
export const DOCUMENT_PAYLOAD_FORMAT_VERSION = 1;

export type ExtractionMode = DocumentCacheExtractionMode;
export type PageLabels = DocumentCachePageLabels;
export type DocumentCacheMetadata = DocumentCacheMetadataRecord;
export type DocumentPayloadRecord = DocumentCachePayloadRecord;

export interface DocumentPreflightMetadata {
    pageCount: number | null;
    pageLabels: PageLabels | null;
    errorCode: DocumentCacheErrorCode | null;
    contentType: string;
}

export interface DocumentCacheStats {
    metadata_count: number;
    payload_count: number;
    payload_cache_dir: string;
}

type DocumentRef = { libraryId: number; zoteroKey: string };

export interface DocumentCacheSourceIdentity {
    filePath: string;
    fileSignature: FileSignature;
    sourceSizeBytes: number;
}

interface CacheMetadataInput {
    pageCount: number | null;
    pageLabels: PageLabels | Record<number, string> | null;
    /** Authoritative error reason; omitted or `null` marks a successful extraction. */
    errorCode?: DocumentCacheErrorCode | null;
}

/** Full-document PDF extraction cache backed by SQLite metadata and gzip payload files. */
export class DocumentCache {
    private db: BeaverDB;
    private payloadCacheDir = '';
    private writeLocks = new Map<string, Promise<void>>();
    private extractionLocks = new Map<string, Promise<BeaverExtractResult | null>>();

    constructor(db: BeaverDB) {
        this.db = db;
    }

    /** Initialize the cache directory under the Zotero profile. */
    async init(): Promise<void> {
        const profileDir = Zotero.File.pathToFile(Zotero.Profile.dir);
        const beaverDir = profileDir.clone();
        beaverDir.append('beaver');
        if (!beaverDir.exists()) {
            beaverDir.create(Ci.nsIFile.DIRECTORY_TYPE ?? 1, 0o700);
        }

        const cacheDir = beaverDir.clone();
        cacheDir.append('document-cache');
        if (!cacheDir.exists()) {
            cacheDir.create(Ci.nsIFile.DIRECTORY_TYPE ?? 1, 0o700);
        }

        this.payloadCacheDir = cacheDir.path;
    }

    /** Get fresh metadata for the current effective file path. */
    async getMetadata(
        ref: DocumentRef,
        filePath: string,
    ): Promise<DocumentCacheMetadata | null> {
        try {
            const record = await this.db.getDocumentCacheMetadataByKey(ref.libraryId, ref.zoteroKey);
            if (!record) return null;

            if (await this.isMetadataStale(record, filePath)) {
                const deletedPayloads = await this.db.deleteDocumentCacheMetadataIfUnchanged(record);
                if (deletedPayloads) {
                    await this.removePayloadFiles(deletedPayloads);
                }
                return null;
            }

            await this.db.touchDocumentCacheMetadata(record.id).catch(() => undefined);
            return record;
        } catch (error) {
            logger(`DocumentCache.getMetadata error: ${error}`, 1);
            return null;
        }
    }

    /** Get a cached extraction result for the current source identity. */
    async getResult(
        ref: { libraryId: number; zoteroKey: string },
        mode: ExtractionMode,
        filePath: string,
        options?: { maxSourceSizeBytes?: number },
    ): Promise<BeaverExtractResult | null> {
        try {
            const metadata = await this.getMetadata(ref, filePath);
            if (!metadata) return null;
            if (options?.maxSourceSizeBytes != null && metadata.sourceSizeBytes > options.maxSourceSizeBytes) {
                return null;
            }

            const payload = await this.db.getDocumentCachePayload(ref.libraryId, ref.zoteroKey, mode);
            if (!payload) return null;

            if (!this.isPayloadRowFresh(payload, metadata, mode)) {
                await this.deletePayload(payload);
                return null;
            }

            const exists = await IOUtils.exists(payload.payloadPath);
            if (!exists) {
                await this.deletePayload(payload, false);
                return null;
            }

            const bytes = await IOUtils.read(payload.payloadPath);
            if (payload.payloadSha256) {
                const sha256 = await this.sha256Hex(bytes);
                if (sha256 !== payload.payloadSha256) {
                    await this.deletePayload(payload);
                    return null;
                }
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(gunzipToString(bytes));
            } catch {
                await this.deletePayload(payload);
                return null;
            }

            let result: BeaverExtractResult;
            try {
                result = mode === 'structured'
                    ? validateStructuredExtractResult(parsed)
                    : validateMarkdownExtractResult(parsed);
            } catch {
                await this.deletePayload(payload);
                return null;
            }

            if (result.mode !== mode) {
                await this.deletePayload(payload);
                return null;
            }
            if (metadata.pageCount != null && result.document.pageCount !== metadata.pageCount) {
                await this.deletePayload(payload);
                return null;
            }

            await this.db.touchDocumentCachePayload(payload.id).catch(() => undefined);
            return result;
        } catch (error) {
            logger(`DocumentCache.getResult error: ${error}`, 1);
            return null;
        }
    }

    /** Snapshot the current source identity used for cache freshness checks. */
    async getSourceIdentitySnapshot(
        filePath: string,
        sourceSizeBytes = 0,
    ): Promise<DocumentCacheSourceIdentity> {
        return this.getSourceIdentity(filePath, sourceSizeBytes);
    }

    /**
     * Return a cached full-document result or run one shared cold extraction.
     *
     * Concurrent callers for the same attachment, mode, and source identity
     * await the same creation promise, avoiding duplicate full-document
     * extraction while still validating the cache again after acquiring the
     * in-flight slot.
     */
    async getOrCreateResult(input: {
        item: Zotero.Item;
        filePath: string;
        mode: ExtractionMode;
        sourceSizeBytes: number;
        contentType: string;
        maxSourceSizeBytes?: number;
        sharedTimeoutMs?: number;
        expectedSourceIdentity?: DocumentCacheSourceIdentity | null;
        create: (signal: AbortSignal) => Promise<BeaverExtractResult>;
        metadata: (result: BeaverExtractResult) => CacheMetadataInput;
    }): Promise<BeaverExtractResult | null> {
        const ref = {
            libraryId: input.item.libraryID,
            zoteroKey: input.item.key,
        };
        const cached = await this.getResult(ref, input.mode, input.filePath, {
            maxSourceSizeBytes: input.maxSourceSizeBytes,
        });
        if (cached) return cached;

        const source = input.expectedSourceIdentity
            ?? await this.getSourceIdentity(input.filePath, input.sourceSizeBytes);
        if (input.maxSourceSizeBytes != null && source.sourceSizeBytes > input.maxSourceSizeBytes) {
            return null;
        }
        const lockKey = `${ref.libraryId}/${ref.zoteroKey}/${input.mode}/${this.sourceIdentityKey(source)}`;
        const existing = this.extractionLocks.get(lockKey);
        if (existing) return existing;

        const next = (async () => {
            const refreshed = await this.getResult(ref, input.mode, input.filePath, {
                maxSourceSizeBytes: input.maxSourceSizeBytes,
            });
            if (refreshed) return refreshed;

            const controller = new AbortController();
            const timer = input.sharedTimeoutMs != null && input.sharedTimeoutMs > 0
                ? setTimeout(() => controller.abort(), input.sharedTimeoutMs)
                : null;
            let result: BeaverExtractResult;
            try {
                result = await input.create(controller.signal);
            } finally {
                if (timer) clearTimeout(timer);
            }
            await this.putResult({
                item: input.item,
                filePath: input.filePath,
                mode: input.mode,
                sourceSizeBytes: input.sourceSizeBytes,
                contentType: input.contentType,
                result,
                metadata: input.metadata(result),
                expectedSourceIdentity: source,
            });
            return result;
        })()
            .catch((error) => {
                logger(`DocumentCache.getOrCreateResult error: ${error}`, 1);
                throw error;
            })
            .finally(() => {
                if (this.extractionLocks.get(lockKey) === next) {
                    this.extractionLocks.delete(lockKey);
                }
            });

        this.extractionLocks.set(lockKey, next);
        return next;
    }

    /** Store fresh source-level metadata without writing a payload. */
    async putMetadata(input: {
        item: Zotero.Item;
        filePath: string;
        sourceSizeBytes: number;
        contentType: string;
        metadata: CacheMetadataInput;
    }): Promise<void> {
        if (Zotero.__beaverShuttingDown) return;
        try {
            const source = await this.getSourceIdentity(input.filePath, input.sourceSizeBytes);
            if (Zotero.__beaverShuttingDown) return;
            const record = this.buildMetadataInput(
                input.item,
                source,
                input.contentType,
                input.metadata,
            );
            const { deletedPayloads } = await this.db.upsertDocumentCacheMetadata(record);
            await this.removePayloadFiles(deletedPayloads);
        } catch (error) {
            logger(`DocumentCache.putMetadata error: ${error}`, 1);
        }
    }

    /** Store fresh source-level metadata and a compressed full-document payload. */
    async putResult(input: {
        item: Zotero.Item;
        filePath: string;
        mode: ExtractionMode;
        sourceSizeBytes: number;
        contentType: string;
        result: BeaverExtractResult;
        metadata: CacheMetadataInput;
        expectedSourceIdentity?: DocumentCacheSourceIdentity | null;
    }): Promise<void> {
        if (Zotero.__beaverShuttingDown) return;
        const lockKey = `${input.item.libraryID}/${input.item.key}/${input.mode}`;
        const previous = this.writeLocks.get(lockKey) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(() => this.putResultUnlocked(input))
            .catch((error) => logger(`DocumentCache.putResult error: ${error}`, 1))
            .finally(() => {
                if (this.writeLocks.get(lockKey) === next) {
                    this.writeLocks.delete(lockKey);
                }
            });
        this.writeLocks.set(lockKey, next);
        await next;
    }

    /** Store authoritative error metadata and delete any payloads for the attachment. */
    async putErrorMetadata(input: {
        item: Zotero.Item;
        filePath: string;
        sourceSizeBytes: number;
        contentType: string;
        errorCode: DocumentCacheErrorCode;
        pageCount: number | null;
        pageLabels: PageLabels | Record<number, string> | null;
    }): Promise<void> {
        if (Zotero.__beaverShuttingDown) return;
        try {
            const metadata: CacheMetadataInput = {
                pageCount: input.pageCount,
                pageLabels: input.pageLabels,
                errorCode: input.errorCode,
            };
            const source = await this.getSourceIdentity(input.filePath, input.sourceSizeBytes);
            if (Zotero.__beaverShuttingDown) return;
            const record = this.buildMetadataInput(input.item, source, input.contentType, metadata);
            const { metadata: stored, deletedPayloads } = await this.db.upsertDocumentCacheMetadata(record);
            const payloads = await this.db.deleteDocumentCachePayloadsForMetadata(stored.id);
            await this.removePayloadFiles([...deletedPayloads, ...payloads]);
        } catch (error) {
            logger(`DocumentCache.putErrorMetadata error: ${error}`, 1);
        }
    }

    /** Invalidate all document-cache state for one attachment. */
    async invalidate(libraryId: number, zoteroKey: string): Promise<void> {
        try {
            const payloads = await this.db.deleteDocumentCacheMetadata(libraryId, zoteroKey);
            await this.removePayloadFiles(payloads);
        } catch (error) {
            logger(`DocumentCache.invalidate error: ${error}`, 1);
        }
    }

    /** Invalidate all document-cache state for a library. */
    async invalidateByLibrary(libraryId: number): Promise<void> {
        try {
            const payloads = await this.db.deleteDocumentCacheMetadataByLibrary(libraryId);
            await this.removePayloadFiles(payloads);
            if (this.payloadCacheDir) {
                await IOUtils.remove(this.libraryDir(libraryId), { recursive: true } as any).catch(() => undefined);
            }
        } catch (error) {
            logger(`DocumentCache.invalidateByLibrary error: ${error}`, 1);
        }
    }

    /** Remove stale rows and orphan payload files. */
    async runStartupGC(): Promise<void> {
        try {
            let removedMetadata = 0;
            let removedPayloads = 0;
            let removedFiles = 0;
            const metadataRows = await this.db.getAllDocumentCacheMetadata();
            for (const metadata of metadataRows) {
                let stale = metadata.metadataFormatVersion !== DOCUMENT_METADATA_FORMAT_VERSION
                    || metadata.extractionSchemaVersion !== SCHEMA_VERSION
                    || this.isAttachmentMissingOrDeleted(metadata.libraryId, metadata.zoteroKey);
                if (!stale && !isRemoteFilePath(metadata.filePath)) {
                    stale = !(await IOUtils.exists(metadata.filePath).catch(() => false));
                }
                if (stale) {
                    const payloads = await this.db.deleteDocumentCacheMetadata(metadata.libraryId, metadata.zoteroKey);
                    await this.removePayloadFiles(payloads);
                    removedMetadata++;
                    removedPayloads += payloads.length;
                }
            }

            const payloads = await this.db.getAllDocumentCachePayloads();
            const referencedPaths = new Set<string>();
            for (const payload of payloads) {
                referencedPaths.add(payload.payloadPath);
                const invalid = payload.cacheFormatVersion !== DOCUMENT_PAYLOAD_FORMAT_VERSION
                    || payload.extractionSchemaVersion !== SCHEMA_VERSION
                    || !(await IOUtils.exists(payload.payloadPath).catch(() => false));
                if (invalid) {
                    const deleted = await this.db.deleteDocumentCachePayload(payload.libraryId, payload.zoteroKey, payload.mode);
                    if (deleted) {
                        await this.removePayloadFiles([deleted]);
                        removedPayloads++;
                    }
                }
            }

            removedFiles += await this.removeOrphanPayloadFiles(referencedPaths);

            if (removedMetadata || removedPayloads || removedFiles) {
                logger(`DocumentCache GC: removed ${removedMetadata} metadata rows, ${removedPayloads} payload rows, ${removedFiles} files`);
            }
        } catch (error) {
            logger(`DocumentCache.runStartupGC error: ${error}`, 1);
        }
    }

    /** Return compact document-cache counts and directory information. */
    async getStats(): Promise<DocumentCacheStats> {
        return {
            metadata_count: await this.db.getDocumentCacheMetadataCount(),
            payload_count: await this.db.getDocumentCachePayloadCount(),
            payload_cache_dir: this.payloadCacheDir,
        };
    }

    private async putResultUnlocked(input: {
        item: Zotero.Item;
        filePath: string;
        mode: ExtractionMode;
        sourceSizeBytes: number;
        contentType: string;
        result: BeaverExtractResult;
        metadata: CacheMetadataInput;
        expectedSourceIdentity?: DocumentCacheSourceIdentity | null;
    }): Promise<void> {
        if (Zotero.__beaverShuttingDown) return;
        if (input.result.mode !== input.mode || input.result.schemaVersion !== SCHEMA_VERSION) {
            return;
        }
        const source = await this.getSourceIdentity(input.filePath, input.sourceSizeBytes);
        if (input.expectedSourceIdentity && !this.sourceIdentityMatches(source, input.expectedSourceIdentity)) {
            return;
        }
        if (Zotero.__beaverShuttingDown) return;

        const payloadWrite = await this.writePayloadFile(
            input.item.libraryID,
            input.item.key,
            input.mode,
            input.result,
        );
        const metadataInput = this.buildMetadataInput(input.item, source, input.contentType, input.metadata);
        const { metadata, deletedPayloads } = await this.db.upsertDocumentCacheMetadata(metadataInput);
        const oldPayload = await this.db.getDocumentCachePayload(input.item.libraryID, input.item.key, input.mode);
        await this.db.upsertDocumentCachePayload({
            metadataId: metadata.id,
            itemId: input.item.id,
            libraryId: input.item.libraryID,
            zoteroKey: input.item.key,
            mode: input.mode,
            sourceFilePath: source.filePath,
            sourceFileSignature: source.fileSignature,
            sourceSizeBytes: source.sourceSizeBytes,
            payloadPath: payloadWrite.path,
            payloadSizeBytes: payloadWrite.size,
            payloadSha256: payloadWrite.sha256,
            extractionSchemaVersion: SCHEMA_VERSION,
            cacheFormatVersion: DOCUMENT_PAYLOAD_FORMAT_VERSION,
        });
        const cleanup = oldPayload && oldPayload.payloadPath !== payloadWrite.path
            ? [...deletedPayloads, oldPayload]
            : deletedPayloads;
        await this.removePayloadFiles(
            cleanup.filter((payload) => payload.payloadPath !== payloadWrite.path),
        );
    }

    private async isMetadataStale(record: DocumentCacheMetadataRecord, filePath: string): Promise<boolean> {
        if (record.metadataFormatVersion !== DOCUMENT_METADATA_FORMAT_VERSION) return true;
        if (record.extractionSchemaVersion !== SCHEMA_VERSION) return true;
        if (record.filePath !== filePath) return true;
        if (isRemoteFilePath(filePath)) return false;
        const exists = await IOUtils.exists(filePath).catch(() => false);
        if (!exists) return true;
        const signature = await getFileSignature(filePath);
        return signature.mtime_ms !== record.fileSignature.mtime_ms
            || signature.size_bytes !== record.fileSignature.size_bytes;
    }

    private isAttachmentMissingOrDeleted(libraryId: number, zoteroKey: string): boolean {
        const item = Zotero.Items.getByLibraryAndKey(libraryId, zoteroKey);
        if (!item) return true;
        return !!item.deleted
            || (typeof item.isInTrash === 'function' && item.isInTrash());
    }

    private isPayloadRowFresh(
        payload: DocumentCachePayloadRecord,
        metadata: DocumentCacheMetadataRecord,
        mode: ExtractionMode,
    ): boolean {
        return payload.mode === mode
            && payload.cacheFormatVersion === DOCUMENT_PAYLOAD_FORMAT_VERSION
            && payload.extractionSchemaVersion === SCHEMA_VERSION
            && payload.metadataId === metadata.id
            && payload.sourceFilePath === metadata.filePath
            && payload.sourceFileSignature.mtime_ms === metadata.fileSignature.mtime_ms
            && payload.sourceFileSignature.size_bytes === metadata.fileSignature.size_bytes
            && payload.sourceSizeBytes === metadata.sourceSizeBytes;
    }

    private async getSourceIdentity(filePath: string, sourceSizeBytes: number): Promise<DocumentCacheSourceIdentity> {
        const fileSignature = await getFileSignature(filePath);
        return {
            filePath,
            fileSignature,
            sourceSizeBytes: isRemoteFilePath(filePath) ? sourceSizeBytes : fileSignature.size_bytes,
        };
    }

    private sourceIdentityKey(source: DocumentCacheSourceIdentity): string {
        return [
            source.filePath,
            source.fileSignature.mtime_ms,
            source.fileSignature.size_bytes,
            source.sourceSizeBytes,
        ].join('|');
    }

    private sourceIdentityMatches(
        current: DocumentCacheSourceIdentity,
        expected: DocumentCacheSourceIdentity,
    ): boolean {
        return current.filePath === expected.filePath
            && current.fileSignature.mtime_ms === expected.fileSignature.mtime_ms
            && current.fileSignature.size_bytes === expected.fileSignature.size_bytes
            && current.sourceSizeBytes === expected.sourceSizeBytes;
    }

    private buildMetadataInput(
        item: Zotero.Item,
        source: DocumentCacheSourceIdentity,
        contentType: string,
        metadata: CacheMetadataInput,
    ): DocumentCacheMetadataInput {
        return {
            itemId: item.id,
            libraryId: item.libraryID,
            zoteroKey: item.key,
            filePath: source.filePath,
            fileSignature: source.fileSignature,
            sourceSizeBytes: source.sourceSizeBytes,
            contentType,
            pageCount: metadata.pageCount,
            pageLabels: this.normalizePageLabels(metadata.pageLabels),
            errorCode: metadata.errorCode ?? null,
            extractionSchemaVersion: SCHEMA_VERSION,
            metadataFormatVersion: DOCUMENT_METADATA_FORMAT_VERSION,
        };
    }

    private normalizePageLabels(labels: PageLabels | Record<number, string> | null): PageLabels | null {
        if (!labels) return null;
        const normalized: PageLabels = {};
        for (const [key, value] of Object.entries(labels)) {
            normalized[String(key)] = value;
        }
        return normalized;
    }

    private async writePayloadFile(
        libraryId: number,
        zoteroKey: string,
        mode: ExtractionMode,
        result: BeaverExtractResult,
    ): Promise<{ path: string; size: number; sha256: string }> {
        const json = JSON.stringify(result);
        const bytes = gzipString(json);
        const sha256 = await this.sha256Hex(bytes);
        const dir = this.libraryDir(libraryId);
        await (IOUtils as any).makeDirectory(dir, { createAncestors: true }).catch(() => undefined);

        const finalPath = PathUtils.join(dir, `${zoteroKey}.${mode}.${sha256}.json.gz`);
        const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const tempPath = PathUtils.join(dir, `${zoteroKey}.${mode}.${sha256}.${nonce}.tmp`);

        const exists = await IOUtils.exists(finalPath).catch(() => false);
        if (!exists) {
            await IOUtils.write(tempPath, bytes);
            await IOUtils.write(finalPath, bytes);
            await IOUtils.remove(tempPath).catch(() => undefined);
        }

        return { path: finalPath, size: bytes.byteLength, sha256 };
    }

    private async deletePayload(payload: DocumentCachePayloadRecord, removeFile = true): Promise<void> {
        const deleted = await this.db.deleteDocumentCachePayloadIfUnchanged(payload);
        if (!deleted) return;
        if (removeFile) {
            const current = await this.db.getDocumentCachePayload(
                payload.libraryId,
                payload.zoteroKey,
                payload.mode,
            );
            if (current?.payloadPath === payload.payloadPath) return;
            await this.removePayloadFiles([deleted]);
        }
    }

    private async removePayloadFiles(payloads: DocumentCachePayloadRecord[]): Promise<void> {
        const paths = new Set(payloads.map((payload) => payload.payloadPath));
        for (const path of paths) {
            await IOUtils.remove(path).catch(() => undefined);
        }
    }

    private async removeOrphanPayloadFiles(referencedPaths: Set<string>): Promise<number> {
        if (!this.payloadCacheDir) return 0;
        let removed = 0;
        const libraryDirs = await IOUtils.getChildren(this.payloadCacheDir).catch(() => []);
        for (const libraryDir of libraryDirs) {
            const children = await IOUtils.getChildren(libraryDir).catch(() => []);
            for (const child of children) {
                const isTemp = child.endsWith('.tmp');
                const isPayload = child.endsWith('.json.gz');
                if ((isTemp || isPayload) && !referencedPaths.has(child)) {
                    await IOUtils.remove(child).then(() => removed++).catch(() => undefined);
                }
            }
        }
        return removed;
    }

    private libraryDir(libraryId: number): string {
        return PathUtils.join(this.payloadCacheDir, String(libraryId));
    }

    private async sha256Hex(bytes: Uint8Array): Promise<string> {
        const subtle = globalThis.crypto?.subtle;
        if (subtle) {
            const buffer = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(buffer).set(bytes);
            const digest = await subtle.digest('SHA-256', buffer);
            return Array.from(new Uint8Array(digest))
                .map((byte) => byte.toString(16).padStart(2, '0'))
                .join('');
        }

        let hash = 2166136261;
        for (const byte of bytes) {
            hash ^= byte;
            hash = Math.imul(hash, 16777619);
        }
        return `${bytes.byteLength.toString(16)}-${(hash >>> 0).toString(16)}`;
    }
}

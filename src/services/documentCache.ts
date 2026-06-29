import { BeaverDB } from './database';
import type {
    DocumentCacheErrorCode,
    DocumentCacheExtractionMode,
    DocumentCacheMetadataInput,
    DocumentCacheMetadataRecord,
    DocumentCachePageLabels,
    DocumentCachePayloadKind,
    DocumentCachePayloadRecord,
} from './database';
import { getFileSignature, isRemoteFilePath, type FileSignature } from './documentFileIdentity';
import { logger } from '../utils/logger';
import {
    gzipJsonValueChunked,
    gzipUtf8BytesChunked,
    gunzipToBytes,
    gunzipToString,
} from '../utils/gzip';
import { createAbortController } from '../utils/abortController';
import type {
    BeaverExtractResult,
    SerializedBeaverExtractResult,
} from '../beaver-extract/schema/schema';
import {
    validateMarkdownExtractResult,
    validateStructuredExtractResult,
} from '../beaver-extract/schema/validators';
import type { PageGeometry } from '../beaver-extract/types';
import {
    buildEpubCachedMetadata,
    buildPdfCachedMetadata,
    buildSnapshotCachedMetadata,
    type EpubSectionSummary,
    type SnapshotSectionSummary,
} from './documentExtraction/shared/contentKinds';
import {
    expectedExtractionSchemaVersion,
    type ExtractContentKind,
} from './documentExtraction/shared/extractionSchemaVersions';
import { validateEpubDocument, type EpubDocument } from './documentExtraction/epub';
import { validateSnapshotDocument, type SnapshotDocument } from './documentExtraction/snapshot';

export const DOCUMENT_METADATA_FORMAT_VERSION = 1;
export const DOCUMENT_PAYLOAD_FORMAT_VERSION = 1;

export type ExtractionMode = DocumentCacheExtractionMode;
export type PayloadKind = DocumentCachePayloadKind;
export type PageLabels = DocumentCachePageLabels;
export type { PageGeometry } from '../beaver-extract/types';
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

/**
 * Minimal item identity the cache stores with each entry. Zotero.Item
 * satisfies it structurally; external files pass a synthetic ref
 * ({ id: 0, libraryID: EXTERNAL_LIBRARY_ID, key: extKey }).
 */
export interface DocumentCacheItemRef {
    id: number;
    libraryID: number;
    key: string;
}

export interface DocumentCacheSourceIdentity {
    filePath: string;
    fileSignature: FileSignature;
    sourceSizeBytes: number;
}

interface CacheMetadataInput {
    contentKind?: ExtractContentKind;
    pageCount: number | null;
    pageLabels: PageLabels | Record<number, string> | null;
    pages: (PageGeometry | null)[] | null;
    epubSections?: EpubSectionSummary[];
    /** EPUB total page count (max stamped `pageNumber`); PDF uses `pageCount`. */
    epubPageCount?: number | null;
    /** Extraction-diagnostics text total; flags image-only EPUBs on read. */
    epubExtractedTextChars?: number | null;
    snapshotSections?: SnapshotSectionSummary[];
    /** Snapshot document title (first section label). */
    snapshotTitle?: string;
    /** Snapshot total synthetic page count; PDF uses `pageCount`. */
    snapshotPageCount?: number | null;
    /** Extraction-diagnostics text total; flags text-empty snapshots on read. */
    snapshotExtractedTextChars?: number | null;
    /** Authoritative error reason; omitted or `null` marks a successful extraction. */
    errorCode?: DocumentCacheErrorCode | null;
}

interface CacheablePayload {
    schemaVersion: string;
}

export interface SerializedDocumentCacheResult extends CacheablePayload {
    mode: ExtractionMode;
    document: { pageCount: number };
    byteLength: number;
    jsonBytes: Uint8Array;
    metadata: CacheMetadataInput;
}

interface ExtractionLockEntry<T extends CacheablePayload = BeaverExtractResult> {
    promise: Promise<T | null>;
    controller: AbortController;
    waiters: Set<symbol>;
    settled: boolean;
}

/** Full-document PDF extraction cache backed by SQLite metadata and gzip payload files. */
export class DocumentCache {
    private db: BeaverDB;
    private payloadCacheDir = '';
    private writeLocks = new Map<string, Promise<void>>();
    private extractionLocks = new Map<string, ExtractionLockEntry<CacheablePayload>>();

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
            const payloadKind = DocumentCache.payloadKindForMode(mode);
            const metadata = await this.getMetadata(ref, filePath);
            if (!metadata) return null;
            if (options?.maxSourceSizeBytes != null && metadata.sourceSizeBytes > options.maxSourceSizeBytes) {
                return null;
            }
            if (metadata.contentKind !== 'pdf') {
                if (metadata.contentKind === 'text' || metadata.contentKind === 'snapshot') {
                    const deletedPayloads = await this.db.deleteDocumentCacheMetadataIfUnchanged(metadata);
                    if (deletedPayloads) {
                        await this.removePayloadFiles(deletedPayloads);
                    }
                }
                return null;
            }

            const payload = await this.db.getDocumentCachePayload(ref.libraryId, ref.zoteroKey, payloadKind);
            if (!payload) return null;

            if (!this.isPayloadRowFresh(payload, metadata, payloadKind)) {
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
                result = metadata.contentKind === 'pdf' && mode === 'structured'
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
            if (
                metadata.contentKind === 'pdf'
                && metadata.pageCount != null
                && result.document.pageCount !== metadata.pageCount
            ) {
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

    /** Get a cached extraction result as UTF-8 JSON bytes without parsing it. */
    async getSerializedResult(
        ref: { libraryId: number; zoteroKey: string },
        mode: ExtractionMode,
        filePath: string,
        options?: { maxSourceSizeBytes?: number },
    ): Promise<SerializedDocumentCacheResult | null> {
        try {
            const payloadKind = DocumentCache.payloadKindForMode(mode);
            const metadata = await this.getMetadata(ref, filePath);
            if (!metadata) return null;
            if (options?.maxSourceSizeBytes != null && metadata.sourceSizeBytes > options.maxSourceSizeBytes) {
                return null;
            }
            if (metadata.contentKind !== 'pdf' || !metadata.documentMetadata || metadata.documentMetadata.content_kind !== 'pdf') {
                return null;
            }

            const payload = await this.db.getDocumentCachePayload(ref.libraryId, ref.zoteroKey, payloadKind);
            if (!payload) return null;

            if (!this.isPayloadRowFresh(payload, metadata, payloadKind)) {
                await this.deletePayload(payload);
                return null;
            }

            const exists = await IOUtils.exists(payload.payloadPath);
            if (!exists) {
                await this.deletePayload(payload, false);
                return null;
            }

            const compressedBytes = await IOUtils.read(payload.payloadPath);
            if (payload.payloadSha256) {
                const sha256 = await this.sha256Hex(compressedBytes);
                if (sha256 !== payload.payloadSha256) {
                    await this.deletePayload(payload);
                    return null;
                }
            }

            const jsonBytes = gunzipToBytes(compressedBytes);
            if (!this.isLikelySerializedPdfResult(jsonBytes, mode, metadata.documentMetadata.pageCount)) {
                await this.deletePayload(payload);
                return null;
            }

            await this.db.touchDocumentCachePayload(payload.id).catch(() => undefined);
            return {
                schemaVersion: metadata.extractionSchemaVersion,
                mode,
                document: { pageCount: metadata.documentMetadata.pageCount ?? 0 },
                byteLength: jsonBytes.byteLength,
                jsonBytes,
                metadata: {
                    pageCount: metadata.documentMetadata.pageCount,
                    pageLabels: metadata.documentMetadata.pageLabels,
                    pages: metadata.documentMetadata.pages,
                },
            };
        } catch (error) {
            logger(`DocumentCache.getSerializedResult error: ${error}`, 1);
            return null;
        }
    }

    /**
     * Read a cached DOM-document (EPUB / snapshot) structured payload for the
     * current source identity.
     */
    private async getDomDocumentResult<T extends { sectionCount: number }>(
        ref: DocumentRef,
        filePath: string,
        kind: 'epub' | 'snapshot',
        validate: (parsed: unknown) => T,
        options?: { maxSourceSizeBytes?: number },
    ): Promise<T | null> {
        try {
            const payloadKind: PayloadKind = 'structured';
            const metadata = await this.getMetadata(ref, filePath);
            if (!metadata) return null;
            if (options?.maxSourceSizeBytes != null && metadata.sourceSizeBytes > options.maxSourceSizeBytes) {
                return null;
            }
            if (metadata.contentKind !== kind) {
                // Drop a stale row left by a different DOM/text extraction for the
                // same item (e.g. its content kind changed). PDF rows are left
                // alone. They live in a separate payload kind.
                if (
                    metadata.contentKind === 'text'
                    || metadata.contentKind === 'epub'
                    || metadata.contentKind === 'snapshot'
                ) {
                    const deletedPayloads = await this.db.deleteDocumentCacheMetadataIfUnchanged(metadata);
                    if (deletedPayloads) {
                        await this.removePayloadFiles(deletedPayloads);
                    }
                }
                return null;
            }

            const payload = await this.db.getDocumentCachePayload(ref.libraryId, ref.zoteroKey, payloadKind);
            if (!payload) return null;

            if (!this.isPayloadRowFresh(payload, metadata, payloadKind)) {
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

            let result: T;
            try {
                result = validate(parsed);
            } catch {
                await this.deletePayload(payload);
                return null;
            }

            // Reject a payload whose section count drifted from the durable
            // metadata row. EPUB rows always carry a section count; snapshot
            // rows written before sections existed leave it unknown (skip).
            const docMeta = metadata.documentMetadata;
            const expectedSectionCount = docMeta?.content_kind === 'epub'
                ? docMeta.sectionCount
                : docMeta?.content_kind === 'snapshot' && docMeta.sections != null
                    ? docMeta.sections.length
                    : undefined;
            if (expectedSectionCount != null && expectedSectionCount !== result.sectionCount) {
                await this.deletePayload(payload);
                return null;
            }

            await this.db.touchDocumentCachePayload(payload.id).catch(() => undefined);
            return result;
        } catch (error) {
            logger(`DocumentCache.getDomDocumentResult(${kind}) error: ${error}`, 1);
            return null;
        }
    }

    /** Get a cached EPUB extraction result for the current source identity. */
    getEpubResult(
        ref: DocumentRef,
        filePath: string,
        options?: { maxSourceSizeBytes?: number },
    ): Promise<EpubDocument | null> {
        return this.getDomDocumentResult(ref, filePath, 'epub', validateEpubDocument, options);
    }

    /** Get a cached snapshot extraction result for the current source identity. */
    getSnapshotResult(
        ref: DocumentRef,
        filePath: string,
        options?: { maxSourceSizeBytes?: number },
    ): Promise<SnapshotDocument | null> {
        return this.getDomDocumentResult(ref, filePath, 'snapshot', validateSnapshotDocument, options);
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
    async getOrCreateResult<T extends CacheablePayload = BeaverExtractResult>(input: {
        item: DocumentCacheItemRef;
        filePath: string;
        contentKind?: ExtractContentKind;
        mode: ExtractionMode;
        sourceSizeBytes: number;
        contentType: string;
        maxSourceSizeBytes?: number;
        sharedTimeoutMs?: number;
        abortSignal?: AbortSignal;
        expectedSourceIdentity?: DocumentCacheSourceIdentity | null;
        readCached?: (ref: DocumentRef) => Promise<T | null>;
        create: (signal: AbortSignal) => Promise<T>;
        metadata: (result: T) => CacheMetadataInput;
    }): Promise<T | null> {
        const ref = {
            libraryId: input.item.libraryID,
            zoteroKey: input.item.key,
        };
        const readCached = input.readCached
            ?? ((cacheRef: DocumentRef) => this.getResult(cacheRef, input.mode, input.filePath, {
                maxSourceSizeBytes: input.maxSourceSizeBytes,
            }) as Promise<T | null>);
        const source = input.expectedSourceIdentity
            ?? await this.getSourceIdentity(input.filePath, input.sourceSizeBytes);
        if (input.maxSourceSizeBytes != null && source.sourceSizeBytes > input.maxSourceSizeBytes) {
            return null;
        }
        const payloadKind = DocumentCache.payloadKindForMode(input.mode);
        const contentKind = input.contentKind ?? 'pdf';
        const suffix = contentKind === 'pdf' ? '' : `/${contentKind}`;
        const lockKey = `${ref.libraryId}/${ref.zoteroKey}/${payloadKind}/${this.sourceIdentityKey(source)}${suffix}`;
        const existing = this.extractionLocks.get(lockKey) as ExtractionLockEntry<T> | undefined;
        if (existing) return this.waitForSharedExtraction(existing, input.abortSignal);

        const cached = await readCached(ref);
        if (cached) return cached;

        const refreshedExisting = this.extractionLocks.get(lockKey) as ExtractionLockEntry<T> | undefined;
        if (refreshedExisting) return this.waitForSharedExtraction(refreshedExisting, input.abortSignal);

        const controller = createAbortController();
        const entry: ExtractionLockEntry<T> = {
            controller,
            waiters: new Set(),
            settled: false,
            promise: Promise.resolve(null),
        };
        const timer = input.sharedTimeoutMs != null && input.sharedTimeoutMs > 0
            ? setTimeout(() => controller.abort(), input.sharedTimeoutMs)
            : null;
        entry.promise = (async () => {
            const refreshed = await readCached(ref);
            if (refreshed) return refreshed;

            let result: T;
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
                entry.settled = true;
                if (this.extractionLocks.get(lockKey) === entry) {
                    this.extractionLocks.delete(lockKey);
                }
            });

        this.extractionLocks.set(lockKey, entry);
        return this.waitForSharedExtraction(entry, input.abortSignal);
    }

    /** Return a cached serialized result or run one shared serialized extraction. */
    async getOrCreateSerializedResult(input: {
        item: DocumentCacheItemRef;
        filePath: string;
        mode: ExtractionMode;
        sourceSizeBytes: number;
        contentType: string;
        maxSourceSizeBytes?: number;
        sharedTimeoutMs?: number;
        abortSignal?: AbortSignal;
        expectedSourceIdentity?: DocumentCacheSourceIdentity | null;
        create: (signal: AbortSignal) => Promise<SerializedBeaverExtractResult>;
    }): Promise<SerializedDocumentCacheResult | null> {
        const ref = {
            libraryId: input.item.libraryID,
            zoteroKey: input.item.key,
        };
        const readCached = (cacheRef: DocumentRef) => this.getSerializedResult(
            cacheRef,
            input.mode,
            input.filePath,
            { maxSourceSizeBytes: input.maxSourceSizeBytes },
        );
        const source = input.expectedSourceIdentity
            ?? await this.getSourceIdentity(input.filePath, input.sourceSizeBytes);
        if (input.maxSourceSizeBytes != null && source.sourceSizeBytes > input.maxSourceSizeBytes) {
            return null;
        }
        const payloadKind = DocumentCache.payloadKindForMode(input.mode);
        const lockKey = `${ref.libraryId}/${ref.zoteroKey}/${payloadKind}/${this.sourceIdentityKey(source)}/serialized`;
        const existing = this.extractionLocks.get(lockKey) as ExtractionLockEntry<SerializedDocumentCacheResult> | undefined;
        if (existing) return this.waitForSharedExtraction(existing, input.abortSignal);

        const cached = await readCached(ref);
        if (cached) return cached;

        const refreshedExisting = this.extractionLocks.get(lockKey) as ExtractionLockEntry<SerializedDocumentCacheResult> | undefined;
        if (refreshedExisting) return this.waitForSharedExtraction(refreshedExisting, input.abortSignal);

        const controller = createAbortController();
        const entry: ExtractionLockEntry<SerializedDocumentCacheResult> = {
            controller,
            waiters: new Set(),
            settled: false,
            promise: Promise.resolve(null),
        };
        const timer = input.sharedTimeoutMs != null && input.sharedTimeoutMs > 0
            ? setTimeout(() => controller.abort(), input.sharedTimeoutMs)
            : null;
        entry.promise = (async () => {
            const refreshed = await readCached(ref);
            if (refreshed) return refreshed;

            let created: SerializedBeaverExtractResult;
            try {
                created = await input.create(controller.signal);
            } finally {
                if (timer) clearTimeout(timer);
            }
            const stored: SerializedDocumentCacheResult = {
                schemaVersion: created.schemaVersion,
                mode: created.mode,
                document: { pageCount: created.pageCount },
                byteLength: created.byteLength,
                jsonBytes: created.jsonBytes,
                metadata: {
                    pageCount: created.cacheMetadata.pageCount,
                    pageLabels: created.cacheMetadata.pageLabels,
                    pages: created.cacheMetadata.pages,
                },
            };
            await this.putSerializedResult({
                item: input.item,
                filePath: input.filePath,
                mode: input.mode,
                sourceSizeBytes: input.sourceSizeBytes,
                contentType: input.contentType,
                result: stored,
                metadata: stored.metadata,
                expectedSourceIdentity: source,
            });
            return stored;
        })()
            .catch((error) => {
                logger(`DocumentCache.getOrCreateSerializedResult error: ${error}`, 1);
                throw error;
            })
            .finally(() => {
                entry.settled = true;
                if (this.extractionLocks.get(lockKey) === entry) {
                    this.extractionLocks.delete(lockKey);
                }
            });

        this.extractionLocks.set(lockKey, entry);
        return this.waitForSharedExtraction(entry, input.abortSignal);
    }

    private waitForSharedExtraction<T extends CacheablePayload>(
        entry: ExtractionLockEntry<T>,
        abortSignal?: AbortSignal,
    ): Promise<T | null> {
        const waiter = Symbol('document-cache-waiter');
        entry.waiters.add(waiter);

        let onAbort: (() => void) | null = null;
        const cleanupWaiter = () => {
            if (onAbort) {
                abortSignal?.removeEventListener('abort', onAbort);
            }
            entry.waiters.delete(waiter);
            if (!entry.settled && entry.waiters.size === 0) {
                entry.controller.abort();
            }
        };

        if (!abortSignal) {
            return entry.promise.finally(() => {
                if (entry.waiters.has(waiter)) {
                    cleanupWaiter();
                }
            });
        }

        const abortPromise = new Promise<never>((_, reject) => {
            onAbort = () => {
                cleanupWaiter();
                reject(new Error('Operation aborted'));
            };
            if (abortSignal.aborted) {
                onAbort();
            } else {
                abortSignal.addEventListener('abort', onAbort, { once: true });
            }
        });

        return Promise.race([entry.promise, abortPromise]).finally(() => {
            if (entry.waiters.has(waiter)) {
                cleanupWaiter();
            }
        });
    }

    /** Store fresh source-level metadata without writing a payload. */
    async putMetadata(input: {
        item: DocumentCacheItemRef;
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
    async putResult<T extends CacheablePayload = BeaverExtractResult>(input: {
        item: DocumentCacheItemRef;
        filePath: string;
        mode: ExtractionMode;
        sourceSizeBytes: number;
        contentType: string;
        result: T;
        metadata: CacheMetadataInput;
        expectedSourceIdentity?: DocumentCacheSourceIdentity | null;
    }): Promise<void> {
        if (Zotero.__beaverShuttingDown) return;
        const payloadKind = DocumentCache.payloadKindForMode(input.mode);
        const lockKey = `${input.item.libraryID}/${input.item.key}/${payloadKind}`;
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

    /** Store fresh source-level metadata and a pre-serialized compressed payload. */
    async putSerializedResult(input: {
        item: DocumentCacheItemRef;
        filePath: string;
        mode: ExtractionMode;
        sourceSizeBytes: number;
        contentType: string;
        result: SerializedDocumentCacheResult | SerializedBeaverExtractResult;
        metadata: CacheMetadataInput;
        expectedSourceIdentity?: DocumentCacheSourceIdentity | null;
    }): Promise<void> {
        if (Zotero.__beaverShuttingDown) return;
        const payloadKind = DocumentCache.payloadKindForMode(input.mode);
        const lockKey = `${input.item.libraryID}/${input.item.key}/${payloadKind}`;
        const previous = this.writeLocks.get(lockKey) ?? Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(() => this.putSerializedResultUnlocked(input))
            .catch((error) => logger(`DocumentCache.putSerializedResult error: ${error}`, 1))
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
        item: DocumentCacheItemRef;
        filePath: string;
        sourceSizeBytes: number;
        contentType: string;
        errorCode: DocumentCacheErrorCode;
        pageCount: number | null;
        pageLabels: PageLabels | Record<number, string> | null;
        pages: (PageGeometry | null)[] | null;
    }): Promise<void> {
        if (Zotero.__beaverShuttingDown) return;
        try {
            const metadata: CacheMetadataInput = {
                pageCount: input.pageCount,
                pageLabels: input.pageLabels,
                pages: input.pages,
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

    /**
     * Completely clear the document cache: delete every metadata row, every
     * payload row, and every file stored on disk under the cache directory.
     */
    async clearAll(): Promise<{ metadataRows: number; payloadRows: number }> {
        // Abort in-flight extractions and drop pending write locks so they
        // cannot repopulate the cache after it has been wiped.
        for (const entry of this.extractionLocks.values()) {
            entry.controller.abort();
        }
        this.extractionLocks.clear();
        this.writeLocks.clear();

        const metadataRows = await this.db.getDocumentCacheMetadataCount();
        const payloadRows = await this.db.getDocumentCachePayloadCount();

        await this.db.deleteAllDocumentCache();

        // Wipe every file on disk by removing all children of the cache dir.
        if (this.payloadCacheDir) {
            const children = await IOUtils.getChildren(this.payloadCacheDir).catch(() => []);
            for (const child of children) {
                await IOUtils.remove(child, { recursive: true } as any).catch(() => undefined);
            }
        }

        return { metadataRows, payloadRows };
    }

    /** Remove stale rows and orphan payload files. */
    async runStartupGC(): Promise<void> {
        try {
            let removedMetadata = 0;
            let removedPayloads = 0;
            let removedFiles = 0;
            const metadataRows = await this.db.getAllDocumentCacheMetadata();
            const missingOrTrashed = await this.getMissingOrTrashedKeys(metadataRows);
            for (const metadata of metadataRows) {
                const expectedSchemaVersion = metadata.documentMetadata === null
                    ? null
                    : expectedExtractionSchemaVersion(metadata.contentKind);
                let stale = metadata.metadataFormatVersion !== DOCUMENT_METADATA_FORMAT_VERSION
                    || expectedSchemaVersion === null
                    || metadata.extractionSchemaVersion !== expectedSchemaVersion
                    || missingOrTrashed.has(DocumentCache.itemKey(metadata.libraryId, metadata.zoteroKey));
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
                const expectedSchemaVersion = expectedExtractionSchemaVersion(payload.contentKind);
                const invalid = payload.cacheFormatVersion !== DOCUMENT_PAYLOAD_FORMAT_VERSION
                    || expectedSchemaVersion === null
                    || payload.extractionSchemaVersion !== expectedSchemaVersion
                    || !(await IOUtils.exists(payload.payloadPath).catch(() => false));
                if (invalid) {
                    const deleted = await this.db.deleteDocumentCachePayload(payload.libraryId, payload.zoteroKey, payload.payloadKind);
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

    private async putResultUnlocked<T extends CacheablePayload>(input: {
        item: DocumentCacheItemRef;
        filePath: string;
        mode: ExtractionMode;
        sourceSizeBytes: number;
        contentType: string;
        result: T;
        metadata: CacheMetadataInput;
        expectedSourceIdentity?: DocumentCacheSourceIdentity | null;
    }): Promise<void> {
        if (Zotero.__beaverShuttingDown) return;
        const source = await this.getSourceIdentity(input.filePath, input.sourceSizeBytes);
        if (input.expectedSourceIdentity && !this.sourceIdentityMatches(source, input.expectedSourceIdentity)) {
            return;
        }
        if (Zotero.__beaverShuttingDown) return;

        const payloadKind = DocumentCache.payloadKindForMode(input.mode);
        const metadataInput = this.buildMetadataInput(input.item, source, input.contentType, input.metadata);
        const result = input.result as { mode?: string; schemaVersion: string };
        if (
            (result.mode !== undefined && result.mode !== input.mode)
            || result.schemaVersion !== metadataInput.extractionSchemaVersion
        ) {
            return;
        }
        const payloadWrite = await this.writePayloadFile(
            input.item.libraryID,
            input.item.key,
            payloadKind,
            input.result,
        );
        const { metadata, deletedPayloads } = await this.db.upsertDocumentCacheMetadata(metadataInput);
        const oldPayload = await this.db.getDocumentCachePayload(input.item.libraryID, input.item.key, payloadKind);
        await this.db.upsertDocumentCachePayload({
            metadataId: metadata.id,
            itemId: input.item.id,
            libraryId: input.item.libraryID,
            zoteroKey: input.item.key,
            payloadKind,
            contentKind: metadataInput.contentKind,
            sourceFilePath: source.filePath,
            sourceFileSignature: source.fileSignature,
            sourceSizeBytes: source.sourceSizeBytes,
            payloadPath: payloadWrite.path,
            payloadSizeBytes: payloadWrite.size,
            payloadSha256: payloadWrite.sha256,
            extractionSchemaVersion: metadataInput.extractionSchemaVersion,
            cacheFormatVersion: DOCUMENT_PAYLOAD_FORMAT_VERSION,
        });
        const cleanup = oldPayload && oldPayload.payloadPath !== payloadWrite.path
            ? [...deletedPayloads, oldPayload]
            : deletedPayloads;
        await this.removePayloadFiles(
            cleanup.filter((payload) => payload.payloadPath !== payloadWrite.path),
        );
    }

    private async putSerializedResultUnlocked(input: {
        item: DocumentCacheItemRef;
        filePath: string;
        mode: ExtractionMode;
        sourceSizeBytes: number;
        contentType: string;
        result: SerializedDocumentCacheResult | SerializedBeaverExtractResult;
        metadata: CacheMetadataInput;
        expectedSourceIdentity?: DocumentCacheSourceIdentity | null;
    }): Promise<void> {
        if (Zotero.__beaverShuttingDown) return;
        const source = await this.getSourceIdentity(input.filePath, input.sourceSizeBytes);
        if (input.expectedSourceIdentity && !this.sourceIdentityMatches(source, input.expectedSourceIdentity)) {
            return;
        }
        if (Zotero.__beaverShuttingDown) return;

        const payloadKind = DocumentCache.payloadKindForMode(input.mode);
        const metadataInput = this.buildMetadataInput(input.item, source, input.contentType, input.metadata);
        if (
            input.result.mode !== input.mode
            || input.result.schemaVersion !== metadataInput.extractionSchemaVersion
        ) {
            return;
        }
        const payloadWrite = await this.writePayloadBytesFile(
            input.item.libraryID,
            input.item.key,
            payloadKind,
            input.result.jsonBytes,
        );
        const { metadata, deletedPayloads } = await this.db.upsertDocumentCacheMetadata(metadataInput);
        const oldPayload = await this.db.getDocumentCachePayload(input.item.libraryID, input.item.key, payloadKind);
        await this.db.upsertDocumentCachePayload({
            metadataId: metadata.id,
            itemId: input.item.id,
            libraryId: input.item.libraryID,
            zoteroKey: input.item.key,
            payloadKind,
            contentKind: metadataInput.contentKind,
            sourceFilePath: source.filePath,
            sourceFileSignature: source.fileSignature,
            sourceSizeBytes: source.sourceSizeBytes,
            payloadPath: payloadWrite.path,
            payloadSizeBytes: payloadWrite.size,
            payloadSha256: payloadWrite.sha256,
            extractionSchemaVersion: metadataInput.extractionSchemaVersion,
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
        if (record.documentMetadata === null) return true;
        if (record.metadataFormatVersion !== DOCUMENT_METADATA_FORMAT_VERSION) return true;
        const expectedSchemaVersion = expectedExtractionSchemaVersion(record.contentKind);
        if (expectedSchemaVersion === null || record.extractionSchemaVersion !== expectedSchemaVersion) return true;
        if (record.filePath !== filePath) return true;
        if (isRemoteFilePath(filePath)) return false;
        const exists = await IOUtils.exists(filePath).catch(() => false);
        if (!exists) return true;
        const signature = await getFileSignature(filePath);
        return signature.mtime_ms !== record.fileSignature.mtime_ms
            || signature.size_bytes !== record.fileSignature.size_bytes;
    }

    private static itemKey(libraryId: number, zoteroKey: string): string {
        return `${libraryId}/${zoteroKey}`;
    }

    private static payloadKindForMode(mode: ExtractionMode): PayloadKind {
        return mode;
    }

    /**
     * Identify cached items that no longer exist or have been moved to the trash.
     */
    private async getMissingOrTrashedKeys(
        rows: DocumentCacheMetadataRecord[],
    ): Promise<Set<string>> {
        const stale = new Set<string>();
        if (rows.length === 0) return stale;

        // Group keys by library so each query targets a single libraryID.
        const keysByLibrary = new Map<number, Set<string>>();
        for (const row of rows) {
            let keys = keysByLibrary.get(row.libraryId);
            if (!keys) {
                keys = new Set<string>();
                keysByLibrary.set(row.libraryId, keys);
            }
            keys.add(row.zoteroKey);
        }

        const CHUNK_SIZE = 500;
        for (const [libraryId, keySet] of keysByLibrary) {
            const keys = [...keySet];
            // Keys that exist and are not trashed (neither the item nor its parent).
            const live = new Set<string>();
            for (let i = 0; i < keys.length; i += CHUNK_SIZE) {
                const chunk = keys.slice(i, i + CHUNK_SIZE);
                const placeholders = chunk.map(() => '?').join(', ');
                const sql = `
                    SELECT i.key,
                           CASE WHEN d.itemID IS NOT NULL THEN 1 ELSE 0 END AS trashed,
                           CASE WHEN dp.itemID IS NOT NULL THEN 1 ELSE 0 END AS parentTrashed
                    FROM items i
                    LEFT JOIN deletedItems d ON d.itemID = i.itemID
                    LEFT JOIN itemAttachments ia ON ia.itemID = i.itemID
                    LEFT JOIN deletedItems dp ON dp.itemID = ia.parentItemID
                    WHERE i.libraryID = ? AND i.key IN (${placeholders})
                `;
                // onRow callback avoids Proxy access issues on the returned rows.
                await Zotero.DB.queryAsync(sql, [libraryId, ...chunk], {
                    onRow: (row: any) => {
                        const key = row.getResultByIndex(0);
                        const trashed = row.getResultByIndex(1);
                        const parentTrashed = row.getResultByIndex(2);
                        if (!trashed && !parentTrashed) {
                            live.add(key);
                        }
                    },
                });
            }
            // Any cached key absent from the live set is missing or trashed.
            for (const key of keys) {
                if (!live.has(key)) {
                    stale.add(DocumentCache.itemKey(libraryId, key));
                }
            }
        }
        return stale;
    }

    private isPayloadRowFresh(
        payload: DocumentCachePayloadRecord,
        metadata: DocumentCacheMetadataRecord,
        payloadKind: PayloadKind,
    ): boolean {
        const expectedSchemaVersion = expectedExtractionSchemaVersion(metadata.contentKind);
        return payload.payloadKind === payloadKind
            && payload.cacheFormatVersion === DOCUMENT_PAYLOAD_FORMAT_VERSION
            && metadata.documentMetadata !== null
            && expectedSchemaVersion !== null
            && payload.extractionSchemaVersion === expectedSchemaVersion
            && payload.contentKind === metadata.contentKind
            && payload.metadataId === metadata.id
            && payload.sourceFilePath === metadata.filePath
            && payload.sourceFileSignature.mtime_ms === metadata.fileSignature.mtime_ms
            && payload.sourceFileSignature.size_bytes === metadata.fileSignature.size_bytes
            && payload.sourceSizeBytes === metadata.sourceSizeBytes;
    }

    private isLikelySerializedPdfResult(
        jsonBytes: Uint8Array,
        mode: ExtractionMode,
        pageCount: number | null,
    ): boolean {
        if (jsonBytes.byteLength < 2) return false;
        if (jsonBytes[0] !== 0x7b || jsonBytes[jsonBytes.byteLength - 1] !== 0x7d) {
            return false;
        }
        const head = new TextDecoder().decode(
            jsonBytes.subarray(0, Math.min(jsonBytes.byteLength, 16 * 1024)),
        );
        if (!head.includes(`"mode":"${mode}"`)) return false;
        const expectedSchema = expectedExtractionSchemaVersion('pdf');
        if (expectedSchema && !head.includes(`"schemaVersion":"${expectedSchema}"`)) {
            return false;
        }
        if (pageCount != null && !new RegExp(`"pageCount":${pageCount}(?=[,}])`).test(head)) {
            return false;
        }
        return true;
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
        item: DocumentCacheItemRef,
        source: DocumentCacheSourceIdentity,
        contentType: string,
        metadata: CacheMetadataInput,
    ): DocumentCacheMetadataInput {
        const contentKind = metadata.contentKind ?? 'pdf';
        const extractionSchemaVersion = expectedExtractionSchemaVersion(contentKind);
        if (extractionSchemaVersion === null) {
            throw new Error(`Document cache does not support ${contentKind} writes yet`);
        }
        const pageLabels = this.normalizePageLabels(metadata.pageLabels);
        const pages = metadata.pages ?? null;
        return {
            itemId: item.id,
            libraryId: item.libraryID,
            zoteroKey: item.key,
            contentKind,
            filePath: source.filePath,
            fileSignature: source.fileSignature,
            sourceSizeBytes: source.sourceSizeBytes,
            contentType,
            documentMetadata: contentKind === 'epub'
                ? buildEpubCachedMetadata(
                    metadata.epubSections ?? [],
                    metadata.epubExtractedTextChars,
                    metadata.epubPageCount,
                )
                : contentKind === 'snapshot'
                    ? buildSnapshotCachedMetadata(
                        metadata.snapshotSections ?? [],
                        metadata.snapshotTitle,
                        metadata.snapshotPageCount,
                        metadata.snapshotExtractedTextChars,
                    )
                    : buildPdfCachedMetadata(metadata.pageCount, pageLabels, pages),
            errorCode: metadata.errorCode ?? null,
            extractionSchemaVersion,
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

    private async writePayloadFile<T extends CacheablePayload>(
        libraryId: number,
        zoteroKey: string,
        payloadKind: PayloadKind,
        result: T,
    ): Promise<{ path: string; size: number; sha256: string }> {
        return this.writePayloadFromGzip(
            libraryId,
            zoteroKey,
            payloadKind,
            () => gzipJsonValueChunked(result),
            'writePayloadFile',
        );
    }

    private async writePayloadBytesFile(
        libraryId: number,
        zoteroKey: string,
        payloadKind: PayloadKind,
        jsonBytes: Uint8Array,
    ): Promise<{ path: string; size: number; sha256: string }> {
        return this.writePayloadFromGzip(
            libraryId,
            zoteroKey,
            payloadKind,
            () => gzipUtf8BytesChunked(jsonBytes),
            'writePayloadBytesFile',
        );
    }

    private async writePayloadFromGzip(
        libraryId: number,
        zoteroKey: string,
        payloadKind: PayloadKind,
        gzipPayload: () => Promise<Uint8Array>,
        label: string,
    ): Promise<{ path: string; size: number; sha256: string }> {
        const gzipStart = Date.now();
        const bytes = await gzipPayload();
        const gzipMs = Date.now() - gzipStart;
        if (gzipMs > 2000) {
            logger(
                `DocumentCache.${label}: gzip ${bytes.byteLength} bytes for `
                + `${libraryId}-${zoteroKey} (${payloadKind}) took ${gzipMs}ms`,
                2,
            );
        }
        const sha256 = await this.sha256Hex(bytes);
        const dir = this.libraryDir(libraryId);
        await (IOUtils as any).makeDirectory(dir, { createAncestors: true }).catch(() => undefined);

        const finalPath = PathUtils.join(dir, `${zoteroKey}.${payloadKind}.${sha256}.json.gz`);
        const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const tempPath = PathUtils.join(dir, `${zoteroKey}.${payloadKind}.${sha256}.${nonce}.tmp`);

        const exists = await IOUtils.exists(finalPath).catch(() => false);
        if (exists && !(await this.payloadFileMatches(finalPath, bytes, sha256))) {
            await IOUtils.remove(finalPath).catch(() => undefined);
        }
        const validExists = await IOUtils.exists(finalPath).catch(() => false);
        if (!validExists) {
            await IOUtils.write(tempPath, bytes);
            await IOUtils.write(finalPath, bytes);
            await IOUtils.remove(tempPath).catch(() => undefined);
        }

        return { path: finalPath, size: bytes.byteLength, sha256 };
    }

    private async payloadFileMatches(path: string, expectedBytes: Uint8Array, expectedSha256: string): Promise<boolean> {
        try {
            const existing = await IOUtils.read(path);
            if (existing.byteLength !== expectedBytes.byteLength) return false;
            const existingSha256 = await this.sha256Hex(existing);
            return existingSha256 === expectedSha256;
        } catch {
            return false;
        }
    }

    private async deletePayload(payload: DocumentCachePayloadRecord, removeFile = true): Promise<void> {
        const deleted = await this.db.deleteDocumentCachePayloadIfUnchanged(payload);
        if (!deleted) return;
        if (removeFile) {
            const current = await this.db.getDocumentCachePayload(
                payload.libraryId,
                payload.zoteroKey,
                payload.payloadKind,
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

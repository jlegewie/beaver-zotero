/**
 * Shared extraction core for whole-document PDF extraction.
 *
 * Factored out of `handleZoteroDocumentRequest` so it can be reused by the
 * background extractor (timeout-retry path) without duplicating the
 * cache-lookup / resolve / preflight / extract pipeline.
 *
 * Routing: `workerName` selects which MuPDF worker the call uses
 * (`"hot"` is the default; `"background"` is reserved for the queue
 * processor). The shared core calls `getMuPDFWorkerClient(workerName)`
 * directly for every MuPDF op — never via `BeaverExtractor`, which
 * always uses the default `"hot"` slot internally.
 */

import type {
    BeaverExtractResult,
    SerializedBeaverExtractResult,
} from '../beaver-extract/schema';
import type { PageGeometry } from '../beaver-extract/types';
import {
    ExtractionError,
    ExtractionErrorCode,
    StaleWorkerError,
    WorkerAbortError,
    WorkerSpawnError,
    getMuPDFWorkerClient,
    isWorkerDeadlineError,
    type PDFWorkerSlotName,
} from '../beaver-extract';
import {
    DEFAULT_PAGES_TIMEOUT_SECONDS,
    ExternalAbortError,
    MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS,
    MAX_PDF_TIMEOUT_SECONDS,
    TimeoutError,
    type TimeoutControllerContext,
    awaitWithRequestAbort,
    createTimeoutController,
} from './agentDataProvider/timeout';
import type { ZoteroDocumentErrorCode } from './agentProtocol';
import type { DocumentCacheExtractionMode } from './database';
import type {
    DocumentCacheItemRef,
    DocumentCacheSourceIdentity,
    SerializedDocumentCacheResult,
} from './documentCache';
import { logger } from '../utils/logger';
import { effectiveMaxFileSizeMB, effectiveMaxPageCount, effectiveMaxSnapshotFileSizeMB } from './attachmentLimits';
import {
    loadAttachmentData,
    resolveAttachmentFileSource,
    resolveToReadableAttachment,
    validateZoteroItemReference,
    preflightCachedPdfMeta,
    type AttachmentFileSource,
} from './documentExtraction';
import { readableToExtractKind, type ExtractContentKind } from './documentExtraction/shared/contentKinds';
import {
    extractEpubDocumentFromFile,
    preflightEpubFile,
    type EpubDocument,
} from './documentExtraction/epub';
import {
    extractSnapshotDocumentFromFile,
    preflightSnapshotFile,
    resolveSnapshotSectionMeta,
    type SnapshotDocument,
} from './documentExtraction/snapshot';

/**
 * Extra margin granted to a shared hot-slot extraction beyond the request's
 * own deadline before the document cache aborts it (and the worker client
 * terminates the worker), freeing the interactive slot for the next read.
 * The request timeout plus this grace must stay below
 * DEFAULT_BUSY_LEASE_MS_HOT so the cache abort reclaims the slot before the
 * worker client's busy lease reaps the operation. Hot-slot request timeouts
 * are clamped to MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS to enforce this.
 */
export const HOT_SHARED_EXTRACTION_GRACE_MS = 2000;

export interface ResolvedAttachment {
    libraryId: number;
    zoteroKey: string;
}

/**
 * Source identity for an already-resolved extraction target.
 *
 * `zotero` keeps the existing behavior exactly (item-based file resolution,
 * remote download fallback). `external` is a user-attached external file: the
 * managed copy at `filePath` is the only source (no remote fallback) and
 * `itemRef` supplies the synthetic cache identity
 * ({ id: 0, libraryID: EXTERNAL_LIBRARY_ID, key: extKey }).
 */
export type ExtractionSource =
    | { kind: 'zotero'; item: Zotero.Item }
    | { kind: 'external'; filePath: string; itemRef: DocumentCacheItemRef };

/** Inline local-file source check for external files (no Zotero item). */
async function resolveExternalFileSource(
    filePath: string,
    maxFileSizeMBInput: number,
): Promise<
    | { kind: 'ok'; filePath: string }
    | { kind: 'error'; code: 'file_missing' | 'file_too_large'; sizeMB?: number; maxMB?: number }
> {
    const maxMB = effectiveMaxFileSizeMB(maxFileSizeMBInput);
    let stat: { size?: number | null };
    try {
        stat = await IOUtils.stat(filePath);
    } catch {
        return { kind: 'error', code: 'file_missing' };
    }
    const sizeMB = (stat.size ?? 0) / 1024 / 1024;
    if (sizeMB > maxMB) {
        return { kind: 'error', code: 'file_too_large', sizeMB, maxMB };
    }
    return { kind: 'ok', filePath };
}

/**
 * Match an `ExtractionError` even when it was constructed in the other bundle.
 * The shared MuPDF worker client is a cross-bundle singleton and rehydrates
 * errors using its own bundle's `ExtractionError` class, so a document request
 * served from the other bundle would fail a plain `instanceof` check and
 * misroute a document verdict (e.g. heap exhaustion) into a generic bucket.
 * Falls back to the structural `name`/`code` shape the worker always sets.
 */
function asExtractionError(error: unknown): ExtractionError | null {
    if (error instanceof ExtractionError) return error;
    if (
        error
        && typeof error === 'object'
        && (error as { name?: unknown }).name === 'ExtractionError'
        && typeof (error as { code?: unknown }).code === 'string'
    ) {
        return error as ExtractionError;
    }
    return null;
}

/**
 * True only for worker *lifecycle* failures (the engine could not start /
 * respawn), bundle-agnostic via an `instanceof` + `name` fallback. Deliberately
 * excludes heap exhaustion (an `ExtractionError`, a document verdict) so those
 * keep their `pdf_too_complex` classification instead of being reported as a
 * transient worker outage.
 */
function isWorkerLifecycleError(error: unknown): boolean {
    if (error instanceof StaleWorkerError || error instanceof WorkerSpawnError) {
        return true;
    }
    const name = (error as { name?: unknown } | null | undefined)?.name;
    return name === 'StaleWorkerError' || name === 'WorkerSpawnError';
}

export interface ExtractAndCacheArgs {
    libraryId: number;
    zoteroKey: string;
    mode: DocumentCacheExtractionMode;
    /**
     * Reject threshold for total document page count. `null` falls back to
     * Beaver's hard page-count cap. Counted in *document* pages, not requested
     * pages.
     */
    maxPages: number | null;
    maxFileSizeMB: number;
    /** Extraction deadline in seconds. */
    timeoutSeconds: number;
    /** Default `"hot"`. Background processor sets `"background"`. */
    workerName?: PDFWorkerSlotName;
    /**
     * Caller-supplied abort signal. When it fires, the in-flight
     * extraction returns `{ kind: 'external_abort' }` so the caller can
     * release the work without counting it as a failure.
     */
    externalAbortSignal?: AbortSignal;
    /**
     * Invoked once on remote-download failure (before the error is rethrown
     * internally)
     */
    onRemoteDownloadFailure?: (error: unknown) => void;
}

export interface ExtractAndCacheResolvedPdfArgs
    extends Omit<ExtractAndCacheArgs, 'libraryId' | 'zoteroKey'> {
    source: ExtractionSource;
    resolvedKey: string;
    contentType: string;
    /** Reuse the caller's timeout when item resolution and PDF extraction share one deadline. */
    timeoutContext?: TimeoutControllerContext;
    /** Return pre-serialized PDF JSON bytes instead of a parsed result object. */
    serializedResult?: boolean;
}

export interface ExtractAndCacheEpubArgs {
    source: ExtractionSource;
    resolvedKey: string;
    contentType: string;
    /**
     * Reject threshold for total document page count. `null` falls back to
     * Beaver's hard page-count cap. EPUB pages are the extractor's per-item
     * `pageNumber` coordinate (physical print pages when the book carries
     * markers, otherwise synthetic ~character-interval pages).
     */
    maxPages: number | null;
    maxFileSizeMB: number;
    externalAbortSignal?: AbortSignal;
    onFileNotSyncedLocally?: () => void;
}

export interface ExtractAndCacheSnapshotArgs {
    source: ExtractionSource;
    resolvedKey: string;
    contentType: string;
    /**
     * Reject threshold for total document page count. `null` falls back to
     * Beaver's hard page-count cap. Snapshot pages are the extractor's per-item
     * synthetic `pageNumber` coordinate (~character-interval pages).
     */
    maxPages: number | null;
    maxFileSizeMB: number;
    externalAbortSignal?: AbortSignal;
    onFileNotSyncedLocally?: () => void;
}

export type ExtractAndCacheSnapshotResult =
    | {
          kind: 'ok';
          cached: boolean;
          document: SnapshotDocument;
          resolvedAttachment: ResolvedAttachment;
          contentType: string;
      }
    | {
          kind: 'response_error';
          code: ZoteroDocumentErrorCode;
          message: string;
          /** Document page count when known (e.g. the count that tripped `too_many_pages`). */
          pageCount?: number | null;
          resolvedAttachment: ResolvedAttachment;
          contentKind?: ExtractContentKind;
      };

export function buildExtractedDocumentCacheMetadata(extracted: BeaverExtractResult): {
    pageCount: number;
    pageLabels: Record<string, string>;
    pages: (PageGeometry | null)[];
} {
    const doc = extracted.document;
    const extractedPageLabels = doc.pageLabels ?? Object.fromEntries(
        doc.pages
            .filter((page) => page.label)
            .map((page) => [String(page.index), page.label as string]),
    );
    const pages: (PageGeometry | null)[] = new Array(doc.pageCount).fill(null);
    for (const page of doc.pages) {
        // Annotation cache geometry uses unrotated PDF user-space dimensions.
        // Structured-page width/height describe the extraction bbox frame.
        pages[page.index] = {
            viewBox: page.viewBox,
            width: page.viewBox[2] - page.viewBox[0],
            height: page.viewBox[3] - page.viewBox[1],
            rotation: page.rotation,
        };
    }
    return {
        pageCount: doc.pageCount,
        pageLabels: extractedPageLabels,
        pages,
    };
}

function serializedWorkerResultToCacheResult(
    extracted: SerializedBeaverExtractResult,
): SerializedDocumentCacheResult {
    return {
        schemaVersion: extracted.schemaVersion,
        mode: extracted.mode,
        document: { pageCount: extracted.pageCount },
        byteLength: extracted.byteLength,
        jsonBytes: extracted.jsonBytes,
        metadata: {
            pageCount: extracted.cacheMetadata.pageCount,
            pageLabels: extracted.cacheMetadata.pageLabels,
            pages: extracted.cacheMetadata.pages,
        },
    };
}

export type ExtractAndCacheResult =
    | {
          kind: 'ok';
          cached: boolean;
          result: BeaverExtractResult;
          serializedResult?: undefined;
          totalPages: number;
          resolvedAttachment: ResolvedAttachment;
          contentType: string;
      }
    | {
          kind: 'ok';
          cached: boolean;
          result?: undefined;
          serializedResult: SerializedDocumentCacheResult;
          totalPages: number;
          resolvedAttachment: ResolvedAttachment;
          contentType: string;
      }
    | {
          kind: 'cached_error';
          code: 'encrypted' | 'invalid_pdf' | 'no_text_layer';
          message: string;
          pageCount: number | null;
          resolvedAttachment: ResolvedAttachment | null;
          contentKind?: ExtractContentKind;
      }
    | {
          kind: 'response_error';
          code: ZoteroDocumentErrorCode;
          message: string;
          pageCount: number | null;
          resolvedAttachment: ResolvedAttachment | null;
          contentKind?: ExtractContentKind;
      }
    | {
          kind: 'timeout';
          phase: string;
          timeoutSeconds: number;
          pageCount: number | null;
          resolvedAttachment: ResolvedAttachment | null;
          /** True when the worker busy-lease watchdog reaped the operation. */
          leaseReaped?: boolean;
          /**
           * True when this request's own extraction dispatched to the PDF
           * worker before timing out. Stays false for timeouts during cache
           * pre-work (reads, decompression) and for requests joined to another
           * request's in-flight shared extraction, so the worker snapshot on
           * the response never describes unrelated activity.
           */
          workerDispatched?: boolean;
      }
    | {
          kind: 'external_abort';
          phase: string;
          pageCount: number | null;
          resolvedAttachment: ResolvedAttachment | null;
          /** True when this request dispatched to the PDF worker before the external abort. */
          workerDispatched?: boolean;
      };

export type ExtractAndCacheEpubResult =
    | {
          kind: 'ok';
          cached: boolean;
          document: EpubDocument;
          resolvedAttachment: ResolvedAttachment;
          contentType: string;
      }
    | {
          kind: 'response_error';
          code: ZoteroDocumentErrorCode;
          message: string;
          /** Document page count when known (e.g. the count that tripped `too_many_pages`). */
          pageCount?: number | null;
          resolvedAttachment: ResolvedAttachment;
          contentKind?: ExtractContentKind;
      };

function isAbortError(error: unknown): boolean {
    return error instanceof Error && /abort/i.test(error.message);
}

export async function extractAndCacheDocument(
    args: ExtractAndCacheArgs,
): Promise<ExtractAndCacheResult> {
    const requestKey = `${args.libraryId}-${args.zoteroKey}`;

    const formatError = validateZoteroItemReference({
        library_id: args.libraryId,
        zotero_key: args.zoteroKey,
    });
    if (formatError) {
        return {
            kind: 'response_error',
            code: 'invalid_format',
            message: `Invalid attachment reference '${requestKey}': ${formatError}`,
            pageCount: null,
            resolvedAttachment: null,
        };
    }

    const timeout = createTimeoutController(
        args.timeoutSeconds,
        DEFAULT_PAGES_TIMEOUT_SECONDS,
        args.externalAbortSignal,
        (args.workerName ?? 'hot') === 'hot'
            ? MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS
            : undefined,
    );
    const { signal, timeoutSeconds, throwIfTimedOut, dispose } = timeout;

    try {
        const zoteroItem = await awaitWithRequestAbort(
            Zotero.Items.getByLibraryAndKeyAsync(args.libraryId, args.zoteroKey),
            signal,
            throwIfTimedOut,
            'zotero_item_lookup',
        );
        if (!zoteroItem) {
            return {
                kind: 'response_error',
                code: 'not_found',
                message: `Attachment does not exist in user's library: ${requestKey}`,
                pageCount: null,
                resolvedAttachment: null,
            };
        }

        await awaitWithRequestAbort(
            zoteroItem.loadAllData(),
            signal,
            throwIfTimedOut,
            'zotero_item_load',
        );

        const resolveResult = await awaitWithRequestAbort(
            resolveToReadableAttachment(zoteroItem, requestKey),
            signal,
            throwIfTimedOut,
            'readable_attachment_resolution',
        );
        if (!resolveResult.resolved) {
            const code = resolveResult.error_code === 'not_readable'
                ? 'unsupported_type'
                : resolveResult.error_code;
            return {
                kind: 'response_error',
                code,
                message: resolveResult.error,
                pageCount: null,
                resolvedAttachment: null,
            };
        }

        const { item: resolvedItem, contentKind } = resolveResult;
        const resolvedAttachment = {
            libraryId: resolvedItem.libraryID,
            zoteroKey: resolvedItem.key,
        };

        if (contentKind !== 'pdf') {
            const extractKind = readableToExtractKind(contentKind);
            return {
                kind: 'response_error',
                code: 'unsupported_type',
                message: `Attachment ${resolveResult.key} is a ${contentKind} document, but document extraction currently supports PDF only.`,
                pageCount: null,
                resolvedAttachment,
                ...(extractKind ? { contentKind: extractKind } : {}),
            };
        }

        return await extractAndCacheResolvedPdfDocument({
            ...args,
            source: { kind: 'zotero', item: resolvedItem },
            resolvedKey: resolveResult.key,
            contentType: resolveResult.contentType,
            timeoutContext: timeout,
        });
    } catch (error) {
        if (error instanceof ExternalAbortError) {
            return {
                kind: 'external_abort',
                phase: error.phase,
                pageCount: null,
                resolvedAttachment: null,
            };
        }
        if (error instanceof TimeoutError || signal.aborted) {
            return {
                kind: 'timeout',
                phase: error instanceof TimeoutError ? error.phase : 'unknown',
                timeoutSeconds,
                pageCount: null,
                resolvedAttachment: null,
            };
        }
        throw error;
    } finally {
        dispose();
    }
}

/**
 * Run the EPUB extraction pipeline for an already-resolved EPUB attachment.
 * Expected outcomes are returned as a tagged union for caller-side mapping.
 */
export async function extractAndCacheEpubDocument(
    args: ExtractAndCacheEpubArgs,
): Promise<ExtractAndCacheEpubResult> {
    const cacheItemRef: DocumentCacheItemRef = args.source.kind === 'zotero'
        ? args.source.item
        : args.source.itemRef;
    const resolvedAttachment = {
        libraryId: cacheItemRef.libraryID,
        zoteroKey: cacheItemRef.key,
    };
    const requestKey = args.resolvedKey;

    let filePath: string;
    if (args.source.kind === 'zotero') {
        const preflight = await preflightEpubFile(args.source.item, {
            maxFileSizeMB: args.maxFileSizeMB,
            onFileNotSyncedLocally: args.onFileNotSyncedLocally,
        });
        if (preflight.kind === 'response_error') {
            return {
                kind: 'response_error',
                code: preflight.code,
                message: preflight.message,
                resolvedAttachment,
                contentKind: 'epub',
            };
        }
        filePath = preflight.filePath;
    } else {
        // External files skip the Zotero preflight (kind already validated at
        // attach time; the managed copy is local-only).
        const externalSource = await resolveExternalFileSource(args.source.filePath, args.maxFileSizeMB);
        if (externalSource.kind === 'error') {
            return {
                kind: 'response_error',
                code: externalSource.code,
                message: externalSource.code === 'file_missing'
                    ? `The EPUB file for ${requestKey} is not available on this device.`
                    : `The EPUB file for ${requestKey} is ${(externalSource.sizeMB ?? 0).toFixed(1)} MB, which exceeds the ${externalSource.maxMB} MB limit.`,
                resolvedAttachment,
                contentKind: 'epub',
            };
        }
        filePath = externalSource.filePath;
    }

    const maxFileSizeMB = effectiveMaxFileSizeMB(args.maxFileSizeMB);
    const maxSourceSizeBytes = maxFileSizeMB * 1024 * 1024;
    const maxPages = effectiveMaxPageCount(args.maxPages);

    const okOrNoText = (
        document: EpubDocument,
        cached: boolean,
    ): ExtractAndCacheEpubResult => {
        if (document.diagnostics.extractedTextChars === 0) {
            return {
                kind: 'response_error',
                code: 'no_text_layer',
                message: `The EPUB file for ${requestKey} contains no extractable text.`,
                resolvedAttachment,
                contentKind: 'epub',
            };
        }
        // Match the PDF path and the backend's document_fetch_max_pages: reject
        // oversized documents before serializing the (potentially large) payload.
        // EPUB page counts are the extractor's per-item page coordinate.
        if (document.pageCount != null && document.pageCount > maxPages) {
            return {
                kind: 'response_error',
                code: 'too_many_pages',
                message: `The EPUB file for ${requestKey} has ${document.pageCount} pages, which exceeds the ${maxPages}-page limit.`,
                pageCount: document.pageCount,
                resolvedAttachment,
                contentKind: 'epub',
            };
        }
        return {
            kind: 'ok',
            cached,
            document,
            resolvedAttachment,
            contentType: args.contentType,
        };
    };

    try {
        const cache = Zotero.Beaver?.documentCache;
        if (!cache) {
            logger(`extractAndCacheEpubDocument: document cache not available for ${requestKey}`, 1);
            return okOrNoText(
                await extractEpubDocumentFromFile(filePath, { abortSignal: args.externalAbortSignal }),
                false,
            );
        }

        const ref = {
            libraryId: cacheItemRef.libraryID,
            zoteroKey: cacheItemRef.key,
        };
        const cached = await cache.getEpubResult(ref, filePath, { maxSourceSizeBytes }).catch(() => null);
        if (cached) {
            return okOrNoText(cached, true);
        }

        let created = false;
        const document = await cache.getOrCreateResult<EpubDocument>({
            item: cacheItemRef,
            filePath,
            contentKind: 'epub',
            mode: 'structured',
            sourceSizeBytes: 0,
            contentType: args.contentType,
            maxSourceSizeBytes,
            abortSignal: args.externalAbortSignal,
            readCached: (cacheRef) => cache.getEpubResult(cacheRef, filePath, { maxSourceSizeBytes }),
            create: async (signal) => {
                created = true;
                return extractEpubDocumentFromFile(filePath, { abortSignal: signal });
            },
            metadata: (doc) => ({
                contentKind: 'epub',
                // PDF-only fields stay null for EPUB.
                pageCount: null,
                pageLabels: null,
                pages: null,
                epubPageCount: doc.pageCount ?? null,
                epubSections: doc.sections.map((section) => ({
                    index: section.index,
                    rawHref: section.rawHref,
                    label: section.label,
                    itemCount: section.items.length,
                    // Item-less sections do not have an extraction page. Page
                    // numbers are non-decreasing in reading order, so the first
                    // and last items bound the section's page span.
                    firstPageNumber: section.items[0]?.pageNumber,
                    lastPageNumber: section.items[section.items.length - 1]?.pageNumber,
                })),
                epubExtractedTextChars: doc.diagnostics.extractedTextChars,
            }),
        });

        if (!document) {
            return {
                kind: 'response_error',
                code: 'file_too_large',
                message: `The EPUB file for ${requestKey} exceeds the ${maxFileSizeMB}MB limit.`,
                resolvedAttachment,
                contentKind: 'epub',
            };
        }

        return okOrNoText(document, !created);
    } catch (error) {
        if (args.externalAbortSignal?.aborted && isAbortError(error)) {
            return {
                kind: 'response_error',
                code: 'timeout',
                message: `EPUB extraction interrupted for ${requestKey}`,
                resolvedAttachment,
                contentKind: 'epub',
            };
        }
        return {
            kind: 'response_error',
            code: 'extraction_failed',
            message: `Failed to extract EPUB content for ${requestKey}: ${error instanceof Error ? error.message : String(error)}`,
            resolvedAttachment,
            contentKind: 'epub',
        };
    }
}

/**
 * Run the snapshot extraction pipeline for an already-resolved HTML snapshot
 * attachment. Expected outcomes are returned as a tagged union for caller-side
 * mapping, matching the EPUB extraction result shape.
 */
export async function extractAndCacheSnapshotDocument(
    args: ExtractAndCacheSnapshotArgs,
): Promise<ExtractAndCacheSnapshotResult> {
    const cacheItemRef: DocumentCacheItemRef = args.source.kind === 'zotero'
        ? args.source.item
        : args.source.itemRef;
    const resolvedAttachment = {
        libraryId: cacheItemRef.libraryID,
        zoteroKey: cacheItemRef.key,
    };
    const requestKey = args.resolvedKey;

    let filePath: string;
    if (args.source.kind === 'zotero') {
        const preflight = await preflightSnapshotFile(args.source.item, {
            maxFileSizeMB: args.maxFileSizeMB,
            onFileNotSyncedLocally: args.onFileNotSyncedLocally,
        });
        if (preflight.kind === 'response_error') {
            return {
                kind: 'response_error',
                code: preflight.code,
                message: preflight.message,
                resolvedAttachment,
                contentKind: 'snapshot',
            };
        }
        filePath = preflight.filePath;
    } else {
        // Match the tighter Zotero snapshot preflight limit for external files.
        const externalSource = await resolveExternalFileSource(
            args.source.filePath,
            effectiveMaxSnapshotFileSizeMB(args.maxFileSizeMB),
        );
        if (externalSource.kind === 'error') {
            return {
                kind: 'response_error',
                code: externalSource.code,
                message: externalSource.code === 'file_missing'
                    ? `The snapshot file for ${requestKey} is not available on this device.`
                    : `The snapshot file for ${requestKey} is ${(externalSource.sizeMB ?? 0).toFixed(1)} MB, which exceeds the ${externalSource.maxMB} MB limit.`,
                resolvedAttachment,
                contentKind: 'snapshot',
            };
        }
        filePath = externalSource.filePath;
    }

    // Section metadata (URL / title) for the single snapshot section. Only Zotero
    // items carry it; external files fall back to the filename in the extractor.
    const sectionMeta = args.source.kind === 'zotero'
        ? await resolveSnapshotSectionMeta(args.source.item)
        : {};

    // Keep cache and fallback errors aligned with snapshot preflight.
    const maxFileSizeMB = effectiveMaxSnapshotFileSizeMB(args.maxFileSizeMB);
    const maxSourceSizeBytes = maxFileSizeMB * 1024 * 1024;
    const maxPages = effectiveMaxPageCount(args.maxPages);

    const okOrNoText = (
        document: SnapshotDocument,
        cached: boolean,
    ): ExtractAndCacheSnapshotResult => {
        if (document.diagnostics.extractedTextChars === 0) {
            return {
                kind: 'response_error',
                code: 'no_text_layer',
                message: `The snapshot file for ${requestKey} contains no extractable text.`,
                resolvedAttachment,
                contentKind: 'snapshot',
            };
        }
        // Reject oversized extracted content before serializing the payload.
        if (document.pageCount != null && document.pageCount > maxPages) {
            return {
                kind: 'response_error',
                code: 'too_many_pages',
                message: `The snapshot for ${requestKey} is too long for Beaver to process — its extracted content exceeds the supported size.`,
                pageCount: document.pageCount,
                resolvedAttachment,
                contentKind: 'snapshot',
            };
        }
        return {
            kind: 'ok',
            cached,
            document,
            resolvedAttachment,
            contentType: args.contentType,
        };
    };

    try {
        const cache = Zotero.Beaver?.documentCache;
        if (!cache) {
            logger(`extractAndCacheSnapshotDocument: document cache not available for ${requestKey}`, 1);
            return okOrNoText(
                await extractSnapshotDocumentFromFile(filePath, {
                    ...sectionMeta,
                    abortSignal: args.externalAbortSignal,
                }),
                false,
            );
        }

        const ref = {
            libraryId: cacheItemRef.libraryID,
            zoteroKey: cacheItemRef.key,
        };
        const cached = await cache.getSnapshotResult(ref, filePath, { maxSourceSizeBytes }).catch(() => null);
        if (cached) {
            return okOrNoText(cached, true);
        }

        let created = false;
        const document = await cache.getOrCreateResult<SnapshotDocument>({
            item: cacheItemRef,
            filePath,
            contentKind: 'snapshot',
            mode: 'structured',
            sourceSizeBytes: 0,
            contentType: args.contentType,
            maxSourceSizeBytes,
            abortSignal: args.externalAbortSignal,
            readCached: (cacheRef) => cache.getSnapshotResult(cacheRef, filePath, { maxSourceSizeBytes }),
            create: async (signal) => {
                created = true;
                return extractSnapshotDocumentFromFile(filePath, { ...sectionMeta, abortSignal: signal });
            },
            metadata: (doc) => ({
                contentKind: 'snapshot',
                // PDF-only fields stay null for snapshots.
                pageCount: null,
                pageLabels: null,
                pages: null,
                snapshotPageCount: doc.pageCount ?? null,
                snapshotTitle: doc.sections[0]?.label,
                snapshotSections: doc.sections.map((section) => ({
                    index: section.index,
                    title: section.label,
                    itemCount: section.items.length,
                })),
                snapshotExtractedTextChars: doc.diagnostics.extractedTextChars,
            }),
        });

        if (!document) {
            return {
                kind: 'response_error',
                code: 'file_too_large',
                message: `The snapshot file for ${requestKey} exceeds the ${maxFileSizeMB}MB limit.`,
                resolvedAttachment,
                contentKind: 'snapshot',
            };
        }

        return okOrNoText(document, !created);
    } catch (error) {
        if (args.externalAbortSignal?.aborted && isAbortError(error)) {
            return {
                kind: 'response_error',
                code: 'timeout',
                message: `Snapshot extraction interrupted for ${requestKey}`,
                resolvedAttachment,
                contentKind: 'snapshot',
            };
        }
        return {
            kind: 'response_error',
            code: 'extraction_failed',
            message: `Failed to extract snapshot content for ${requestKey}: ${error instanceof Error ? error.message : String(error)}`,
            resolvedAttachment,
            contentKind: 'snapshot',
        };
    }
}

/**
 * Run the PDF extraction pipeline for an already-resolved PDF attachment.
 * Expected outcomes are returned as a tagged union for caller-side mapping.
 */
export async function extractAndCacheResolvedPdfDocument(
    args: ExtractAndCacheResolvedPdfArgs,
): Promise<ExtractAndCacheResult> {
    const {
        mode,
        externalAbortSignal,
    } = args;
    const workerName: PDFWorkerSlotName = args.workerName ?? 'hot';
    const requestKey = args.resolvedKey;

    const maxFileSizeMB = effectiveMaxFileSizeMB(args.maxFileSizeMB);
    const maxPages = effectiveMaxPageCount(args.maxPages);

    const ownsTimeout = !args.timeoutContext;
    const timeout = args.timeoutContext ?? createTimeoutController(
        args.timeoutSeconds,
        DEFAULT_PAGES_TIMEOUT_SECONDS,
        externalAbortSignal,
        workerName === 'hot' ? MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS : undefined,
    );
    const { signal, timeoutSeconds, throwIfTimedOut, dispose } = timeout;

    const client = getMuPDFWorkerClient(workerName);

    // Budget for the shared (single-flight) extraction on the document cache.
    // The hot slot serves interactive reads on the single interactive MuPDF
    // worker: once every waiter has detached (request timed out), letting the
    // shared extraction keep running up to MAX_PDF_TIMEOUT_SECONDS would
    // head-of-line-block every subsequent interactive read. Cap it near this
    // request's own deadline instead — the request's timeout path enqueues a
    // background re-extraction, so the result is still produced and cached on
    // the background slot. The background slot keeps the full ceiling.
    const sharedTimeoutMs = workerName === 'hot'
        ? Math.round(timeoutSeconds * 1000) + HOT_SHARED_EXTRACTION_GRACE_MS
        : MAX_PDF_TIMEOUT_SECONDS * 1000;

    const zoteroItem = args.source.kind === 'zotero' ? args.source.item : null;
    const cacheItemRef: DocumentCacheItemRef = zoteroItem ?? (args.source as Extract<ExtractionSource, { kind: 'external' }>).itemRef;
    let resolvedCacheRef: DocumentCacheItemRef | null = null;
    let resolvedAttachment: ResolvedAttachment | null = null;
    let resolvedFilePath: string | null = null;
    let totalPages: number | null = null;
    let loadedPdfData: Uint8Array | null = null;
    let workerDispatched = false;

    const aborted = (): ExtractAndCacheResult | null => {
        if (externalAbortSignal?.aborted) {
            return {
                kind: 'external_abort',
                phase: 'external_pre_abort',
                pageCount: totalPages,
                resolvedAttachment,
                workerDispatched,
            };
        }
        return null;
    };

    try {
        resolvedCacheRef = cacheItemRef;
        resolvedAttachment = {
            libraryId: cacheItemRef.libraryID,
            zoteroKey: cacheItemRef.key,
        };
        const resolvedKeyStr = args.resolvedKey;

        let attachmentSource: AttachmentFileSource;
        if (args.source.kind === 'external') {
            // External files: the managed copy is the only source — no remote
            // fallback, plain stat-based existence/size check.
            const externalSource = await resolveExternalFileSource(args.source.filePath, args.maxFileSizeMB);
            throwIfTimedOut('file_missing_response');
            if (externalSource.kind === 'error') {
                if (externalSource.code === 'file_too_large') {
                    return {
                        kind: 'response_error',
                        code: 'file_too_large',
                        message: `The PDF file for ${resolvedKeyStr} has a file size of ${(externalSource.sizeMB ?? 0).toFixed(1)}MB, which exceeds the ${externalSource.maxMB}MB limit.`,
                        pageCount: null,
                        resolvedAttachment,
                    };
                }
                return {
                    kind: 'response_error',
                    code: 'file_missing',
                    message: `The PDF file for ${resolvedKeyStr} is not available on this device.`,
                    pageCount: null,
                    resolvedAttachment,
                };
            }
            attachmentSource = { kind: 'local', filePath: externalSource.filePath, isRemoteOnly: false };
        } else {
            const source = await resolveAttachmentFileSource({
                item: args.source.item,
                maxFileSizeMB: args.maxFileSizeMB,
                localSizeStrategy: 'zotero-total',
                signal,
                throwIfTimedOut,
            });
            if (source.kind === 'error') {
                throwIfTimedOut('file_missing_response');
                if (source.code === 'file_too_large') {
                    return {
                        kind: 'response_error',
                        code: 'file_too_large',
                        message: `The PDF file for ${resolvedKeyStr} has a file size of ${(source.sizeMB ?? 0).toFixed(1)}MB, which exceeds the ${source.maxMB}MB limit.`,
                        pageCount: null,
                        resolvedAttachment,
                    };
                }
                return {
                    kind: 'response_error',
                    code: 'file_missing',
                    message: source.remoteAvailable
                        ? `The PDF file for ${resolvedKeyStr} is not available locally and remote file access is disabled in settings.`
                        : `The PDF file for ${resolvedKeyStr} is not available locally.`,
                    pageCount: null,
                    resolvedAttachment,
                };
            }
            attachmentSource = source.source;
        }
        const effectiveFilePath = attachmentSource.filePath;
        const isRemoteOnly = attachmentSource.isRemoteOnly;
        resolvedFilePath = effectiveFilePath;

        const cache = Zotero.Beaver?.documentCache;
        if (!cache) {
            logger(`extractAndCacheDocument: document cache not available for ${requestKey}`, 1);
        }
        const docRef = {
            libraryId: cacheItemRef.libraryID,
            zoteroKey: cacheItemRef.key,
        };
        const initialSourceIdentity: DocumentCacheSourceIdentity | null = cache && !isRemoteOnly
            ? await cache.getSourceIdentitySnapshot(effectiveFilePath).catch((error: unknown) => {
                logger(`extractAndCacheDocument: source identity snapshot failed for ${requestKey}: ${error}`, 1);
                return null;
            })
            : null;
        const cachedMeta = cache ? await cache.getMetadata(docRef, effectiveFilePath).catch(() => null) : null;
        throwIfTimedOut('metadata_cache_lookup');

        const preflight = preflightCachedPdfMeta(cachedMeta, {
            checkOcr: true,
            applyPageCountCap: true,
            maxPageCount: maxPages,
        });
        if (preflight) {
            switch (preflight.code) {
                case 'encrypted':
                    return {
                        kind: 'cached_error',
                        code: 'encrypted',
                        message: `The PDF file for ${resolvedKeyStr} is password-protected`,
                        pageCount: preflight.pageCount ?? null,
                        resolvedAttachment,
                    };
                case 'invalid_pdf':
                    return {
                        kind: 'cached_error',
                        code: 'invalid_pdf',
                        message: `The PDF file for ${resolvedKeyStr} is invalid or corrupted`,
                        pageCount: preflight.pageCount ?? null,
                        resolvedAttachment,
                    };
                case 'no_text_layer':
                    return {
                        kind: 'cached_error',
                        code: 'no_text_layer',
                        message: `The PDF file for ${resolvedKeyStr} requires OCR (no text layer)`,
                        pageCount: preflight.pageCount,
                        resolvedAttachment,
                    };
                case 'too_many_pages':
                    return {
                        kind: 'response_error',
                        code: 'too_many_pages',
                        message: `The PDF file for ${resolvedKeyStr} has ${preflight.pageCount} pages, which exceeds the ${preflight.maxPageCount}-page limit.`,
                        pageCount: preflight.pageCount,
                        resolvedAttachment,
                    };
            }
        }

        const maxSourceSizeBytes = maxFileSizeMB * 1024 * 1024;
        const cachedResult = cache
            ? await (
                args.serializedResult
                    ? cache.getSerializedResult(
                        { libraryId: cacheItemRef.libraryID, zoteroKey: cacheItemRef.key },
                        mode,
                        effectiveFilePath,
                        { maxSourceSizeBytes },
                    )
                    : cache.getResult(
                        { libraryId: cacheItemRef.libraryID, zoteroKey: cacheItemRef.key },
                        mode,
                        effectiveFilePath,
                        { maxSourceSizeBytes },
                    )
            ).catch(() => null)
            : null;
        throwIfTimedOut('payload_cache_lookup');
        if (cachedResult) {
            if (cachedResult.document.pageCount > maxPages) {
                return {
                    kind: 'response_error',
                    code: 'too_many_pages',
                    message: `The PDF file for ${resolvedKeyStr} has ${cachedResult.document.pageCount} pages, which exceeds the ${maxPages}-page limit.`,
                    pageCount: cachedResult.document.pageCount,
                    resolvedAttachment,
                };
            }
            return {
                kind: 'ok',
                cached: true,
                ...(args.serializedResult
                    ? { serializedResult: cachedResult as SerializedDocumentCacheResult }
                    : { result: cachedResult as BeaverExtractResult }),
                totalPages: cachedResult.document.pageCount,
                resolvedAttachment,
                contentType: zoteroItem?.attachmentContentType || cachedMeta?.contentType || args.contentType || 'application/pdf',
            };
        }

        let pdfData: Uint8Array | null = null;

        if (cachedMeta?.pageCount != null) {
            totalPages = cachedMeta.pageCount;
        }

        if (totalPages == null) {
            const loaded = await loadAttachmentData({
                item: zoteroItem,
                source: attachmentSource,
                maxFileSizeMB,
                onRemoteDownloadFailure: args.onRemoteDownloadFailure,
                signal,
                throwIfTimedOut,
            });
            if (loaded.kind === 'error') {
                if (aborted()) return aborted()!;
                if (loaded.code === 'file_too_large') {
                    return {
                        kind: 'response_error',
                        code: 'file_too_large',
                        message: `The PDF file for ${resolvedKeyStr} has a file size of ${(loaded.sizeMB ?? 0).toFixed(1)}MB, which exceeds the ${loaded.maxMB}MB limit.`,
                        pageCount: null,
                        resolvedAttachment,
                    };
                }
                if (loaded.code === 'read_failed') {
                    return {
                        kind: 'response_error',
                        code: 'extraction_failed',
                        message: `Failed to read PDF file for ${resolvedKeyStr}: ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`,
                        pageCount: null,
                        resolvedAttachment,
                    };
                }
                logger(`extractAndCacheDocument: Remote download failed: ${loaded.error}`, 1);
                return {
                    kind: 'response_error',
                    code: 'download_failed',
                    message: `Failed to download PDF for ${resolvedKeyStr} from remote storage: ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`,
                    pageCount: null,
                    resolvedAttachment,
                };
            }
            pdfData = loaded.data;
            throwIfTimedOut('pdf_data_load_for_page_count');
            loadedPdfData = pdfData;
            workerDispatched = true;
            totalPages = await client.getPageCount(pdfData, signal);
            throwIfTimedOut('page_count_extraction');
        }

        if (totalPages > maxPages) {
            return {
                kind: 'response_error',
                code: 'too_many_pages',
                message: `The PDF file for ${resolvedKeyStr} has ${totalPages} pages, which exceeds the ${maxPages}-page limit.`,
                pageCount: totalPages,
                resolvedAttachment,
            };
        }

        if (totalPages === 0) {
            return {
                kind: 'response_error',
                code: 'empty_document',
                message: `The PDF file for ${resolvedKeyStr} has no readable pages (it may be empty or corrupted)`,
                pageCount: 0,
                resolvedAttachment,
            };
        }

        if (!pdfData) {
            const loaded = await loadAttachmentData({
                item: zoteroItem,
                source: attachmentSource,
                maxFileSizeMB,
                onRemoteDownloadFailure: args.onRemoteDownloadFailure,
                signal,
                throwIfTimedOut,
            });
            if (loaded.kind === 'error') {
                if (aborted()) return aborted()!;
                if (loaded.code === 'file_too_large') {
                    return {
                        kind: 'response_error',
                        code: 'file_too_large',
                        message: `The PDF file for ${resolvedKeyStr} has a file size of ${(loaded.sizeMB ?? 0).toFixed(1)}MB, which exceeds the ${loaded.maxMB}MB limit.`,
                        pageCount: totalPages,
                        resolvedAttachment,
                    };
                }
                if (loaded.code === 'read_failed') {
                    return {
                        kind: 'response_error',
                        code: 'extraction_failed',
                        message: `Failed to read PDF file for ${resolvedKeyStr}: ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`,
                        pageCount: totalPages,
                        resolvedAttachment,
                    };
                }
                logger(`extractAndCacheDocument: Remote download failed: ${loaded.error}`, 1);
                return {
                    kind: 'response_error',
                    code: 'download_failed',
                    message: `Failed to download PDF for ${resolvedKeyStr} from remote storage: ${loaded.error instanceof Error ? loaded.error.message : String(loaded.error)}`,
                    pageCount: totalPages,
                    resolvedAttachment,
                };
            }
            pdfData = loaded.data;
            throwIfTimedOut('pdf_data_load');
            loadedPdfData = pdfData;
        }

        logger(
            `extractAndCacheDocument: full-document extract for ${requestKey} mode=${mode} worker=${workerName}`,
            3,
        );
        const pdfBytes = pdfData;
        if (!pdfBytes) {
            throw new Error('PDF data was not loaded before extraction');
        }
        const extractSettings = { checkTextLayer: true as const };
        const createSharedResult = async (extractSignal: AbortSignal) => {
            // Set only when this request's own extraction actually dispatches to the worker.
            // A timeout during cache pre-work (metadata/payload reads, decompression) or while
            // joined to another request's in-flight shared extraction must not attribute worker
            // state to this request; if a shared extraction wedges, the leader request's timeout
            // response carries the worker snapshot for that episode.
            workerDispatched = true;
            return args.serializedResult
                ? client.extractSerialized(pdfBytes, { mode, settings: extractSettings }, extractSignal)
                : client.extract(pdfBytes, { mode, settings: extractSettings }, extractSignal);
        };

        const createUnsharedResult = async () => {
            workerDispatched = true;
            const extracted = args.serializedResult
                ? serializedWorkerResultToCacheResult(
                    await client.extractSerialized(
                        pdfBytes,
                        { mode, settings: extractSettings },
                        signal,
                    ),
                )
                : await client.extract(
                    pdfBytes,
                    { mode, settings: extractSettings },
                    signal,
                );
            throwIfTimedOut('pdf_extract');
            return extracted;
        };

        const resultPromise = cache
            ? args.serializedResult
                ? cache.getOrCreateSerializedResult({
                    item: cacheItemRef,
                    filePath: effectiveFilePath,
                    mode,
                    sourceSizeBytes: isRemoteOnly ? pdfBytes.byteLength : 0,
                    contentType: zoteroItem?.attachmentContentType || args.contentType || 'application/pdf',
                    maxSourceSizeBytes,
                    lockScope: workerName,
                    sharedTimeoutMs,
                    abortSignal: signal,
                    expectedSourceIdentity: isRemoteOnly ? null : initialSourceIdentity,
                    create: createSharedResult as (extractSignal: AbortSignal) => ReturnType<typeof client.extractSerialized>,
                })
                : cache.getOrCreateResult({
                item: cacheItemRef,
                filePath: effectiveFilePath,
                mode,
                sourceSizeBytes: isRemoteOnly ? pdfBytes.byteLength : 0,
                contentType: zoteroItem?.attachmentContentType || args.contentType || 'application/pdf',
                maxSourceSizeBytes,
                lockScope: workerName,
                sharedTimeoutMs,
                abortSignal: signal,
                expectedSourceIdentity: isRemoteOnly ? null : initialSourceIdentity,
                create: createSharedResult as (extractSignal: AbortSignal) => Promise<BeaverExtractResult>,
                metadata: buildExtractedDocumentCacheMetadata,
            })
            : createUnsharedResult();
        const result = cache
            ? await awaitWithRequestAbort(resultPromise, signal, throwIfTimedOut, 'pdf_extract')
            : await resultPromise;
        throwIfTimedOut('document_result_ready');

        if (!result) {
            return {
                kind: 'response_error',
                code: 'file_too_large',
                message: `The PDF file for ${resolvedKeyStr} exceeds the ${maxFileSizeMB}MB limit.`,
                pageCount: totalPages,
                resolvedAttachment,
            };
        }

        if (result.mode !== mode) {
            return {
                kind: 'response_error',
                code: 'mode_mismatch',
                message: `Extractor returned ${result.mode} result for ${mode} request`,
                pageCount: result.document.pageCount,
                resolvedAttachment,
            };
        }

        return {
            kind: 'ok',
            cached: false,
            ...(args.serializedResult
                ? { serializedResult: result as SerializedDocumentCacheResult }
                : { result: result as BeaverExtractResult }),
            totalPages: result.document.pageCount,
            resolvedAttachment,
            contentType: zoteroItem?.attachmentContentType || args.contentType || 'application/pdf',
        };
    } catch (error) {
        if (error instanceof ExternalAbortError) {
            return {
                kind: 'external_abort',
                phase: error.phase,
                pageCount: totalPages,
                resolvedAttachment,
                workerDispatched,
            };
        }

        if (
            externalAbortSignal?.aborted
            && (error instanceof WorkerAbortError || signal.aborted)
        ) {
            return {
                kind: 'external_abort',
                phase: 'external_abort',
                pageCount: totalPages,
                resolvedAttachment,
                workerDispatched,
            };
        }

        if (
            signal.aborted
            || error instanceof WorkerAbortError
            || error instanceof TimeoutError
            || isWorkerDeadlineError(error)
        ) {
            logger(`extractAndCacheDocument[${workerName}]: Timed out after ${timeoutSeconds}s`, 1);
            return {
                kind: 'timeout',
                phase: error instanceof TimeoutError ? error.phase : 'unknown',
                timeoutSeconds,
                pageCount: totalPages,
                resolvedAttachment,
                leaseReaped: isWorkerDeadlineError(error),
                workerDispatched,
            };
        }

        logger(`extractAndCacheDocument[${workerName}]: Extraction failed: ${error}`, 1);
        const errorKey = resolvedAttachment
            ? `${resolvedAttachment.libraryId}-${resolvedAttachment.zoteroKey}`
            : requestKey;

        const extractionError = asExtractionError(error);
        if (extractionError) {
            if (
                resolvedCacheRef
                && resolvedFilePath
                && (extractionError.code === ExtractionErrorCode.ENCRYPTED
                    || extractionError.code === ExtractionErrorCode.INVALID_PDF
                    || extractionError.code === ExtractionErrorCode.NO_TEXT_LAYER)
            ) {
                const pageLabels = extractionError.code === ExtractionErrorCode.NO_TEXT_LAYER
                    ? extractionError.pageLabels ?? null
                    : null;
                await Zotero.Beaver?.documentCache?.putErrorMetadata({
                    item: resolvedCacheRef,
                    filePath: resolvedFilePath,
                    sourceSizeBytes: loadedPdfData?.byteLength ?? 0,
                    contentType: zoteroItem?.attachmentContentType || args.contentType || 'application/pdf',
                    errorCode: extractionError.code === ExtractionErrorCode.ENCRYPTED
                        ? 'encrypted'
                        : extractionError.code === ExtractionErrorCode.INVALID_PDF
                            ? 'invalid_pdf'
                            : 'no_text_layer',
                    pageCount: extractionError.pageCount ?? totalPages,
                    pageLabels,
                    pages: null,
                });

                const cachedCode = extractionError.code === ExtractionErrorCode.ENCRYPTED
                    ? 'encrypted'
                    : extractionError.code === ExtractionErrorCode.INVALID_PDF
                        ? 'invalid_pdf'
                        : 'no_text_layer';
                return {
                    kind: 'cached_error',
                    code: cachedCode,
                    message: cachedCode === 'encrypted'
                        ? `The PDF file for ${errorKey} is password-protected`
                        : cachedCode === 'invalid_pdf'
                            ? `The PDF file for ${errorKey} is invalid or corrupted`
                            : `The PDF file for ${errorKey} requires OCR (no text layer)`,
                    pageCount: extractionError.pageCount ?? totalPages,
                    resolvedAttachment,
                };
            }

            const totalPagesForError = extractionError.pageCount ?? totalPages;
            switch (extractionError.code) {
                case ExtractionErrorCode.ENCRYPTED:
                    return {
                        kind: 'response_error',
                        code: 'encrypted',
                        message: `The PDF file for ${errorKey} is password-protected`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.NO_TEXT_LAYER:
                    return {
                        kind: 'response_error',
                        code: 'no_text_layer',
                        message: `The PDF file for ${errorKey} requires OCR (no text layer)`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.INVALID_PDF:
                    return {
                        kind: 'response_error',
                        code: 'invalid_pdf',
                        message: `The PDF file for ${errorKey} is invalid or corrupted`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.EMPTY_DOCUMENT:
                    return {
                        kind: 'response_error',
                        code: 'empty_document',
                        message: `The PDF file for ${errorKey} has no readable pages (it may be empty or corrupted)`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.PAGE_OUT_OF_RANGE:
                    return {
                        kind: 'response_error',
                        code: 'page_out_of_range',
                        message: extractionError.message,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.WASM_ERROR:
                    return {
                        kind: 'response_error',
                        code: 'pdf_parser_crash',
                        message: `The PDF file for ${errorKey} crashes the PDF parser and cannot be processed`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                case ExtractionErrorCode.HEAP_EXHAUSTION:
                    return {
                        kind: 'response_error',
                        code: 'pdf_too_complex',
                        message: `The PDF file for ${errorKey} is too large or complex to process and exhausted the parser's memory`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
                default:
                    return {
                        kind: 'response_error',
                        code: 'extraction_failed',
                        message: `Failed to extract PDF content for ${errorKey}: ${extractionError.message}`,
                        pageCount: totalPagesForError,
                        resolvedAttachment,
                    };
            }
        }

        // Worker lifecycle failure: the local PDF engine could not start (module
        // load / configure handshake) or died mid-op and could not be respawned.
        // Narrowed to lifecycle errors so a cross-bundle heap-exhaustion
        // ExtractionError (handled above) is never misreported here.
        if (isWorkerLifecycleError(error)) {
            logger(
                `extractAndCacheDocument[${workerName}]: local PDF engine unavailable for ${errorKey}: ${error}`,
                1,
            );
            return {
                kind: 'response_error',
                code: 'worker_unavailable',
                message:
                    `Beaver's local PDF engine is temporarily unavailable on this computer, ` +
                    `so ${errorKey} could not be processed. This is not a problem with the document. ` +
                    `Retrying may succeed. Only retry once and if it keeps failing, ` +
                    `the user may need to restart Zotero.`,
                pageCount: totalPages,
                resolvedAttachment,
            };
        }

        // Unexpected/native JS error (not an ExtractionError)
        const native = error instanceof Error ? error : undefined;
        const rawMessage = native ? native.message : String(error);
        const responseDetail = [
            native ? `${native.name}: ${native.message}` : rawMessage,
            `(mode=${mode}, worker=${workerName}, pages=${totalPages ?? 'unknown'})`,
        ]
            .filter(Boolean)
            .join('\n');
        const diagnosticDetail = [
            responseDetail,
            native?.stack
                ? native.stack.split('\n').slice(0, 6).join('\n')
                : undefined,
        ]
            .filter(Boolean)
            .join('\n');
        logger(
            `extractAndCacheDocument[${workerName}]: Unexpected extraction failure for ${errorKey}\n${diagnosticDetail}`,
            1,
        );

        // Classify a JS stack overflow so it is greppable/alertable instead of
        // hiding in the generic `extraction_failed` bucket
        const isStackOverflow =
            /too much recursion|maximum call stack|call stack size exceeded/i.test(
                rawMessage,
            );

        return {
            kind: 'response_error',
            code: isStackOverflow ? 'recursion_limit' : 'extraction_failed',
            message: `Failed to extract PDF content for ${errorKey}: ${responseDetail}`,
            pageCount: totalPages,
            resolvedAttachment,
        };
    } finally {
        if (ownsTimeout) {
            dispose();
        }
    }
}

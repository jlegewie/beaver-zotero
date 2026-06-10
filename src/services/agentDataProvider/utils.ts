import { logger } from '../../utils/logger';
import { ZoteroItemReference } from '../../../react/types/zotero';
import { ZoteroItemStatus, FrontendFileStatus, AttachmentDataWithStatus, AttachmentInfo } from '../../../react/types/zotero';
import { safeIsInTrash, safeFileExists, isLinkedUrlAttachment } from '../../utils/zoteroUtils';
import { syncingItemFilter, syncingItemFilterAsync } from '../../utils/sync';
import { getPref } from '../../utils/prefs';

import { isAttachmentOnServer } from '../../utils/webAPI';
import { addPopupMessageAtom } from '../../../react/utils/popupMessageUtils';
import { wasItemAddedBeforeLastSync } from '../../../react/utils/sourceUtils';
import { DeferredToolPreference } from '../agentProtocol';
import { deferredToolPreferencesAtom } from '../../../react/atoms/deferredToolPreferences';
import { isAgentSupportedItem } from '../../utils/agentItemSupport';
import { store } from '../../../react/store';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';
import { serializeAttachment } from '../../utils/zoteroSerializers';
import { TimingAccumulator } from '../../utils/timing';
import { getAttachmentInfo as resolveAttachmentInfo, type AttachmentInfoOptions } from '../documentExtraction/attachmentInfo';
// Re-export shared document-extraction helpers so existing agent-data-provider
// callers keep importing them from `./utils`.
import {
    loadPdfData as loadPdfDataPrimitive,
    isRemoteAccessAvailable,
} from '../documentExtraction';
export {
    isRemoteAccessAvailable,
    validateZoteroItemReference,
    checkRemotePdfSize,
    preflightCachedPdfMeta,
    resolveToPdfAttachment,
} from '../documentExtraction';
export type {
    PreflightErrorCode,
    PreflightFailure,
    PreflightOptions,
    PdfAttachmentResolveResult,
} from '../documentExtraction';

// ---------------------------------------------------------------------------
// Remote download failure notification (rate-limited to once per 8 hours)
// ---------------------------------------------------------------------------

const REMOTE_FAILURE_NOTIFY_INTERVAL_MS = 8 * 60 * 60 * 1000;
const REMOTE_NOT_SYNCED_NOTIFY_INTERVAL_MS = 8 * 60 * 60 * 1000;
let _remoteDownloadFailureLastNotifiedAt = 0;
let _remoteNotSyncedLastNotifiedAt = 0;

const DISABLE_HINT = 'You can disable Beaver\'s remote file access in Settings \u203A Permissions.';

/**
 * Classify a download error into a user-facing title/text pair.
 * Error messages originate from handleDownloadError() in utils/webAPI.ts —
 * we match on distinctive substrings to surface a specific cause when we
 * recognize it, and fall back to the generic message otherwise.
 */
function describeRemoteDownloadFailure(error: unknown): { title: string; text: string } {
    const message = error instanceof Error ? error.message : String(error ?? '');

    if (/Authentication failed for WebDAV/i.test(message)) {
        return {
            title: 'WebDAV Authentication Failed',
            text: "Beaver couldn't authenticate with your WebDAV server. "
                + 'Check your WebDAV username and password in Zotero \u203A Settings \u203A Sync. '
                + DISABLE_HINT,
        };
    }

    if (/Access forbidden.*Zotero API key/i.test(message)) {
        return {
            title: 'Zotero Access Denied',
            text: "Beaver couldn't access your file on the Zotero server. "
                + 'Ensure that your Zotero sync settings are configured correctly. '
                + DISABLE_HINT,
        };
    }

    if (/File not found on WebDAV server|File not found on server/i.test(message)) {
        return {
            title: 'Remote File Not Found',
            text: "The file isn't available on your remote storage yet. "
                + 'Make sure Zotero has finished syncing, or sync the file locally. '
                + DISABLE_HINT,
        };
    }

    if (/Rate limited by/i.test(message)) {
        return {
            title: 'Remote Storage Rate Limited',
            text: 'Your remote storage is temporarily rate-limiting requests so that Beaver can\'t access the file. '
                + DISABLE_HINT,
        };
    }

    if (/server error/i.test(message)) {
        return {
            title: 'Remote Storage Server Error',
            text: 'The remote storage server returned an error. This is usually temporary \u2014 try again shortly. '
                + DISABLE_HINT,
        };
    }

    if (/Download timeout|TimeoutException/i.test(message)) {
        return {
            title: 'Remote File Download Timed Out',
            text: 'The download took too long to complete. Check your network connection or sync the file locally for faster access. '
                + DISABLE_HINT,
        };
    }

    if (/is offline/i.test(message)) {
        return {
            title: 'Zotero Is Offline',
            text: 'Zotero is currently offline, so remote files can\u2019t be downloaded. Reconnect and try again.',
        };
    }

    if (/Network error/i.test(message)) {
        return {
            title: 'Network Error',
            text: "Beaver couldn't reach your remote storage. Check your internet connection and try again. "
                + DISABLE_HINT,
        };
    }

    return {
        title: 'Remote File Download Failed',
        text: "Couldn't download a remotely stored attachment. This is usually a network or server issue. For faster, more reliable access, sync the file locally in Zotero. "
            + DISABLE_HINT,
    };
}

export function notifyRemoteDownloadFailure(error: unknown): void {
    const now = Date.now();
    if (now - _remoteDownloadFailureLastNotifiedAt < REMOTE_FAILURE_NOTIFY_INTERVAL_MS) return;
    _remoteDownloadFailureLastNotifiedAt = now;

    const { title, text } = describeRemoteDownloadFailure(error);

    try {
        store.set(addPopupMessageAtom, {
            id: 'remote-download-failed',
            type: 'warning',
            title,
            text,
            expire: false,
        });
    } catch (error) {
        logger(`notifyRemoteDownloadFailure: failed to surface popup: ${error}`, 2);
    }
}

export function notifyRemoteFileNotSynced(): void {
    const now = Date.now();
    if (now - _remoteNotSyncedLastNotifiedAt < REMOTE_NOT_SYNCED_NOTIFY_INTERVAL_MS) return;
    _remoteNotSyncedLastNotifiedAt = now;

    try {
        store.set(addPopupMessageAtom, {
            id: 'remote-file-not-synced',
            type: 'warning',
            title: 'File Not Synced Locally',
            text: 'This file is available remotely, but Beaver can only read it after Zotero syncs it locally. Sync the file in Zotero and try again. '
                + DISABLE_HINT,
            expire: false,
        });
    } catch (error) {
        logger(`notifyRemoteFileNotSynced: failed to surface popup: ${error}`, 2);
    }
}

// ---------------------------------------------------------------------------
// loadPdfData — wrapper around the react-free primitive
// ---------------------------------------------------------------------------

/**
 * Load PDF data from local disk or remote server. Thin webpack-side wrapper
 * that injects `notifyRemoteDownloadFailure` so the user sees the
 * remote-download-failed popup. The primitive (used by the background
 * extractor) takes no callback — background failures surface through
 * `__beaverEventBus`'s `background-job:failed` event instead.
 *
 * @throws On download failure (callers should catch and produce their own
 *   error response).
 */
export async function loadPdfData(
    item: Zotero.Item,
    filePath: string,
    isRemoteOnly: boolean,
): Promise<Uint8Array> {
    return loadPdfDataPrimitive(item, filePath, isRemoteOnly, notifyRemoteDownloadFailure);
}

// `preflightCachedPdfMeta`, `PreflightOptions`, `PreflightFailure`, and
// `PreflightErrorCode` live in `../documentExtraction` and are re-exported
// at the top of this file.

/**
 * Project a unified `AttachmentInfo` (documentExtraction/attachmentInfo.ts)
 * onto the `FrontendFileStatus` wire shape used by the zotero_data lookup
 * protocol. Pure field projection — status values, codes, and reasons cross
 * the wire exactly as the resolver produced them; the backend normalizes
 * legacy payloads from older frontends via before-validators.
 */
function attachmentInfoToFileStatus(
    info: AttachmentInfo,
    mimeType: string | null,
): FrontendFileStatus {
    return {
        is_primary: info.is_primary,
        mime_type: mimeType,
        content_kind: info.content_kind,
        page_count: info.page_count ?? null,
        line_count: info.line_count ?? null,
        status: info.status,
        status_code: (info.status_code as FrontendFileStatus['status_code']) ?? null,
        status_reason: info.status_reason ?? null,
    };
}

/**
 * Get file status information for an attachment.
 *
 * Delegates to the unified attachment resolver with full PDF analysis
 * (cache-first; on a miss reads the file, validates it, runs OCR detection,
 * and persists metadata). EPUBs and the remaining content kinds follow the
 * resolver's readability rules.
 */
export async function getAttachmentFileStatus(attachment: Zotero.Item, isPrimary: boolean): Promise<FrontendFileStatus> {
    const info = await resolveAttachmentInfo(attachment, {
        isPrimary,
        pdfAnalysis: 'full',
    });
    return attachmentInfoToFileStatus(info, attachment.attachmentContentType || null);
}

/**
 * Lightweight file status check for search/lookup results.
 *
 * Delegates to the unified attachment resolver with lightweight PDF analysis:
 * cache-first, then cheap page-count probes (fulltext index, optionally the
 * PDF worker) — never a full file read.
 */
export async function getAttachmentFileStatusLightweight(
    attachment: Zotero.Item,
    isPrimary: boolean,
    options?: { skipWorkerFallback?: boolean }
): Promise<FrontendFileStatus> {
    const info = await resolveAttachmentInfo(attachment, {
        isPrimary,
        pdfAnalysis: 'lightweight',
        skipWorkerFallback: options?.skipWorkerFallback,
    });
    return attachmentInfoToFileStatus(info, attachment.attachmentContentType || null);
}

/**
 * Pre-fetch sync dates for a set of libraries.
 * Returns a Map from libraryId to the last sync date SQL string (or null if no sync log).
 * This avoids redundant DB queries when computing status for many items from the same libraries.
 *
 * @param libraryIds - Library IDs to pre-fetch sync dates for
 * @param syncWithZotero - Sync settings from profile
 * @param userId - Current user ID
 * @returns Map from libraryId to lastSyncDateSQL (null means no sync log found)
 */
export async function prefetchSyncDates(
    libraryIds: number[],
    syncWithZotero: any,
    userId: string | null
): Promise<Map<number, string | null>> {
    const cache = new Map<number, string | null>();
    if (!userId) return cache;

    const uniqueLibraryIds = [...new Set(libraryIds)];

    await Promise.all(uniqueLibraryIds.map(async (libraryId) => {
        try {
            const syncLog = syncWithZotero
                ? await Zotero.Beaver.db.getSyncLogWithHighestVersion(userId, libraryId)
                : await Zotero.Beaver.db.getSyncLogWithMostRecentDate(userId, libraryId);

            if (!syncLog) {
                cache.set(libraryId, null);
            } else {
                const lastSyncDate = syncLog.library_date_modified;
                const lastSyncDateSQL = Zotero.Date.isISODate(lastSyncDate)
                    ? Zotero.Date.isoToSQL(lastSyncDate)
                    : lastSyncDate;
                cache.set(libraryId, lastSyncDateSQL);
            }
        } catch (e) {
            // Don't cache errors — let computeItemStatus fall back to per-item query,
            // which will also fail and correctly set isPendingSync = null (unknown).
        }
    }));

    return cache;
}

/**
 * Compute sync status information for a Zotero item.
 * Determines why an item might not be available in the backend.
 *
 * @param item - Zotero item to compute status for
 * @param syncedLibraryIds - List of library IDs configured for sync
 * @param syncWithZotero - Sync settings from profile
 * @param userId - Current user ID (for pending sync detection)
 * @param options.syncDateCache - Pre-fetched sync dates from prefetchSyncDates() to avoid per-item DB queries
 * @returns Status information for the item
 */
export async function computeItemStatus(
    item: Zotero.Item,
    syncedLibraryIds: number[],
    syncWithZotero: any,
    userId: string | null,
    options?: { syncDateCache?: Map<number, string | null> }
): Promise<ZoteroItemStatus> {
    const isSyncedLibrary = syncedLibraryIds.includes(item.libraryID);
    const trashState = safeIsInTrash(item);
    const isInTrash = trashState === true;

    // Determine if item is available locally or on server
    // For attachments: check file exists (but skip for linked URLs which have no file)
    let availableLocallyOrOnServer = true;
    let passesSyncFilters = true;

    if (item.isAttachment()) {
        if (isLinkedUrlAttachment(item)) {
            // Linked URLs are web links with no file - they don't pass sync filters
            // Skip safeFileExists() and syncingItemFilterAsync() which are not applicable
            availableLocallyOrOnServer = true;
            passesSyncFilters = false;
        } else {
            // For file attachments, check if file exists locally or on server.
            // Beaver can access the file when it's local, has a synced hash, or
            // is downloadable via the remote-file-access path (on-demand items
            // in TO_DOWNLOAD/FORCE_DOWNLOAD state, gated by the pref).
            const isLocal = await safeFileExists(item);
            const onServerWithHash = isAttachmentOnServer(item);
            availableLocallyOrOnServer = isLocal || onServerWithHash || isRemoteAccessAvailable(item);
            passesSyncFilters =
                (isLocal || onServerWithHash) && (await syncingItemFilterAsync(item));
        }
    } else {
        // Regular items - check sync filters normally
        passesSyncFilters = await syncingItemFilterAsync(item);
    }

    // Compute is_pending_sync only if we have a userId
    let isPendingSync: boolean | null = null;
    if (userId) {
        try {
            const syncDateCache = options?.syncDateCache;
            if (syncDateCache && syncDateCache.has(item.libraryID)) {
                const lastSyncDateSQL = syncDateCache.get(item.libraryID)!;
                if (lastSyncDateSQL === null) {
                    // No sync log found for this library
                    isPendingSync = true;
                } else {
                    isPendingSync = !(item.dateAdded <= lastSyncDateSQL);
                }
            } else {
                // No cache or library not in cache — fall back to per-item query
                const wasAddedBeforeSync = await wasItemAddedBeforeLastSync(item, syncWithZotero, userId);
                isPendingSync = !wasAddedBeforeSync;
            }
        } catch (e) {
            // Unable to determine pending status
            isPendingSync = null;
        }
    }

    return {
        is_synced_library: isSyncedLibrary,
        is_in_trash: isInTrash,
        available_locally_or_on_server: availableLocallyOrOnServer,
        passes_sync_filters: passesSyncFilters,
        is_pending_sync: isPendingSync
    };
}

/**
 * Context for processing attachments (sync configuration)
 */
export interface AttachmentProcessingContext {
    searchableLibraryIds: number[];
    syncWithZotero: any;
    userId: string | null;
}

/**
 * Batch-fetch the "best attachment" for multiple parent items in a single SQL query.
 * Replicates Zotero's `getBestAttachment()` ranking:
 *   1. PDF content type preferred
 *   2. URL matches parent's URL preferred
 *   3. Earliest dateAdded wins ties
 *
 * Uses `ROW_NUMBER() OVER (PARTITION BY ...)` to pick the best attachment per parent
 * in one pass instead of N individual queries.
 *
 * @param parentItemIds - IDs of regular (parent) items
 * @returns Map from parentItemID to bestAttachmentItemID
 */
export async function getBestAttachmentBatch(
    parentItemIds: number[]
): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (parentItemIds.length === 0) return result;

    const CHUNK_SIZE = 500;
    for (let i = 0; i < parentItemIds.length; i += CHUNK_SIZE) {
        const chunk = parentItemIds.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(',');

        const sql = `
            WITH ranked AS (
                SELECT
                    IA.parentItemID,
                    IA.itemID AS attachmentItemID,
                    ROW_NUMBER() OVER (
                        PARTITION BY IA.parentItemID
                        ORDER BY
                            CASE WHEN IA.contentType = 'application/pdf' THEN 0 ELSE 1 END,
                            CASE WHEN COALESCE(IDV_att.value, '') = COALESCE(IDV_parent.value, '') THEN 0 ELSE 1 END,
                            I.dateAdded ASC
                    ) AS rn
                FROM itemAttachments IA
                JOIN items I ON I.itemID = IA.itemID
                LEFT JOIN deletedItems DI ON DI.itemID = IA.itemID
                LEFT JOIN itemData ID_att ON ID_att.itemID = IA.itemID
                    AND ID_att.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'url')
                LEFT JOIN itemDataValues IDV_att ON IDV_att.valueID = ID_att.valueID
                LEFT JOIN itemData ID_parent ON ID_parent.itemID = IA.parentItemID
                    AND ID_parent.fieldID = (SELECT fieldID FROM fields WHERE fieldName = 'url')
                LEFT JOIN itemDataValues IDV_parent ON IDV_parent.valueID = ID_parent.valueID
                WHERE IA.parentItemID IN (${placeholders})
                  AND DI.itemID IS NULL
                  AND IA.linkMode != ${Zotero.Attachments.LINK_MODE_LINKED_URL}
            )
            SELECT parentItemID, attachmentItemID
            FROM ranked
            WHERE rn = 1
        `;

        const rows: { parentItemID: number; attachmentItemID: number }[] = [];
        await Zotero.DB.queryAsync(sql, chunk, {
            onRow: (row: any) => {
                rows.push({
                    parentItemID: row.getResultByIndex(0),
                    attachmentItemID: row.getResultByIndex(1),
                });
            },
        });

        for (const row of rows) {
            result.set(row.parentItemID, row.attachmentItemID);
        }
    }

    return result;
}

export interface AttachmentInfoBatchData {
    bestAttachmentMap: Map<number, number>;
}

/**
 * Prepare batch data needed for AttachmentInfo resolution.
 */
export async function prepareAttachmentInfoBatchData(
    parentItems: Zotero.Item[],
    timing?: TimingAccumulator,
): Promise<AttachmentInfoBatchData> {
    const parentItemIds = parentItems.map(item => item.id);
    const fn = () => getBestAttachmentBatch(parentItemIds);
    const bestAttachmentMap = timing
        ? await timing.track('batch_prefetch_ms', fn)
        : await fn();
    return { bestAttachmentMap };
}

/**
 * Resolve one attachment to the unified AttachmentInfo shape.
 */
export async function getAttachmentInfoForItem(
    item: Zotero.Item,
    options?: AttachmentInfoOptions,
): Promise<AttachmentInfo> {
    return resolveAttachmentInfo(item, {
        ...options,
        nonPdfReadableEnabled: options?.nonPdfReadableEnabled ?? false,
    });
}

/**
 * Process a regular item's child attachments into AttachmentInfo results.
 */
export async function processAttachmentInfoBatch(
    item: Zotero.Item,
    batchData: AttachmentInfoBatchData,
    options?: {
        skipWorkerFallback?: boolean;
        timing?: TimingAccumulator;
        includeAnnotationsCount?: boolean;
    },
): Promise<AttachmentInfo[]> {
    const ta = options?.timing;
    const attachmentIds = item.getAttachments();
    if (attachmentIds.length === 0) {
        return [];
    }

    const fetchFn = () => Zotero.Items.getAsync(attachmentIds);
    const attachmentItems = ta
        ? await ta.track('att_fetch_ms', fetchFn)
        : await fetchFn();

    const loadFn = () => Zotero.Items.loadDataTypes(
        attachmentItems,
        ["primaryData", "itemData", "tags", "collections", "relations", "childItems"],
    );
    await (ta ? ta.track('att_load_data_ms', loadFn) : loadFn());

    const bestAttachmentId = batchData.bestAttachmentMap.get(item.id);
    const parentItemId = `${item.libraryID}-${item.key}`;
    const attachmentPromises = attachmentItems.map(async (attachment): Promise<AttachmentInfo | null> => {
        if (!attachment || attachment.deleted || safeIsInTrash(attachment)) {
            return null;
        }
        const isPrimary = bestAttachmentId !== undefined && attachment.id === bestAttachmentId;
        const infoFn = () => getAttachmentInfoForItem(attachment, {
            parentItemId,
            isPrimary,
            includeAnnotationsCount: options?.includeAnnotationsCount,
            skipWorkerFallback: options?.skipWorkerFallback,
            timing: ta,
        });
        return ta ? ta.track('att_file_status_ms', infoFn) : infoFn();
    });

    const results = await Promise.all(attachmentPromises);
    return results.filter((result): result is AttachmentInfo => result !== null);
}

/**
 * Process attachments for an item in parallel.
 * Fetches, validates, and serializes all attachments concurrently.
 * 
 * Uses lightweight file status check (no full PDF read, no OCR analysis)
 * to avoid timeouts when processing many attachments.
 * 
 * @param item - Parent Zotero item
 * @param context - Sync configuration context
 * @param options.skipHash - If true, skip SHA-256 hash computation (for search/lookup paths)
 * @returns Array of processed attachments with status
 */
export async function processAttachmentsParallel(
    item: Zotero.Item,
    context: AttachmentProcessingContext,
    options?: {
        skipHash?: boolean;
        timing?: TimingAccumulator;
        includeAnnotationsCount?: boolean;
    }
): Promise<AttachmentDataWithStatus[]> {
    const skipHash = options?.skipHash ?? false;
    const includeAnnotationsCount = options?.includeAnnotationsCount ?? false;
    const ta = options?.timing;
    const attachmentIds = item.getAttachments();
    if (attachmentIds.length === 0) {
        return [];
    }

    // Fetch attachment items, primary attachment, and sync dates in parallel
    const fetchFn = () => Promise.all([
        Zotero.Items.getAsync(attachmentIds),
        item.getBestAttachment(),
        prefetchSyncDates([item.libraryID], context.syncWithZotero, context.userId)
    ]);
    const [attachmentItems, primaryAttachment, syncDateCache] = ta
        ? await ta.track('att_fetch_ms', fetchFn)
        : await fetchFn();

    // Load data types for all attachments
    const loadFn = () => Zotero.Items.loadDataTypes(attachmentItems, ["primaryData", "itemData", "tags", "collections", "relations", "childItems"]);
    await (ta ? ta.track('att_load_data_ms', loadFn) : loadFn());

    // Process all attachments in parallel
    const attachmentPromises = attachmentItems.map(async (attachment): Promise<AttachmentDataWithStatus | null> => {
        // Validate attachment
        const isValidAttachment = syncingItemFilter(attachment);
        if (!isValidAttachment) {
            return null;
        }

        // Serialize attachment (skip file hash — not needed for search results)
        const serializeFn = () => serializeAttachment(attachment, undefined, {
            skipFileHash: true,
            skipSyncingFilter: true,
            skipHash,
            includeAnnotationsCount,
        });
        const attachmentData = ta
            ? await ta.track('att_serialize_ms', serializeFn)
            : await serializeFn();
        if (!attachmentData) {
            return null;
        }

        const isPrimary = primaryAttachment && attachment.id === primaryAttachment.id;
        const fileStatusFn = () => getAttachmentFileStatusLightweight(attachment, isPrimary);
        const fileStatus = ta
            ? await ta.track('att_file_status_ms', fileStatusFn)
            : await fileStatusFn();

        const statusFn = () => computeItemStatus(attachment, context.searchableLibraryIds, context.syncWithZotero, context.userId, { syncDateCache });
        const status = ta
            ? await ta.track('att_status_ms', statusFn)
            : await statusFn();

        return {
            attachment: attachmentData,
            status,
            file_status: fileStatus,
        };
    });

    const results = await Promise.all(attachmentPromises);

    // Filter out null results (invalid attachments)
    return results.filter((result): result is AttachmentDataWithStatus => result !== null);
}

/**
 * Get library by ID or name, with proper validation.
 * 
 * Supports:
 * - Number: Looks up by library ID
 * - String: First tries to parse as ID, then looks up by name
 * - null/undefined: Returns user's default library
 * 
 * IMPORTANT: Does NOT fall back to user library when an explicit library is requested
 * but not found. Returns null in that case so callers can return proper error responses.
 */
export function getLibraryByIdOrName(libraryIdOrName: number | string | null | undefined): LibraryLookupResult {
    if (libraryIdOrName == null) {
        // Default to user's library - no explicit request
        return {
            library: Zotero.Libraries.userLibrary,
            wasExplicitlyRequested: false,
            searchInput: null,
        };
    }
    
    // If it's a number, look up by ID
    if (typeof libraryIdOrName === 'number') {
        const lib = Zotero.Libraries.get(libraryIdOrName);
        return {
            library: lib || null,
            wasExplicitlyRequested: true,
            searchInput: String(libraryIdOrName),
        };
    }
    
    // It's a string - try to parse as ID first
    const parsedId = parseInt(libraryIdOrName, 10);
    if (!isNaN(parsedId)) {
        const lib = Zotero.Libraries.get(parsedId);
        if (lib) {
            return {
                library: lib,
                wasExplicitlyRequested: true,
                searchInput: libraryIdOrName,
            };
        }
    }
    
    // Look up by name (case-insensitive)
    const allLibraries = Zotero.Libraries.getAll();
    const searchLower = libraryIdOrName.toLowerCase();
    const libByName = allLibraries.find((l: any) => l.name.toLowerCase() === searchLower);
    
    return {
        library: libByName || null,
        wasExplicitlyRequested: true,
        searchInput: libraryIdOrName,
    };
}

/**
 * Result of collection lookup, including the library where the collection was found.
 */
export interface CollectionLookupResult {
    collection: Zotero.Collection;
    libraryID: number;
}

/**
 * Get collection by ID, key, or name.
 *
 * Supports:
 * - Number: Looks up by collection ID
 * - String: Checks for a key (8 alphanumeric chars), then "<libraryID>-<key>" compound format
 *   (e.g. "1-ABCD1234"), then numeric ID (digits only), then searches by name
 * - null/undefined: Returns null
 *
 * The "<libraryID>-<key>" format is resolved only in the embedded library, ignoring the
 * libraryId parameter.
 *
 * When libraryId is provided, does a full lookup (key + name) in that library first.
 * Cross-library fallback only applies when the input looks like a Zotero key (8 alphanumeric
 * chars). Name-based lookups stay scoped to the requested
 * library to avoid returning a same-named collection from the wrong library.
 *
 * @param collectionIdOrName - Collection ID, key, or name
 * @param libraryId - Optional library ID to search first (falls back to other libraries)
 * @returns Collection and its library ID, or null if not found
 */
export function getCollectionByIdOrName(
    collectionIdOrName: number | string | null | undefined,
    libraryId?: number
): CollectionLookupResult | null {
    if (collectionIdOrName == null) {
        return null;
    }
    
    // If it's a number, look up by ID
    if (typeof collectionIdOrName === 'number') {
        const collection = Zotero.Collections.get(collectionIdOrName);
        return collection ? { collection, libraryID: collection.libraryID } : null;
    }

    // Try "<libraryID>-<key>" compound format (e.g. "1-ABCD1234")
    const compoundMatch = collectionIdOrName.match(/^(\d+)-(.+)$/);
    if (compoundMatch) {
        const compoundLibId = parseInt(compoundMatch[1], 10);
        const compoundKey = compoundMatch[2];
        if (Zotero.Utilities.isValidObjectKey(compoundKey)) {
            const collection = Zotero.Collections.getByLibraryAndKey(compoundLibId, compoundKey);
            if (collection) return { collection, libraryID: collection.libraryID };
        }
    }

    const isKeyLike = Zotero.Utilities.isValidObjectKey(collectionIdOrName);
    const hasLibraryId = libraryId !== undefined && Number.isFinite(libraryId);

    // If libraryId provided, do full lookup (key + name) there first
    if (hasLibraryId) {
        const found = findCollectionInLibrary(collectionIdOrName, libraryId, isKeyLike);
        if (found) return found;
    }

    // Try numeric collection ID
    if (/^\d+$/.test(collectionIdOrName)) {
        const parsedId = parseInt(collectionIdOrName, 10);
        const collection = Zotero.Collections.get(parsedId);
        if (collection) return { collection, libraryID: collection.libraryID };
    }
    
    // Cross-library fallback: only for key-like inputs.
    // Name-based lookups stay scoped to the requested library since names like
    // "Inbox" are commonly duplicated across libraries.
    if (!isKeyLike && hasLibraryId) {
        return null;
    }

    const searchableIds = getSearchableLibraryIds();
    const otherLibraryIds = Zotero.Libraries.getAll()
        .map((lib: any) => lib.libraryID as number)
        .filter((id: number) => !hasLibraryId || id !== libraryId);
    const sortedLibraryIds = [
        ...otherLibraryIds.filter(id => searchableIds.includes(id)),
        ...otherLibraryIds.filter(id => !searchableIds.includes(id)),
    ];

    for (const libId of sortedLibraryIds) {
        const found = findCollectionInLibrary(collectionIdOrName, libId, isKeyLike);
        if (found) return found;
    }
    
    return null;
}

/**
 * Try to find a collection in a single library by key, then by name.
 */
function findCollectionInLibrary(
    input: string,
    libraryId: number,
    isKeyLike: boolean
): CollectionLookupResult | null {
    if (isKeyLike) {
        const collection = Zotero.Collections.getByLibraryAndKey(libraryId, input);
        if (collection) return { collection, libraryID: collection.libraryID };
    }
    
    const collections = Zotero.Collections.getByLibrary(libraryId, true);
    const inputLower = input.toLowerCase();
    const byName = collections.find(
        (c: Zotero.Collection) => c.name.toLowerCase() === inputLower
    );
    if (byName) return { collection: byName, libraryID: byName.libraryID };
    
    return null;
}

/**
 * Format creators array into a string for display.
 */
export function formatCreatorsString(creators: any[] | undefined): string | null {
    if (!creators || creators.length === 0) return null;
    
    const names = creators.map(c => {
        if (c.lastName && c.firstName) {
            return c.lastName;
        } else if (c.lastName) {
            return c.lastName;
        } else if (c.name) {
            return c.name;
        }
        return null;
    }).filter(Boolean);
    
    if (names.length === 0) return null;
    if (names.length === 1) return names[0] as string;
    if (names.length === 2) return `${names[0]} & ${names[1]}`;
    return `${names[0]} et al.`;
}

/**
 * Extract year from a date string.
 */
export function extractYear(dateStr: string | undefined): number | null {
    if (!dateStr) return null;
    const match = dateStr.match(/(\d{4})/);
    return match ? parseInt(match[1], 10) : null;
}

/**
 * Brief library info for error responses.
 */
export interface AvailableLibraryInfo {
    library_id: number;
    name: string;
}

/**
 * Get searchable library IDs from the store.
 * Pro users: synced libraries only. Free users: all local libraries.
 */
export function getSearchableLibraryIds(): number[] {
    return store.get(searchableLibraryIdsAtom);
}

/**
 * Check if a library ID is searchable.
 */
export function isLibrarySearchable(libraryId: number): boolean {
    return getSearchableLibraryIds().includes(libraryId);
}

/**
 * Get a list of searchable libraries for error responses.
 * Only returns libraries that are in searchableLibraryIdsAtom.
 */
export function getSearchableLibraries(): AvailableLibraryInfo[] {
    const searchableIds = getSearchableLibraryIds();
    return Zotero.Libraries.getAll()
        .filter((lib: any) => searchableIds.includes(lib.libraryID))
        .map((lib: any) => ({
            library_id: lib.libraryID,
            name: lib.name,
        }));
}

/**
 * Get a list of available libraries for error responses.
 * @deprecated Use getSearchableLibraries() for agent handlers to enforce library restrictions.
 */
export function getAvailableLibraries(): AvailableLibraryInfo[] {
    return Zotero.Libraries.getAll().map((lib: any) => ({
        library_id: lib.libraryID,
        name: lib.name,
    }));
}

/**
 * Result of library lookup with validation information.
 */
export interface LibraryLookupResult {
    /** The found library, or null if not found */
    library: _ZoteroTypes.Library.LibraryLike | null;
    /** Whether a library was explicitly requested (vs defaulting to user library) */
    wasExplicitlyRequested: boolean;
    /** The input that was used to search (for error messages) */
    searchInput: string | null;
}

/**
 * Error codes for library validation failures.
 */
export type LibraryValidationErrorCode = 'library_not_found' | 'library_not_searchable';

/**
 * Result of library validation with searchability check.
 */
export interface LibraryValidationResult {
    /** Whether the library is valid and searchable */
    valid: boolean;
    /** The validated library (only set if valid) */
    library?: _ZoteroTypes.Library.LibraryLike;
    /** Error message (only set if invalid) */
    error?: string;
    /** Error code (only set if invalid) */
    error_code?: LibraryValidationErrorCode;
    /** List of searchable libraries for error response (only set if invalid) */
    available_libraries?: AvailableLibraryInfo[];
}

/**
 * Validate library access for agent handlers.
 * Checks both that the library exists AND that it's in searchableLibraryIdsAtom.
 * 
 * @param libraryIdOrName - Library ID or name (null/undefined defaults to user library)
 * @returns Validation result with library or error details
 */
export function validateLibraryAccess(libraryIdOrName: number | string | null | undefined): LibraryValidationResult {
    const lookupResult = getLibraryByIdOrName(libraryIdOrName);
    
    // Check if library was found
    if (lookupResult.wasExplicitlyRequested && !lookupResult.library) {
        return {
            valid: false,
            error: `Library not found: "${lookupResult.searchInput}"`,
            error_code: 'library_not_found',
            available_libraries: getSearchableLibraries(),
        };
    }
    
    const library = lookupResult.library!;
    
    // Check if library is searchable
    if (!isLibrarySearchable(library.libraryID)) {
        return {
            valid: false,
            error: `Library '${library.name}' (ID: ${library.libraryID}) is not synced with Beaver. Access is limited to synced libraries.`,
            error_code: 'library_not_searchable',
            available_libraries: getSearchableLibraries(),
        };
    }
    
    return {
        valid: true,
        library,
    };
}

/**
 * Get the user's preference for a deferred tool.
 * Reads from Zotero prefs with a two-level structure:
 * - toolToGroup: Maps tool names to group names
 * - groupPreferences: Maps group names to preference values
 *
 * Merges stored prefs with the defaults from deferredToolPreferences.ts
 * so that newly added tools (e.g. create_note) use their configured
 * default even before the user saves any preference change.
 */
export function getDeferredToolPreference(toolName: string): DeferredToolPreference {
    try {
        const data = store.get(deferredToolPreferencesAtom);
        const group = data.toolToGroup[toolName] ?? toolName;
        const preference = data.groupPreferences[group];
        if (preference === 'always_ask' || preference === 'always_apply' || preference === 'continue_without_applying') {
            return preference;
        }
    } catch (error) {
        logger(`getDeferredToolPreference: Failed to read preference for ${toolName}: ${error}`, 1);
    }
    return 'always_ask';
}


/**
 * Extract detailed error information for logging.
 * Returns an object with message and optional details (including stack trace).
 * 
 * @param error - The caught error
 * @returns Object with `message` (string) and `details` (string with stack trace, or null)
 */
export function extractErrorDetails(error: unknown): { message: string; details: string | null } {
    if (error instanceof Error) {
        const message = error.message || String(error);
        const details = error.stack ? `${error.message}\n${error.stack}` : null;
        return { message, details };
    }
    return { message: String(error), details: null };
}

// `PdfAttachmentResolveResult` and `resolveToPdfAttachment` live in
// `../documentExtraction` and are re-exported at the top of this file.
// `getAttachmentInfo` stays here because other webpack-side callers depend
// on its richer (text-with-filename) shape.

export async function getAttachmentInfo(item: Zotero.Item): Promise<{ count: number, text: string, bestAttachmentKey: string | null }> {
    if (!item.isRegularItem()) {
        return {
            count: 0,
            text: '',
            bestAttachmentKey: null,
        };
    }

    await Zotero.Items.loadDataTypes([item], ["childItems"]);
    const attachmentIDs = item.getAttachments();
    const bestAttachment = await item.getBestAttachment();
    const bestAttachmentKey = bestAttachment ? `${bestAttachment.libraryID}-${bestAttachment.key}` : null;

    const supportedAttachmentKeys = attachmentIDs
        .map(id => Zotero.Items.get(id))
        .filter(attachment => attachment && isAgentSupportedItem(attachment))
        .map(attachment => {
            const key = `${attachment.libraryID}-${attachment.key}`;
            const isPrimary = bestAttachmentKey && key === bestAttachmentKey;
            // return isPrimary ? `${key} (primary)` : key;
            return isPrimary
                ? `'${attachment.attachmentFilename}' (${key}, primary)`
                : `'${attachment.attachmentFilename}' (${key})`;
        });

    return {
        count: supportedAttachmentKeys.length,
        text: supportedAttachmentKeys.join(', '),
        bestAttachmentKey: bestAttachmentKey,
    }
}

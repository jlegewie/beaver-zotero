import { logger } from '../../utils/logger';
import { ZoteroItemStatus, FrontendFileStatus, AttachmentInfo } from '../../../react/types/zotero';
import { safeIsInTrash, safeFileExists, isLinkedUrlAttachment } from '../../utils/zoteroUtils';
import { libraryRefForLibraryID, parseItemReference, parseLibraryRef, resolveLibraryRef } from '../../utils/libraryIdentity';
import { syncingItemFilterAsync } from '../../utils/sync';
import { getPref } from '../../utils/prefs';

import { isAttachmentOnServer } from '../../utils/webAPI';
import { addPopupMessageAtom } from '../../../react/utils/popupMessageUtils';
import { wasItemAddedBeforeLastSync } from '../../../react/utils/sourceUtils';
import { DeferredToolPreference } from '../agentProtocol';
import { deferredToolPreferencesAtom } from '../../../react/atoms/deferredToolPreferences';
import { isAgentSupportedItem } from '../../utils/agentItemSupport';
import { store } from '../../../react/store';
import { searchableLibraryIdsAtom } from '../../../react/atoms/profile';
import { TimingAccumulator } from '../../utils/timing';
import { getAttachmentInfo as resolveAttachmentInfo, type AttachmentInfoOptions } from '../documentExtraction/attachmentInfo';
export {
    getBestAttachmentBatch,
    prepareAttachmentInfoBatchData,
    processAttachmentInfoBatch,
} from '../documentExtraction/attachmentInfoBatch';
export type { AttachmentInfoBatchData } from '../documentExtraction/attachmentInfoBatch';
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
    resolveToImageAttachment,
} from '../documentExtraction';
export type {
    PreflightErrorCode,
    PreflightFailure,
    PreflightOptions,
    PdfAttachmentResolveResult,
    ImageAttachmentResolveResult,
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
    
    // It's a string - a portable library_ref ("u" | "g<groupID>") is authoritative:
    // resolve it directly and never fall through to numeric/name lookup, even when
    // it doesn't resolve on this device (e.g. a group the user isn't a member of here).
    const parsedRef = parseLibraryRef(libraryIdOrName);
    if (parsedRef) {
        const resolvedId = resolveLibraryRef({ library_ref: libraryIdOrName });
        const lib = resolvedId != null ? Zotero.Libraries.get(resolvedId) : null;
        return {
            library: lib || null,
            wasExplicitlyRequested: true,
            searchInput: libraryIdOrName,
        };
    }

    // Otherwise try to parse as a legacy numeric ID first
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
 * - String: Checks for a key (8 alphanumeric chars), then a compound "<library_ref>-<key>"
 *   or "<libraryID>-<key>" format (e.g. "u-ABCD1234", "g123-ABCD1234", "1-ABCD1234"), then
 *   numeric ID (digits only), then searches by name
 * - null/undefined: Returns null
 *
 * The compound format is resolved only in the embedded library, ignoring the
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

    // Try a compound "<library_ref>-<key>" or "<libraryID>-<key>" format
    // (e.g. "u-ABCD1234", "g123-ABCD1234", "1-ABCD1234")
    const compoundParsed = parseItemReference(collectionIdOrName);
    if (compoundParsed) {
        const compoundLibId = compoundParsed.library_ref
            ? resolveLibraryRef(compoundParsed)
            : compoundParsed.library_id!;
        if (compoundLibId != null && Zotero.Utilities.isValidObjectKey(compoundParsed.zotero_key)) {
            const collection = Zotero.Collections.getByLibraryAndKey(compoundLibId, compoundParsed.zotero_key);
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
    /** Device-portable library identity ("u" | "g<groupID>"). See `src/utils/libraryIdentity.ts`. */
    library_ref?: string;
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
 * Resolves a request-supplied `libraries_filter` array to the local, searchable
 * library IDs it denotes. Each entry may be a numeric ID, a numeric ID string, a
 * portable library_ref ("u" | "g<groupID>"), or a library name (case-insensitive
 * substring match). A `library_ref` that doesn't resolve on this device (e.g. a
 * group the user isn't a member of here) contributes nothing — it never falls
 * back to name matching. The result is always intersected with the searchable
 * libraries and deduplicated.
 */
export function resolveLibrariesFilterToSearchableIds(filters: Array<string | number>): number[] {
    const searchableLibraryIds = getSearchableLibraryIds();
    const resolvedIds = new Set<number>();

    for (const filter of filters) {
        if (typeof filter === 'number') {
            if (searchableLibraryIds.includes(filter)) resolvedIds.add(filter);
            continue;
        }
        // Request payloads are external JSON: skip anything that isn't a string
        // or number rather than letting one malformed entry fail the search.
        if (typeof filter !== 'string') continue;

        const parsedRef = parseLibraryRef(filter);
        if (parsedRef) {
            const libraryID = resolveLibraryRef({ library_ref: filter });
            if (libraryID != null && searchableLibraryIds.includes(libraryID)) {
                resolvedIds.add(libraryID);
            }
            continue;
        }

        const numericId = parseInt(filter, 10);
        if (!isNaN(numericId)) {
            if (searchableLibraryIds.includes(numericId)) resolvedIds.add(numericId);
            continue;
        }

        // Name lookup: case-insensitive substring match against searchable libraries
        const needle = filter.toLowerCase();
        for (const lib of Zotero.Libraries.getAll()) {
            if (searchableLibraryIds.includes(lib.libraryID) && lib.name.toLowerCase().includes(needle)) {
                resolvedIds.add(lib.libraryID);
            }
        }
    }

    return Array.from(resolvedIds);
}

/**
 * Model-facing message for a library the user has excluded from Beaver via the
 * excluded-libraries preference.
 */
export function excludedLibraryMessage(libraryId: number): string {
    const library = Zotero.Libraries?.get?.(libraryId);
    const name = library ? `"${library.name}"` : 'this library';
    return (
        `The library ${name} is excluded from Beaver, so Beaver cannot read or ` +
        `modify its items. Tell the user they can re-enable access by removing it ` +
        `from the excluded libraries list in Beaver Preferences.`
    );
}

/**
 * Exclusion gate for read handlers that resolve a raw library id from a request
 * reference (e.g. document/view requests). Returns an exclusion message when the
 * library exists but is excluded, or null when access is allowed. Callers map the
 * message to their own response error_code.
 *
 * A non-existent library id returns null so the caller's own not_found path
 * handles it — a bad reference must not be mislabeled as "excluded".
 */
export function checkLibraryExcluded(libraryId: number): { message: string } | null {
    // A non-existent library id (or an unavailable Libraries API) is left to the
    // caller's not_found path so a bad reference is never mislabeled "excluded".
    if (!Zotero.Libraries?.get?.(libraryId)) return null;
    if (isLibrarySearchable(libraryId)) return null;
    return { message: excludedLibraryMessage(libraryId) };
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
            library_ref: libraryRefForLibraryID(lib.libraryID) ?? undefined,
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
        library_ref: libraryRefForLibraryID(lib.libraryID) ?? undefined,
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
            error: excludedLibraryMessage(library.libraryID),
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

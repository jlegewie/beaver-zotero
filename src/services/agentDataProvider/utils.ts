import { logger } from '@beaver/agent-core/platform/logger';
import {
    ZoteroItemStatus,
    FrontendFileStatus,
    AttachmentInfo,
    type ItemStub,
    type ZoteroItemReference,
} from '@beaver/agent-core/types/zotero';
import { safeIsInTrash, safeFileExists, isLinkedUrlAttachment } from '../../utils/zoteroUtils';
import { safeAttachmentFilename } from '../../utils/attachmentFiles';
import { safeStub } from '../../utils/zoteroSerializers';
import {
    libraryRefForLibraryID,
    modelObjectId,
    modelObjectIdFromReference,
    parseItemReference,
    parseLibraryRef,
    resolveLibraryRef,
} from '../../utils/libraryIdentity';
import { syncingItemFilterAsync } from '../../utils/sync';
import { getPref } from '../../utils/prefs';

import { isAttachmentOnServer } from '../../utils/webAPI';
import { addPopupMessageAtom } from '../../../react/utils/popupMessageUtils';
import { wasItemAddedBeforeLastSync } from '../../../react/utils/sourceUtils';
import { DeferredToolPreference, type AttachmentRowResult } from '@beaver/agent-core/protocol/agentProtocol';
import { deferredToolPreferencesAtom } from '../../../react/atoms/deferredToolPreferences';
import {
    isActionApprovedForCurrentRun,
    runApprovalPolicyAtom,
} from '../../../react/atoms/runApprovalPolicy';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { isAgentSupportedItem } from '../../utils/agentItemSupport';
import { store } from '../../../react/store';
import { isLibraryAccessReadyAtom, searchableLibraryIdsAtom } from '../../../react/atoms/profile';
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
    validateZoteroItemReference as validateAttachmentReference,
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
 * Build a minimal AttachmentInfo for an attachment that could not be resolved.
 */
export function degradedAttachmentInfo(
    item: Zotero.Item,
    parentItemId: string | null,
    isPrimary = false,
): AttachmentInfo {
    return {
        attachment_id: modelObjectId(item.libraryID, item.key),
        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
        parent_item_id: parentItemId,
        title: safeStub(() => item.getDisplayTitle?.()) ?? null,
        filename: safeAttachmentFilename(item),
        content_kind: 'other',
        status: 'unreadable',
        // States what is known (the read failed) without asserting a cause: the
        // catch this comes from covers any failure, not just a malformed record.
        status_reason:
            'Beaver could not read this attachment from Zotero, so only its '
            + 'identity is available here. Its stored file path may be invalid — '
            + 'the user can check the attachment in Zotero.',
        page_count: null,
        line_count: null,
        // Callers that resolved the parent's best attachment already know this;
        // list/search rows never do and leave it at the default.
        is_primary: isPrimary,
    };
}

/**
 * Search/list row wrapper around {@link degradedAttachmentInfo}.
 */
export function degradedAttachmentRow(
    item: Zotero.Item,
    parentInfo: ItemStub | null,
): AttachmentRowResult {
    return {
        ...degradedAttachmentInfo(item, parentInfo?.item_id ?? null),
        result_type: 'attachment',
        parent_title: parentInfo?.title ?? null,
        parent_item: parentInfo ?? null,
        date_modified: safeStub(() => item.dateModified) ?? null,
    };
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

/** A collection a `collections_filter` entry matched outside the searched libraries. */
export interface OutOfScopeCollection {
    /** The filter entry that matched it. */
    input: string;
    /**
     * Name of the matched collection, or null when it lives in a library
     * excluded from Beaver — that name is content the user put out of Beaver's
     * reach, so it is never carried out of the lookup.
     */
    name: string | null;
    /** Library the match lives in. */
    libraryId: number;
}

/** Outcome of resolving a `collections_filter` against the searched libraries. */
export interface CollectionsFilterResolution {
    /** Collections that resolved inside the searched libraries, deduplicated by ID. */
    collections: Zotero.Collection[];
    /** Filter entries that matched no collection at all. */
    unresolved: string[];
    /** Filter entries that matched only outside the searched libraries. */
    outOfScope: OutOfScopeCollection[];
}

/** A `collections_filter` that left the search with no usable collection. */
export interface CollectionsFilterError {
    message: string;
    error_code: 'collection_not_found' | 'library_not_searchable';
}

/**
 * Resolve a `collections_filter` against the libraries a search will cover.
 *
 * A name is resolved in every searched library, because the same name can
 * legitimately exist in several of them. Matches outside those libraries are
 * reported separately rather than dropped: numeric IDs and key-like entries
 * resolve through a cross-library fallback that can land in a library the
 * request is not scoped to, or that the user excluded from Beaver, and the
 * caller has to tell that apart from a bad reference.
 *
 * `libraryIds` must already be the searchable libraries the search will cover;
 * an empty list resolves nothing at all.
 */
export function resolveCollectionsFilter(
    collectionsFilter: (string | number)[],
    libraryIds: number[]
): CollectionsFilterResolution {
    const collections = new Map<number, Zotero.Collection>();
    const unresolved: string[] = [];
    const outOfScope: OutOfScopeCollection[] = [];

    // Nothing to search in: resolve nothing rather than looking the filter up
    // library-less, which would enumerate every library the user excluded from
    // Beaver. The searchable set is also empty while the profile is still
    // loading, so a lookup here could report an allowed collection as excluded.
    if (libraryIds.length === 0) {
        return { collections: [], unresolved, outOfScope };
    }

    for (const filter of collectionsFilter) {
        const matches: Zotero.Collection[] = [];
        if (typeof filter === 'number') {
            const collection = Zotero.Collections.get(filter);
            if (collection) matches.push(collection);
        } else {
            for (const libraryId of libraryIds) {
                const match = getCollectionByIdOrName(filter, libraryId);
                if (match) matches.push(match.collection);
            }
        }

        const inScope = matches.filter((collection) => libraryIds.includes(collection.libraryID));
        if (inScope.length > 0) {
            for (const collection of inScope) collections.set(collection.id, collection);
        } else if (matches.length > 0) {
            const [collection] = matches;
            outOfScope.push({
                input: String(filter),
                // Keep an excluded library's collection name out of the resolution
                // entirely, so no caller can surface it by accident.
                name: isLibrarySearchable(collection.libraryID) ? collection.name : null,
                libraryId: collection.libraryID,
            });
        } else {
            unresolved.push(String(filter));
        }
    }

    return { collections: Array.from(collections.values()), unresolved, outOfScope };
}

/**
 * Error for a `collections_filter` that resolved to no usable collection.
 *
 * Such a filter must narrow the search to no results rather than widen it to
 * the whole library, but returning an empty result alone is misleading: the
 * model reads it as "that collection holds nothing" and moves on instead of
 * fixing the reference. Returns null when at least one collection resolved —
 * a partially resolved filter searches the collections it found.
 */
export function collectionsFilterError(
    resolution: CollectionsFilterResolution
): CollectionsFilterError | null {
    if (resolution.collections.length > 0) return null;

    if (resolution.unresolved.length > 0) {
        const label = resolution.unresolved.length === 1 ? 'Collection not found' : 'Collections not found';
        const names = resolution.unresolved.map((entry) => `"${entry}"`).join(', ');
        return {
            message: `${label}: ${names}. Use list_collections to discover the available collections.`,
            error_code: 'collection_not_found',
        };
    }

    // Report the exclusion without the collection's name: it is content from a
    // library the user put out of Beaver's reach. The resolution carries no name
    // for such a match, so this cannot regress into echoing one.
    const excluded = resolution.outOfScope.find((entry) => !isLibrarySearchable(entry.libraryId));
    if (excluded) {
        return {
            message: excludedLibraryMessage(excluded.libraryId),
            error_code: 'library_not_searchable',
        };
    }

    const [entry] = resolution.outOfScope;
    if (entry) {
        const library = Zotero.Libraries?.get?.(entry.libraryId);
        const libraryName = library ? `"${library.name}"` : `library ${entry.libraryId}`;
        const collectionLabel = entry.name ? `Collection "${entry.name}"` : `Collection "${entry.input}"`;
        return {
            message: (
                `${collectionLabel} is in ${libraryName}, which is outside the ` +
                `requested libraries_filter. Drop libraries_filter or set it to that library.`
            ),
            error_code: 'collection_not_found',
        };
    }

    return null;
}

/**
 * Return the IDs of the items held by the given collections and all of their
 * subcollections. Trashed subcollections and trashed members are excluded, and
 * an item that sits in several collections in the scope is returned once.
 */
export async function getCollectionScopeItemIds(collections: Zotero.Collection[]): Promise<number[]> {
    const collectionIds = new Set<number>();
    for (const collection of collections) {
        collectionIds.add(collection.id);
        for (const descendant of collection.getDescendents(false, 'collection')) {
            collectionIds.add(descendant.id);
        }
    }
    if (collectionIds.size === 0) return [];

    const scopeIds = Array.from(collectionIds);
    const itemIds = new Set<number>();
    for (let i = 0; i < scopeIds.length; i += 900) {
        const chunk = scopeIds.slice(i, i + 900);
        const placeholders = chunk.map(() => '?').join(', ');
        await Zotero.DB.queryAsync(
            `SELECT itemID
             FROM collectionItems
             WHERE collectionID IN (${placeholders})
               AND itemID NOT IN (SELECT itemID FROM deletedItems)`,
            chunk,
            {
                onRow: (row: any) => {
                    itemIds.add(row.getResultByIndex(0) as number);
                },
            },
        );
    }

    return Array.from(itemIds);
}

/** A `tags_filter` entry that matched no tag in the searched libraries. */
export interface UnresolvedTag {
    /** The filter entry that matched nothing. */
    input: string;
    /** Existing tag names that resemble the entry, best first, possibly empty. */
    suggestions: string[];
}

/** Outcome of resolving a `tags_filter` against the searched libraries. */
export interface TagsFilterResolution {
    /**
     * Tag names to filter by, spelled as Zotero stores them and deduplicated.
     * Empty when nothing resolved — callers must then return no results rather
     * than search without a tag filter.
     */
    tags: string[];
    /** Filter entries that matched no tag in the searched libraries. */
    unresolved: UnresolvedTag[];
}

/** A `tags_filter` that left the search with no usable tag. */
export interface TagsFilterError {
    message: string;
    error_code: 'tag_not_found';
}

/** How many close matches an unresolved tag offers. */
const TAG_SUGGESTION_LIMIT = 3;

/** Below this length a containment match is noise ("a" is inside half the library). */
const MIN_CONTAINMENT_LENGTH = 3;

/**
 * Levenshtein distance between two strings, abandoned as soon as it is known to
 * exceed `max` (which is then returned as `max + 1`). The bound is what keeps
 * this cheap enough to run against every tag in the library.
 */
function boundedEditDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;

    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        let rowBest = i;
        for (let j = 1; j <= b.length; j++) {
            const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
            const distance = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
            current.push(distance);
            if (distance < rowBest) rowBest = distance;
        }
        // Every alignment through this row already costs more than the bound.
        if (rowBest > max) return max + 1;
        previous = current;
    }
    return previous[b.length];
}

/**
 * Existing tag names that most resemble `input`, best first.
 *
 * Two kinds of near-miss are worth reporting, because both are common in a
 * model-supplied filter: a misspelling ("Econimics"), caught by edit distance,
 * and a tag written shorter or longer than the stored one ("econ" for
 * "economics"), caught by containment. The distance budget scales with the
 * input so a long tag may be off by more than one character without a short one
 * matching everything.
 */
function suggestTagNames(input: string, inventory: string[]): string[] {
    const needle = input.toLowerCase();
    if (!needle) return [];
    const maxDistance = needle.length <= 4 ? 1 : Math.min(3, Math.floor(needle.length / 3));

    const scored: { name: string; distance: number; lengthDiff: number }[] = [];
    for (const name of inventory) {
        const candidate = name.toLowerCase();
        if (candidate === needle) continue;
        const lengthDiff = Math.abs(candidate.length - needle.length);

        if (
            needle.length >= MIN_CONTAINMENT_LENGTH
            && (candidate.includes(needle) || needle.includes(candidate))
        ) {
            scored.push({ name, distance: 0, lengthDiff });
            continue;
        }

        const distance = boundedEditDistance(needle, candidate, maxDistance);
        if (distance <= maxDistance) scored.push({ name, distance, lengthDiff });
    }

    scored.sort((a, b) => (
        a.distance - b.distance
        || a.lengthDiff - b.lengthDiff
        || a.name.localeCompare(b.name)
    ));
    return scored.slice(0, TAG_SUGGESTION_LIMIT).map((entry) => entry.name);
}

/**
 * Resolve a `tags_filter` against the libraries a search will cover.
 *
 * Entries are matched case-insensitively but resolve to the tag names Zotero
 * stores, because the metadata search compares tags case-sensitively in SQL: a
 * filter of "economics" against a stored "Economics" would otherwise match
 * nothing and read as an empty library. When both casings exist as separate
 * tags, all of them resolve — the filter ORs its tags, so that widens nothing
 * beyond what the entry asked for.
 *
 * A tag carried only by a trashed item still counts as existing. Reporting it as
 * unknown would send the model looking for a spelling mistake that isn't there,
 * which is worse than the empty result the search returns.
 *
 * `libraryIds` must already be the searchable libraries the search will cover;
 * an empty list resolves nothing at all, so no tag from a library the user
 * excluded from Beaver can be confirmed, suggested, or denied.
 */
export async function resolveTagsFilter(
    tagsFilter: (string | number)[],
    libraryIds: number[]
): Promise<TagsFilterResolution> {
    if (libraryIds.length === 0) return { tags: [], unresolved: [] };

    const inputs: string[] = [];
    for (const entry of tagsFilter) {
        // Request payloads are external JSON: skip anything that isn't a string
        // or number rather than letting one malformed entry fail the search.
        if (typeof entry !== 'string' && typeof entry !== 'number') continue;
        const input = String(entry).trim();
        if (input) inputs.push(input);
    }
    if (inputs.length === 0) return { tags: [], unresolved: [] };

    // Every tag in the searched libraries, including tags that only sit on
    // attachments, notes, or annotations: those are real tags a user can filter
    // by even though this search only returns regular items.
    const perLibrary = await Promise.all(
        libraryIds.map((libraryId) => Zotero.Tags.getAll(libraryId) as Promise<{ tag: string }[]>)
    );
    const byFoldedName = new Map<string, string[]>();
    const inventory: string[] = [];
    for (const libraryTags of perLibrary) {
        for (const { tag } of libraryTags) {
            const folded = tag.toLowerCase();
            const stored = byFoldedName.get(folded);
            if (!stored) {
                byFoldedName.set(folded, [tag]);
                inventory.push(tag);
            } else if (!stored.includes(tag)) {
                stored.push(tag);
                inventory.push(tag);
            }
        }
    }

    const tags = new Set<string>();
    const unresolved: UnresolvedTag[] = [];
    for (const input of inputs) {
        const stored = byFoldedName.get(input.toLowerCase());
        if (stored) {
            for (const name of stored) tags.add(name);
        } else {
            unresolved.push({ input, suggestions: suggestTagNames(input, inventory) });
        }
    }

    return { tags: Array.from(tags), unresolved };
}

/**
 * Error for a `tags_filter` that resolved to no existing tag.
 *
 * Without it the model cannot tell its three cases apart: a tag it spelled
 * wrong, a tag that exists but carries no matching item, and a real result.
 * Only the first is an error, and it is the one an empty result hides.
 *
 * Returns null when at least one tag resolved. A partially resolved filter is
 * not an error and is reported as none: the filter ORs its tags, so an entry
 * that matches no tag at all contributes nothing either way, and the search the
 * model gets back is exactly the one it asked for.
 */
export function tagsFilterError(resolution: TagsFilterResolution): TagsFilterError | null {
    if (resolution.tags.length > 0) return null;
    if (resolution.unresolved.length === 0) return null;

    const label = resolution.unresolved.length === 1 ? 'Tag not found' : 'Tags not found';
    const entries = resolution.unresolved
        .map(({ input, suggestions }) => {
            if (suggestions.length === 0) return `"${input}"`;
            const names = suggestions.map((name) => `"${name}"`).join(', ');
            return `"${input}" (did you mean ${names}?)`;
        })
        .join(', ');
    return {
        message: `${label}: ${entries}. Tags must match an existing tag; use list_tags to discover them.`,
        error_code: 'tag_not_found',
    };
}

/** A tag resolved to the casing a library stores, or the reason it wasn't. */
export type StoredTagResolution =
    | { found: true; name: string }
    | { found: false; error: string };

/**
 * Resolve a tag to the casing the library stores.
 *
 * `tag`/`is` search is case-sensitive, so a mis-cased filter would match
 * nothing. If several stored casings match, report them rather than picking
 * one — a single `tag is` condition can only search one name.
 */
export async function resolveStoredTagName(
    libraryID: number,
    libraryName: string,
    tag: string
): Promise<StoredTagResolution> {
    const allTags = (await Zotero.Tags.getAll(libraryID)) as { tag: string }[];
    // getAll() returns one row per tag type; dedupe so that isn't treated as
    // distinct casings.
    const matches = Array.from(new Set(
        allTags
            .filter((t) => t.tag.toLowerCase() === tag.toLowerCase())
            .map((t) => t.tag)
    ));

    if (matches.length === 0) {
        return { found: false, error: `Tag not found: "${tag}" in library "${libraryName}"` };
    }
    if (matches.includes(tag)) {
        return { found: true, name: tag };
    }
    if (matches.length > 1) {
        const names = matches.map((name) => `"${name}"`).join(', ');
        return {
            found: false,
            error: `Tag not found: "${tag}" in library "${libraryName}". `
                + `Tags are case-sensitive; did you mean ${names}?`,
        };
    }
    return { found: true, name: matches[0] };
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
 * Names that read like item fields but are not stored as itemData.
 * `readItemField()` resolves each of these directly.
 */
const NON_FIELD_ALIASES = new Set(['itemType', 'creator', 'creators', 'year']);

/**
 * Primary data that may be read by name.
 *
 * An allowlist, not a filter over `Zotero.Items.primaryFields`: most primary
 * fields are device-local or internal (`id`, `itemID`, `libraryID`,
 * `itemTypeID`, `parentID`, `version`, `synced`, the `attachment*` columns …),
 * and none of them is stable across installs. Item identity on the wire is the
 * portable `item_id` / `library_ref` pair, so anything not listed here stays
 * unreadable.
 */
const READABLE_PRIMARY_FIELDS = new Set(['dateAdded', 'dateModified', 'key', 'firstCreator']);

/**
 * Whether a caller-supplied name can be read off an item at all.
 *
 * Readability does not depend on the item: a valid field that the item's type
 * does not use just reads as empty. Callers with a fixed field list should
 * therefore validate once, up front, rather than per item.
 */
export function isReadableItemField(field: string): boolean {
    if (!field) return false;
    if (NON_FIELD_ALIASES.has(field)) return true;
    if (READABLE_PRIMARY_FIELDS.has(field)) return true;
    // Primary data outside the allowlist is rejected here rather than falling
    // through to the itemData lookup, which would never have matched anyway.
    if (Zotero.Items.isPrimaryField(field)) return false;

    // `field` arrives over the wire, so it can be an inherited Object key
    // ("constructor", "toString", …). Zotero looks fields up in a plain object,
    // so require a real field ID rather than trusting truthiness.
    const fieldID = Zotero.ItemFields.getID(field);
    return typeof fieldID === 'number' && fieldID > 0;
}

/**
 * Read an arbitrary, caller-supplied field name off an item without letting
 * Zotero throw.
 *
 * `Zotero.Item.getField(name, false, true)` resolves `name` through
 * `ItemFields.getFieldIDFromTypeAndBase()`, which throws
 * `Invalid field '<name>' for base field` for anything that is not an itemData
 * field. `itemType` and `creator` are among the names most often asked for and
 * neither is one: they are the item type and the creators.
 *
 * Catching the throw is not enough. Plugins patch
 * `Zotero.Item.prototype.getField` (zotero-plugin-toolkit's field-hook manager
 * does this on construction), and each patch layer logs the error it catches
 * and then retries the call, so the work and the error-console output grow
 * exponentially with the number of installed layers. Resolve the aliases
 * directly and reject unknown names before calling `getField()`.
 *
 * Returns `undefined` for anything `isReadableItemField()` rejects.
 */
export function readItemField(item: Zotero.Item, field: string): string | number | null | undefined {
    if (!isReadableItemField(field)) return undefined;

    switch (field) {
        case 'itemType':
            return item.itemType;
        case 'creator':
        case 'creators':
            return formatCreatorsString(item.getCreators());
        case 'year': {
            const date = readItemField(item, 'date');
            return extractYear(typeof date === 'string' ? date : undefined);
        }
    }

    // Primary data is returned as-is by getField() and must not go through
    // base-field mapping.
    if (READABLE_PRIMARY_FIELDS.has(field)) {
        return item.getField(field as _ZoteroTypes.Item.ItemField) as string;
    }

    // includeBaseMapped=true so base fields resolve to type-specific fields
    return item.getField(field as _ZoteroTypes.Item.ItemField, false, true) as string;
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
 * Whether the library-access snapshot has loaded far enough to explain an access
 * decision. `getSearchableLibraryIds()` is fail-closed `[]` until the profile and
 * the local library list are both in the store, so before that every library
 * reads as non-searchable. Gate any message that *attributes* a denial (e.g. "the
 * user excluded this library") on this; the fail-closed scope itself needs no
 * gate.
 */
export function isLibraryAccessReady(): boolean {
    return store.get(isLibraryAccessReadyAtom);
}

/** A `libraries_filter` entry that matched a library the user excluded from Beaver. */
export interface ExcludedFilterLibrary {
    /** The filter entry that matched it. */
    input: string;
    /** Library the match lives in. */
    libraryId: number;
}

/** Outcome of resolving a `libraries_filter` against this device's libraries. */
export interface LibrariesFilterResolution {
    /** Searchable local library IDs the filter resolved to, deduplicated. */
    libraryIds: number[];
    /** Filter entries that matched no library on this device. */
    unresolved: string[];
    /** Filter entries that matched only libraries excluded from Beaver. */
    excluded: ExcludedFilterLibrary[];
}

/** A `libraries_filter` that left the search with no usable library. */
export interface LibrariesFilterError {
    message: string;
    error_code: 'library_not_found' | 'library_not_searchable';
}

/**
 * Resolve a request-supplied `libraries_filter` against this device's libraries.
 *
 * Each entry may be a portable library_ref ("u" | "g<groupID>"), a numeric ID, a
 * numeric ID string, or a library name (case-insensitive substring match). Refs
 * are the documented form; name matching is kept only as a fallback for models
 * that pass a name anyway, and never applies to an entry that parses as a ref —
 * a group ref this device doesn't have is unresolved, not a name to look up.
 *
 * An explicit reference (ref or numeric ID) is resolved against every local
 * library and then classified, so the caller can tell a bad reference apart from
 * a library the user excluded from Beaver — the same contract as
 * `validateLibraryAccess`. The name fallback is deliberately narrower: it
 * searches only the searchable libraries, so a substring can never enumerate an
 * excluded library or surface its name. A name that matches only excluded
 * libraries is therefore reported as not found.
 *
 * An entry with both searchable and excluded matches counts as resolved: the
 * searchable matches are what the search can honour.
 */
export function resolveLibrariesFilter(filters: Array<string | number>): LibrariesFilterResolution {
    const searchableLibraryIds = getSearchableLibraryIds();
    const libraryIds = new Set<number>();
    const unresolved: string[] = [];
    const excluded: ExcludedFilterLibrary[] = [];

    /** Sort one entry's local matches into the resolution's three buckets. */
    const classify = (input: string, matchedIds: number[]) => {
        const searchable = matchedIds.filter((id) => searchableLibraryIds.includes(id));
        if (searchable.length > 0) {
            for (const id of searchable) libraryIds.add(id);
        } else if (matchedIds.length > 0) {
            excluded.push({ input, libraryId: matchedIds[0] });
        } else {
            unresolved.push(input);
        }
    };

    for (const filter of filters) {
        // Request payloads are external JSON: skip anything that isn't a string
        // or number rather than letting one malformed entry fail the search.
        if (typeof filter !== 'number' && typeof filter !== 'string') continue;

        if (typeof filter === 'number') {
            classify(String(filter), Zotero.Libraries?.get?.(filter) ? [filter] : []);
            continue;
        }

        const parsedRef = parseLibraryRef(filter);
        if (parsedRef) {
            const libraryID = resolveLibraryRef({ library_ref: filter });
            classify(filter, libraryID != null ? [libraryID] : []);
            continue;
        }

        // Strict numeric string, so "5abc" falls through to the name fallback
        // instead of being silently read as library 5.
        if (/^[1-9][0-9]*$/.test(filter)) {
            const numericId = parseInt(filter, 10);
            classify(filter, Zotero.Libraries?.get?.(numericId) ? [numericId] : []);
            continue;
        }

        // Undocumented name fallback: case-insensitive substring match, scoped to
        // the searchable libraries. A substring match is far looser than an
        // explicit reference, so it must never reach a library the user excluded
        // from Beaver — enumerating one here would leak its name through the
        // exclusion message.
        const needle = filter.toLowerCase();
        const byName = Zotero.Libraries.getAll()
            .filter((lib) => searchableLibraryIds.includes(lib.libraryID)
                && lib.name.toLowerCase().includes(needle))
            .map((lib) => lib.libraryID);
        classify(filter, byName);
    }

    return { libraryIds: Array.from(libraryIds), unresolved, excluded };
}

/**
 * Error for a `libraries_filter` that resolved to no searchable library.
 *
 * Such a filter must narrow the search to no results rather than widen it to
 * every library, but returning an empty result alone is misleading: the model
 * reads it as "those libraries hold nothing" and moves on instead of fixing the
 * reference. Returns null when at least one library resolved — a partially
 * resolved filter searches the libraries it found.
 */
export function librariesFilterError(
    resolution: LibrariesFilterResolution
): LibrariesFilterError | null {
    if (resolution.libraryIds.length > 0) return null;

    // Every classification here depends on the searchable set, which is
    // fail-closed `[]` until the library-access snapshot loads: until then a valid
    // reference looks excluded and a valid name looks unknown. Give no reason
    // rather than a wrong one — the caller's empty library scope still returns no
    // results, so the search stays fail-closed either way.
    if (!isLibraryAccessReady()) return null;

    if (resolution.unresolved.length > 0) {
        const label = resolution.unresolved.length === 1 ? 'Library not found' : 'Libraries not found';
        const names = resolution.unresolved.map((entry) => `"${entry}"`).join(', ');
        const available = getSearchableLibraries()
            .map((lib) => `"${lib.name}"${lib.library_ref ? ` (${lib.library_ref})` : ''}`)
            .join(', ');
        const availableNote = available
            ? ` Available libraries: ${available}.`
            : '';
        return {
            message: `${label}: ${names}. Identify a library by its portable ref ("u" for the personal library, "g<groupID>" for a group).${availableNote}`,
            error_code: 'library_not_found',
        };
    }

    const [entry] = resolution.excluded;
    if (entry) {
        return {
            message: excludedLibraryMessage(entry.libraryId),
            error_code: 'library_not_searchable',
        };
    }

    return null;
}

/**
 * Resolves a request-supplied `libraries_filter` array to the local, searchable
 * library IDs it denotes, discarding why any entry failed to resolve. Prefer
 * `resolveLibrariesFilter` where an unusable filter has to be reported to the
 * model rather than silently narrowing the search to nothing.
 */
export function resolveLibrariesFilterToSearchableIds(filters: Array<string | number>): number[] {
    return resolveLibrariesFilter(filters).libraryIds;
}

/**
 * Model-facing message for a library the user has excluded from Beaver via the
 * excluded-libraries preference.
 *
 * This phrasing addresses the model ("Tell the user…"), so never render it in
 * the UI — use `excludedLibraryUserMessage` for anything a user reads.
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
 * User-facing counterpart of `excludedLibraryMessage`, for exclusion failures
 * surfaced directly in the UI (e.g. an undo the user clicked). Same condition,
 * addressed to the user rather than the model.
 */
export function excludedLibraryUserMessage(libraryId: number): string {
    const library = Zotero.Libraries?.get?.(libraryId);
    const name = library ? `"${library.name}"` : 'this library';
    return (
        `The library ${name} is excluded from Beaver, so Beaver cannot modify ` +
        `its items. You can re-enable access by removing it from the excluded ` +
        `libraries list in Beaver Preferences.`
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

export type ZoteroAttachmentRequestPreflight =
    | {
        ok: true;
        responseAttachment: ZoteroItemReference;
        requestKey: string;
        resolvedLibraryId: number;
    }
    | {
        ok: false;
        responseAttachment: ZoteroItemReference;
        requestKey: string;
        error: string;
        errorCode: 'invalid_format' | 'library_unavailable' | 'library_excluded';
    };

/**
 * Validate and authorize an attachment reference before any Zotero item lookup.
 *
 * This is the shared privacy boundary for attachment-serving handlers: it
 * stamps the portable response reference, validates the request shape,
 * resolves the device-local library id, and rejects excluded libraries.
 */
export function preflightZoteroAttachmentRequest(
    attachment: ZoteroItemReference,
    validateReference: (reference: ZoteroItemReference) => string | null = validateAttachmentReference,
): ZoteroAttachmentRequestPreflight {
    const responseAttachment = {
        ...attachment,
        library_ref:
            attachment.library_ref ??
            libraryRefForLibraryID(attachment.library_id) ??
            undefined,
    };
    const requestKey = modelObjectIdFromReference(attachment);

    const formatError = validateReference(attachment);
    if (formatError) {
        return {
            ok: false,
            responseAttachment,
            requestKey,
            error: `Invalid attachment reference '${requestKey}': ${formatError}`,
            errorCode: 'invalid_format',
        };
    }

    const resolvedLibraryId = resolveLibraryRef(attachment);
    if (!resolvedLibraryId) {
        return {
            ok: false,
            responseAttachment,
            requestKey,
            error: "Attachment is in a library that isn't available on this computer.",
            errorCode: 'library_unavailable',
        };
    }

    const excluded = checkLibraryExcluded(resolvedLibraryId);
    if (excluded) {
        return {
            ok: false,
            responseAttachment,
            requestKey,
            error: excluded.message,
            errorCode: 'library_excluded',
        };
    }

    return {
        ok: true,
        responseAttachment,
        requestKey,
        resolvedLibraryId,
    };
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
export function getDeferredToolPreference(
    toolName: string,
    actionData?: Record<string, any>,
): DeferredToolPreference {
    try {
        const runPolicy = store.get(runApprovalPolicyAtom);
        const activeRunId = store.get(activeRunAtom)?.id ?? null;
        if (isActionApprovedForCurrentRun(runPolicy, activeRunId, toolName, actionData)) {
            return 'always_apply';
        }

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
                ? `'${safeAttachmentFilename(attachment) ?? ''}' (${key}, primary)`
                : `'${safeAttachmentFilename(attachment) ?? ''}' (${key})`;
        });

    return {
        count: supportedAttachmentKeys.length,
        text: supportedAttachmentKeys.join(', '),
        bestAttachmentKey: bestAttachmentKey,
    }
}

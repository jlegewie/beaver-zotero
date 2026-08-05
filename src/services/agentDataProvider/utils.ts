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
    parseLibraryRef,
    resolveLibraryRef,
    resolveObjectId,
    UNRESOLVED_LIBRARY_ID,
} from '../../utils/libraryIdentity';
import type { ObjectIdReference } from '../../utils/libraryIdentity';
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

/** How a collection reference matched. */
export type CollectionMatchKind = 'identifier' | 'key' | 'name' | 'row_id';

/** A single collection a reference resolved to. */
export interface CollectionMatch {
    collection: Zotero.Collection;
    libraryID: number;
}

/** Result of collection lookup, including the library where the collection was found. */
export type CollectionLookupResult = CollectionMatch;

/** Typed failures of collection resolution. */
export type CollectionResolutionErrorCode =
    | 'collection_not_found'
    | 'ambiguous_collection'
    | 'library_unavailable'
    | 'library_not_searchable'
    | 'invalid_request';

/** A failed collection resolution, ready to be mapped onto a response's `{ error, error_code }`. */
export interface CollectionResolutionFailure {
    ok: false;
    code: CollectionResolutionErrorCode;
    message: string;
}

/** Every collection a reference matched, or a typed failure. */
export type CollectionResolution =
    | { ok: true; matchKind: CollectionMatchKind; matches: CollectionMatch[] }
    | CollectionResolutionFailure;

/** The single collection a reference matched, or a typed failure. */
export type SingleCollectionResolution =
    | { ok: true; matchKind: CollectionMatchKind; match: CollectionMatch }
    | CollectionResolutionFailure;

export interface ResolveCollectionOptions {
    /**
     * Libraries any reference may resolve within, and the resolver's single
     * authority on access for every grammar. Callers pass a list they have
     * already decided is readable — `getSearchableLibraryIds()` on data paths,
     * a single library on paths that act inside one. A scoped identifier for a
     * library outside the list is bounded by `explicitLibrary` and by the
     * exclusion check; see {@link resolveCollectionMatches}.
     */
    eligibleLibraryIds: number[];
    /** Libraries a *name* may resolve within. Defaults to `eligibleLibraryIds`. */
    nameLibraryIds?: number[];
    /**
     * True when `eligibleLibraryIds` came from a library the request named
     * explicitly. Set it whenever the caller means the list as a hard scope: it
     * turns a scoped identifier from another library into `invalid_request`
     * instead of resolving it.
     */
    explicitLibrary?: boolean;
}

function uniqueLibraryIds(ids: number[]): number[] {
    return Array.from(new Set(ids));
}

function libraryDisplayName(libraryID: number): string {
    const library = Zotero.Libraries?.get?.(libraryID);
    return library ? library.name : `library ${libraryID}`;
}

function collectionNotFound(input: string): CollectionResolutionFailure {
    return { ok: false, code: 'collection_not_found', message: `Collection not found: ${input}` };
}

/**
 * Ambiguity is an error rather than a silent first-match: a reference denotes
 * one collection, so picking one of several candidates would quietly act on
 * something other than what was asked for. The message names every candidate by
 * scoped identifier so the caller can retry unambiguously.
 */
function ambiguousCollections(input: string, matches: CollectionMatch[]): CollectionResolutionFailure {
    const candidates = matches
        .map(
            (match) =>
                `${modelObjectId(match.libraryID, match.collection.key)} ` +
                `("${match.collection.name}" in library "${libraryDisplayName(match.libraryID)}")`
        )
        .join('; ');
    return {
        ok: false,
        code: 'ambiguous_collection',
        message:
            `"${input}" matches ${matches.length} collections: ${candidates}. ` +
            `Retry with the scoped collection identifier of the one you want.`,
    };
}

/**
 * Resolve a device-local collection row id. A collection outside the eligible
 * libraries reads as not-found so a row id can never disclose that a collection
 * exists in a library the caller may not see.
 */
function resolveCollectionRowId(
    rowId: number,
    eligibleLibraryIds: number[],
    input: string
): CollectionResolution {
    const collection = Zotero.Collections.get(rowId);
    if (!collection || !eligibleLibraryIds.includes(collection.libraryID)) {
        return collectionNotFound(input);
    }
    return { ok: true, matchKind: 'row_id', matches: [{ collection, libraryID: collection.libraryID }] };
}

/**
 * Parse a scoped collection identifier (`u-ABCD1234`, `g123-ABCD1234`,
 * `1-ABCD1234`). Returns null when the value only looks structurally like one:
 * a suffix that isn't a valid Zotero key (e.g. `u-Drafts`) is a collection
 * *name* that happens to contain a hyphen, and must stay matchable as a name.
 *
 * `library_id` is `UNRESOLVED_LIBRARY_ID` when the embedded portable ref names
 * a library this device doesn't have.
 */
export function parseScopedCollectionId(input: string): ObjectIdReference | null {
    const parsed = resolveObjectId(input);
    if (!parsed) return null;
    if (!Zotero.Utilities.isValidObjectKey(parsed.zotero_key)) return null;
    return parsed;
}

/**
 * Resolve a collection reference to every match, scoped to the libraries the
 * caller declares eligible. Callers apply their own cardinality rules; see
 * {@link resolveSingleCollection} for the single-target case.
 *
 * Grammars, in precedence order:
 * 1. `number` — device-local collection row id.
 * 2. Scoped identifier (`u-KEY`, `g<groupID>-KEY`, `<libraryID>-KEY`). Authoritative:
 *    it resolves in its embedded library or fails, never falling through to a name.
 *    Its library must be eligible, or — for a caller that named no library —
 *    at least not excluded from Beaver.
 * 3. Zotero key — matched across every eligible library. Several hits are an
 *    ambiguity, not a list.
 * 4. Name — case-insensitive exact match across `nameLibraryIds`. One library can
 *    legitimately hold several same-named collections (e.g. under different parents),
 *    so all of them are returned.
 * 5. Digit-only string — row id.
 */
export function resolveCollectionMatches(
    collectionIdOrName: number | string | null | undefined,
    options: ResolveCollectionOptions
): CollectionResolution {
    if (collectionIdOrName == null) return collectionNotFound('');

    const eligibleLibraryIds = uniqueLibraryIds(options.eligibleLibraryIds ?? []);
    const nameLibraryIds = uniqueLibraryIds(options.nameLibraryIds ?? eligibleLibraryIds);

    // A number is always a row id; no other grammar applies.
    if (typeof collectionIdOrName === 'number') {
        return resolveCollectionRowId(collectionIdOrName, eligibleLibraryIds, String(collectionIdOrName));
    }

    const input = collectionIdOrName;
    if (input.trim() === '') return collectionNotFound(input);

    const identifier = parseScopedCollectionId(input);
    if (identifier) {
        const libraryID = identifier.library_id;
        if (libraryID === UNRESOLVED_LIBRARY_ID || !Zotero.Libraries?.get?.(libraryID)) {
            return {
                ok: false,
                code: 'library_unavailable',
                message: `The collection "${input}" is in a library that is not available on this computer.`,
            };
        }
        // An eligible library needs no further check: the caller already
        // declared it readable, and the key grammar below trusts the same list.
        // Everything outside it is either a scope conflict or, for a caller that
        // named no library, allowed only while the library is not excluded.
        if (!eligibleLibraryIds.includes(libraryID)) {
            if (options.explicitLibrary) {
                // The conflicting library is named by the identifier the caller
                // passed, never by its display name: it may be a library the
                // user excluded from Beaver, whose name must not be disclosed.
                const requested = eligibleLibraryIds.map(libraryDisplayName).join('", "');
                return {
                    ok: false,
                    code: 'invalid_request',
                    message:
                        `The collection "${input}" is not in library "${requested}", which the request asked ` +
                        `for. Pass a collection from the requested library, or omit the library parameter.`,
                };
            }
            // Exclusion is checked before the lookup: an excluded library must
            // not disclose whether the collection exists. The identifier names
            // the library explicitly, so acknowledging the exclusion leaks nothing.
            if (!isLibrarySearchable(libraryID)) {
                return { ok: false, code: 'library_not_searchable', message: excludedLibraryMessage(libraryID) };
            }
        }
        const collection = Zotero.Collections.getByLibraryAndKey(libraryID, identifier.zotero_key);
        if (!collection) return collectionNotFound(input);
        return {
            ok: true,
            matchKind: 'identifier',
            matches: [{ collection, libraryID: collection.libraryID }],
        };
    }

    // A key is unique only within a library, so the same key can exist in several.
    if (Zotero.Utilities.isValidObjectKey(input)) {
        const keyMatches: CollectionMatch[] = [];
        for (const libraryID of eligibleLibraryIds) {
            const collection = Zotero.Collections.getByLibraryAndKey(libraryID, input);
            if (collection) keyMatches.push({ collection, libraryID: collection.libraryID });
        }
        if (keyMatches.length > 1) return ambiguousCollections(input, keyMatches);
        // A key match wins over a collection whose name merely looks like a key.
        if (keyMatches.length === 1) return { ok: true, matchKind: 'key', matches: keyMatches };
    }

    const inputLower = input.toLowerCase();
    const nameMatches: CollectionMatch[] = [];
    for (const libraryID of nameLibraryIds) {
        for (const collection of Zotero.Collections.getByLibrary(libraryID, true)) {
            if (collection.name?.toLowerCase() === inputLower) {
                nameMatches.push({ collection, libraryID: collection.libraryID });
            }
        }
    }
    if (nameMatches.length > 0) return { ok: true, matchKind: 'name', matches: nameMatches };

    if (/^\d+$/.test(input)) {
        return resolveCollectionRowId(parseInt(input, 10), eligibleLibraryIds, input);
    }

    return collectionNotFound(input);
}

/**
 * Resolve a collection reference for a single-target caller: exactly one match
 * is required and several candidates are an `ambiguous_collection` failure.
 */
export function resolveSingleCollection(
    collectionIdOrName: number | string | null | undefined,
    options: ResolveCollectionOptions
): SingleCollectionResolution {
    const resolution = resolveCollectionMatches(collectionIdOrName, options);
    if (!resolution.ok) return resolution;
    if (resolution.matches.length > 1) {
        return ambiguousCollections(String(collectionIdOrName), resolution.matches);
    }
    return { ok: true, matchKind: resolution.matchKind, match: resolution.matches[0] };
}

/** The single collection a write reference matched, or a typed failure. */
export type WriteCollectionResolution =
    | { ok: true; match: CollectionMatch }
    | CollectionResolutionFailure;

/**
 * Resolve a collection reference for a write operation, where a collection
 * *name* is not an acceptable reference.
 *
 * A name can denote several collections — across libraries, and inside one
 * library under different parents — and a write that lands in the wrong
 * collection is not something the caller can detect from the result. Reads stay
 * permissive; writes take the identifier that `list_collections` returns.
 */
export function resolveCollectionForWrite(
    collectionIdOrName: number | string | null | undefined,
    options: ResolveCollectionOptions
): WriteCollectionResolution {
    const resolution = resolveSingleCollection(collectionIdOrName, options);
    if (!resolution.ok) return resolution;
    if (resolution.matchKind === 'name') {
        const { collection, libraryID } = resolution.match;
        return {
            ok: false,
            code: 'invalid_request',
            message:
                `"${collectionIdOrName}" is a collection name, and this operation needs a collection ` +
                `identifier. Pass ${modelObjectId(libraryID, collection.key)}, the identifier ` +
                `list_collections returns for "${collection.name}".`,
        };
    }
    return { ok: true, match: resolution.match };
}

/** A collection filter resolved to the library that holds it. */
export interface ResolvedCollectionFilter {
    libraryID: number;
    key: string;
}

/** Resolved collection filters, or the typed failure that stopped the search. */
export type CollectionFilterResolution =
    | { ok: true; filters: ResolvedCollectionFilter[] }
    | CollectionResolutionFailure;

/**
 * Membership key for a collection filter. A collection key is unique only
 * within its library, so comparing bare keys would match an item that sits in a
 * same-keyed collection of a different library.
 */
export function collectionFilterKey(libraryID: number, collectionKey: string): string {
    return `${libraryID}-${collectionKey}`;
}

/**
 * Resolve a search request's `collections_filter` into (library, key) pairs.
 *
 * Every entry must resolve. Dropping an unresolvable filter would run a search
 * the caller believes is collection-scoped and hand back items from outside the
 * filter, so a single failure fails the whole search instead.
 *
 * Filters are OR'd, so a *name* matching several collections contributes all of
 * them. A bare *key* denotes one collection, so matching in more than one
 * eligible library is an ambiguity the caller must resolve with a scoped
 * identifier.
 *
 * `eligibleLibraryIds` must already be intersected with the searchable
 * libraries. Pass `explicitLibrary` when the request named its libraries, so a
 * scoped identifier from another library is reported as a scope conflict rather
 * than widening the search past the libraries that were asked for.
 */
export function resolveCollectionFilters(
    collectionsFilter: (string | number)[] | null | undefined,
    options: { eligibleLibraryIds: number[]; explicitLibrary?: boolean }
): CollectionFilterResolution {
    if (!collectionsFilter) return { ok: true, filters: [] };

    // Request payloads are external JSON, so the container is checked like its
    // entries: a non-array filter is a malformed request, not an absent one.
    if (!Array.isArray(collectionsFilter)) {
        return {
            ok: false,
            code: 'invalid_request',
            message: `A collections filter must be a list of collection identifiers, keys or names, but was of type ${typeof collectionsFilter}.`,
        };
    }
    if (collectionsFilter.length === 0) return { ok: true, filters: [] };

    const filters: ResolvedCollectionFilter[] = [];
    const seen = new Set<string>();
    const failures: CollectionResolutionFailure[] = [];

    for (const entry of collectionsFilter) {
        // Request payloads are external JSON. A malformed entry counts as an
        // unresolvable filter rather than being dropped, so it can never shrink
        // the scope of a search the caller believes is filtered.
        if (typeof entry !== 'string' && typeof entry !== 'number') {
            failures.push({
                ok: false,
                code: 'invalid_request',
                message: `A collection filter must be a collection identifier, key or name, but one was of type ${typeof entry}.`,
            });
            continue;
        }

        const resolution = resolveCollectionMatches(entry, {
            eligibleLibraryIds: options.eligibleLibraryIds,
            explicitLibrary: options.explicitLibrary,
        });
        if (!resolution.ok) {
            failures.push(resolution);
            continue;
        }
        for (const match of resolution.matches) {
            const dedupKey = collectionFilterKey(match.libraryID, match.collection.key);
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            filters.push({ libraryID: match.libraryID, key: match.collection.key });
        }
    }

    if (failures.length > 0) {
        return {
            ok: false,
            code: failures[0].code,
            message:
                `No search was run: ${failures.length} of ${collectionsFilter.length} collection filters ` +
                `could not be resolved. ${failures.map((failure) => failure.message).join(' ')}`,
        };
    }

    return { ok: true, filters };
}

/**
 * Libraries to echo alongside a failed collection resolution. Only library-scope
 * failures get the list, since it tells the caller where it may retry; a
 * not-found or ambiguous reference is already fully explained by its message.
 */
export function librariesForCollectionError(
    code: CollectionResolutionErrorCode
): AvailableLibraryInfo[] | undefined {
    switch (code) {
        case 'library_unavailable':
        case 'library_not_searchable':
        case 'invalid_request':
            return getSearchableLibraries();
        default:
            return undefined;
    }
}

/**
 * Resolve with `libraryId` as a scope *hint*: look inside the hinted library
 * first, and widen to `fallbackLibraryIds` only when nothing matched there, so a
 * key present in both the hint and another library resolves to the one the
 * caller meant. Any other failure inside the hinted library (ambiguity there, or
 * a scoped identifier naming an unavailable/excluded library) is final —
 * widening must not paper it over. Names stay scoped to the hint because names
 * like "Inbox" are commonly duplicated across libraries.
 *
 * Every failure, including ambiguity, reads as no-match: these callers must act
 * on (or render) nothing rather than arbitrarily pick one of several targets.
 */
function resolveCollectionWithHint(
    collectionIdOrName: number | string | null | undefined,
    libraryId: number | undefined,
    fallbackLibraryIds: number[]
): CollectionMatch | null {
    const hasLibraryId = libraryId !== undefined && Number.isFinite(libraryId);
    if (hasLibraryId) {
        const hinted = resolveSingleCollection(collectionIdOrName, {
            eligibleLibraryIds: [libraryId],
            nameLibraryIds: [libraryId],
        });
        if (hinted.ok) return hinted.match;
        if (hinted.code !== 'collection_not_found') return null;
    }
    const widened = resolveSingleCollection(collectionIdOrName, {
        eligibleLibraryIds: hasLibraryId ? [libraryId, ...fallbackLibraryIds] : fallbackLibraryIds,
        nameLibraryIds: hasLibraryId ? [libraryId] : fallbackLibraryIds,
    });
    return widened.ok ? widened.match : null;
}

/**
 * Data-path view over {@link resolveSingleCollection}: resolves a collection
 * reference to a single match or null.
 *
 * `libraryId` is a scope hint, not a hard scope — see
 * {@link resolveCollectionWithHint}. A scoped identifier ignores the hint and
 * resolves in its own embedded library. Callers that need to report *why* a
 * reference failed (not found vs ambiguous vs excluded library) should use
 * {@link resolveSingleCollection} directly.
 */
export function getCollectionByIdOrName(
    collectionIdOrName: number | string | null | undefined,
    libraryId?: number
): CollectionLookupResult | null {
    return resolveCollectionWithHint(collectionIdOrName, libraryId, getSearchableLibraryIds());
}

/**
 * Display-only resolution over every local library, used to label persisted
 * chat history with a collection name and to navigate to a collection the user
 * clicked.
 *
 * Every local library is eligible: the exclusion boundary covers reads,
 * indexing, context and writes, not the rendering of history the user already
 * has. Scoping this to the searchable libraries would also drop the name
 * whenever the profile has not loaded yet, since that set is fail-closed.
 *
 * `libraryId` is a scope hint (see {@link resolveCollectionWithHint}); every
 * failure, ambiguity included, returns null so a label renders nothing rather
 * than guessing a target. The hinted step scopes to that one library, so a
 * scoped identifier naming a *different* library still goes through the
 * resolver's exclusion check and renders nothing when that library is excluded.
 */
export function resolveCollectionForDisplay(
    collectionIdOrName: number | string | null | undefined,
    libraryId?: number
): CollectionMatch | null {
    const localLibraryIds = Zotero.Libraries.getAll().map((lib: any) => lib.libraryID as number);
    return resolveCollectionWithHint(collectionIdOrName, libraryId, localLibraryIds);
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
    /**
     * Whether the request named a library (vs defaulting to the user library).
     * Handlers use this to decide whether a reference must resolve inside that
     * library or may resolve in any searchable one.
     */
    wasExplicitlyRequested: boolean;
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
            wasExplicitlyRequested: true,
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
            wasExplicitlyRequested: lookupResult.wasExplicitlyRequested,
            error: excludedLibraryMessage(library.libraryID),
            error_code: 'library_not_searchable',
            available_libraries: getSearchableLibraries(),
        };
    }

    return {
        valid: true,
        wasExplicitlyRequested: lookupResult.wasExplicitlyRequested,
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

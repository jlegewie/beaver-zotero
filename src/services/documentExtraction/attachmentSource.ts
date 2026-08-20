import { effectiveMaxFileSizeMB } from '@beaver/agent-core/transport/attachmentLimits';
import { isRemoteFilePath, makeRemoteFilePath } from '../documentFileIdentity';
import {
    ExternalAbortError,
    TimeoutError,
    awaitWithRequestAbort,
} from '../agentDataProvider/timeout';
import { logger } from '@beaver/agent-core/platform/logger';
import { getPref } from '../../utils/prefs';
import {
    getAttachmentDataInMemory,
    isAttachmentAvailableRemotely,
    type DownloadOptions,
} from '../../utils/webAPI';

export type LocalSizeStrategy = 'zotero-total' | 'stat';

export type AttachmentFileSource =
    | { kind: 'local'; filePath: string; isRemoteOnly: false }
    | { kind: 'remote'; filePath: string; isRemoteOnly: true };

export type AttachmentSourceFailureCode =
    | 'file_missing'
    | 'file_too_large'
    | 'download_failed'
    | 'read_failed';

export type AttachmentSourceResult =
    | { kind: 'ok'; source: AttachmentFileSource }
    | {
          kind: 'error';
          code: Extract<AttachmentSourceFailureCode, 'file_missing' | 'file_too_large'>;
          remoteAvailable?: boolean;
          sizeMB?: number;
          maxMB?: number;
      };

export type AttachmentDataResult =
    | { kind: 'ok'; data: Uint8Array }
    | {
          kind: 'error';
          code: Extract<AttachmentSourceFailureCode, 'file_too_large' | 'download_failed' | 'read_failed'>;
          error?: unknown;
          sizeMB?: number;
          maxMB?: number;
      };

function withDeadline<T>(
    promise: Promise<T>,
    phase: string,
    signal?: AbortSignal,
    throwIfTimedOut?: (phase: string) => void,
): Promise<T> {
    if (signal && throwIfTimedOut) {
        return awaitWithRequestAbort(promise, signal, throwIfTimedOut, phase);
    }
    return promise;
}

/** Check whether remote file access is enabled and the attachment is reachable. */
export function isRemoteAccessAvailable(item: Zotero.Item): boolean {
    return getPref('accessRemoteFiles') && isAttachmentAvailableRemotely(item);
}

function isLinkedFileAttachment(item: Zotero.Item): boolean {
    return item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_FILE;
}

function isLinkedUrlAttachment(item: Zotero.Item): boolean {
    return item.attachmentLinkMode === Zotero.Attachments.LINK_MODE_LINKED_URL;
}

async function getLocalSizeBytes(
    item: Zotero.Item,
    filePath: string,
    strategy: LocalSizeStrategy,
    signal?: AbortSignal,
    throwIfTimedOut?: (phase: string) => void,
): Promise<number | null> {
    if (strategy === 'zotero-total') {
        const size = await withDeadline(
            Zotero.Attachments.getTotalFileSize(item),
            'file_size_check',
            signal,
            throwIfTimedOut,
        );
        return size || null;
    }

    const stat = await withDeadline(
        IOUtils.stat(filePath),
        'file_size_check',
        signal,
        throwIfTimedOut,
    );
    return stat.size ?? null;
}

/** Resolve a Zotero attachment to a local path or supported remote source. */
export async function resolveAttachmentFileSource(args: {
    item: Zotero.Item;
    localSizeStrategy: LocalSizeStrategy;
    signal?: AbortSignal;
    throwIfTimedOut?: (phase: string) => void;
}): Promise<AttachmentSourceResult> {
    const { item, localSizeStrategy, signal, throwIfTimedOut } = args;
    const maxFileSizeMB = effectiveMaxFileSizeMB();

    throwIfTimedOut?.('file_path_lookup');
    const rawFilePath = await withDeadline(
        item.getFilePathAsync(),
        'file_path_lookup',
        signal,
        throwIfTimedOut,
    );
    const filePath = rawFilePath || null;

    if (!filePath) {
        const canUseRemote =
            !isLinkedFileAttachment(item)
            && !isLinkedUrlAttachment(item)
            && isRemoteAccessAvailable(item);
        if (canUseRemote) {
            return {
                kind: 'ok',
                source: {
                    kind: 'remote',
                    filePath: makeRemoteFilePath(item),
                    isRemoteOnly: true,
                },
            };
        }

        return {
            kind: 'error',
            code: 'file_missing',
            remoteAvailable:
                !isLinkedFileAttachment(item)
                && !isLinkedUrlAttachment(item)
                && isAttachmentAvailableRemotely(item),
        };
    }

    if (!isRemoteFilePath(filePath)) {
        const sizeBytes = await getLocalSizeBytes(
            item,
            filePath,
            localSizeStrategy,
            signal,
            throwIfTimedOut,
        );
        if (sizeBytes != null) {
            const sizeMB = sizeBytes / 1024 / 1024;
            if (sizeMB > maxFileSizeMB) {
                return {
                    kind: 'error',
                    code: 'file_too_large',
                    sizeMB,
                    maxMB: maxFileSizeMB,
                };
            }
        }
    }

    return {
        kind: 'ok',
        source: isRemoteFilePath(filePath)
            ? { kind: 'remote', filePath, isRemoteOnly: true }
            : { kind: 'local', filePath, isRemoteOnly: false },
    };
}

const AGENT_DOWNLOAD_OPTIONS: DownloadOptions = {
    errorDelayIntervals: [],
    timeout: 20_000,
};

const remoteDataCache = new Map<string, { data: Uint8Array; ts: number }>();
const remoteInflight = new Map<string, Promise<Uint8Array>>();
const REMOTE_CACHE_TTL_MS = 120_000;
const REMOTE_CACHE_MAX = 10;
// Resident-bytes budget for the cache above. Bounding total bytes rather than
// per-entry size keeps the two properties that matter independent of the
// configured file-size ceiling: memory stays capped however high a user raises
// it, and a file large enough to read is still small enough to cache, so
// successive handlers in one agent turn do not each re-download it.
const REMOTE_CACHE_MAX_TOTAL_BYTES = 1000 * 1024 * 1024;

/**
 * Store a downloaded attachment, evicting expired then oldest entries until it
 * fits both the entry count and the byte budget. A download the caller cannot
 * use, or one larger than the whole budget, is returned but never cached.
 */
function admitToRemoteCache(cacheKey: string, data: Uint8Array): void {
    // Every caller rejects bytes over the configured ceiling — some through
    // `checkAttachmentDataSize` here, the `skipSizeCheck` ones by checking at
    // the call site — so retaining them only holds memory for a re-read that
    // will fail the same way.
    if (data.length > effectiveMaxFileSizeMB() * 1024 * 1024) return;
    if (data.length > REMOTE_CACHE_MAX_TOTAL_BYTES) return;

    const now = Date.now();
    for (const [key, value] of remoteDataCache) {
        if (now - value.ts > REMOTE_CACHE_TTL_MS) remoteDataCache.delete(key);
    }

    let residentBytes = data.length;
    for (const value of remoteDataCache.values()) residentBytes += value.data.length;

    // Map iteration is insertion-ordered, and a cache hit refreshes `ts`
    // without reinserting, so this evicts least-recently-*added* first.
    for (const [key, value] of remoteDataCache) {
        if (remoteDataCache.size < REMOTE_CACHE_MAX && residentBytes <= REMOTE_CACHE_MAX_TOTAL_BYTES) {
            break;
        }
        remoteDataCache.delete(key);
        residentBytes -= value.data.length;
    }

    remoteDataCache.set(cacheKey, { data, ts: now });
}

async function readRemoteAttachmentData(
    item: Zotero.Item,
    onRemoteFailure?: (error: unknown) => void,
): Promise<Uint8Array> {
    const cacheKey = makeRemoteFilePath(item);
    const itemRef = `${item.libraryID}-${item.key}`;

    const cached = remoteDataCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < REMOTE_CACHE_TTL_MS) {
        cached.ts = Date.now();
        logger(`loadAttachmentData: remote cache hit for ${itemRef} (${(cached.data.length / 1024 / 1024).toFixed(2)}MB)`, 3);
        return cached.data;
    }

    const inflight = remoteInflight.get(cacheKey);
    if (inflight) {
        logger(`loadAttachmentData: awaiting in-flight remote download for ${itemRef}`, 3);
        return inflight;
    }

    logger(`loadAttachmentData: downloading remote attachment for ${itemRef}`, 3);
    const startedAt = Date.now();
    const downloadPromise = getAttachmentDataInMemory(item, AGENT_DOWNLOAD_OPTIONS);
    remoteInflight.set(cacheKey, downloadPromise);

    let data: Uint8Array;
    try {
        data = await downloadPromise;
        logger(`loadAttachmentData: downloaded remote attachment for ${itemRef} (${(data.length / 1024 / 1024).toFixed(2)}MB in ${Date.now() - startedAt}ms)`, 3);
    } catch (error) {
        onRemoteFailure?.(error);
        throw error;
    } finally {
        remoteInflight.delete(cacheKey);
    }

    admitToRemoteCache(cacheKey, data);

    return data;
}

/** Check whether in-memory attachment data exceeds the file-size ceiling. */
export function checkAttachmentDataSize(
    data: Uint8Array,
    skipLimits?: boolean,
): { sizeMB: number; maxMB: number } | null {
    if (skipLimits) return null;
    const maxMB = effectiveMaxFileSizeMB();
    const sizeMB = data.length / 1024 / 1024;
    return sizeMB > maxMB ? { sizeMB, maxMB } : null;
}

/** Load bytes from an already-resolved attachment source.
 *
 * `item` is only consulted for remote sources (the download path); local
 * sources (including external files, which are always local) may omit it.
 */
export async function loadAttachmentData(args: {
    item?: Zotero.Item | null;
    source: AttachmentFileSource;
    skipSizeCheck?: boolean;
    onRemoteDownloadFailure?: (error: unknown) => void;
    signal?: AbortSignal;
    throwIfTimedOut?: (phase: string) => void;
}): Promise<AttachmentDataResult> {
    const { item, source, onRemoteDownloadFailure, signal, throwIfTimedOut } = args;

    let data: Uint8Array;
    if (source.kind === 'local') {
        try {
            throwIfTimedOut?.('file_read');
            data = await withDeadline(
                IOUtils.read(source.filePath),
                'file_read',
                signal,
                throwIfTimedOut,
            );
        } catch (error) {
            if (error instanceof TimeoutError || error instanceof ExternalAbortError) {
                throw error;
            }
            return { kind: 'error', code: 'read_failed', error };
        }
    } else {
        if (!item) {
            return {
                kind: 'error',
                code: 'download_failed',
                error: new Error('Remote attachment source requires a Zotero item'),
            };
        }
        try {
            throwIfTimedOut?.('remote_download');
            data = await withDeadline(
                readRemoteAttachmentData(item, onRemoteDownloadFailure),
                'remote_download',
                signal,
                throwIfTimedOut,
            );
        } catch (error) {
            if (error instanceof TimeoutError || error instanceof ExternalAbortError) {
                throw error;
            }
            return { kind: 'error', code: 'download_failed', error };
        }

        const exceeded = checkAttachmentDataSize(data, args.skipSizeCheck);
        if (exceeded) {
            return {
                kind: 'error',
                code: 'file_too_large',
                sizeMB: exceeded.sizeMB,
                maxMB: exceeded.maxMB,
            };
        }
    }

    return { kind: 'ok', data };
}

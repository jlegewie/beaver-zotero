import { effectiveMaxFileSizeMB } from '../attachmentLimits';
import { isRemoteFilePath, makeRemoteFilePath } from '../documentFileIdentity';
import {
    ExternalAbortError,
    TimeoutError,
    awaitWithRequestAbort,
} from '../agentDataProvider/timeout';
import { logger } from '../../utils/logger';
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
    maxFileSizeMB: number;
    localSizeStrategy: LocalSizeStrategy;
    signal?: AbortSignal;
    throwIfTimedOut?: (phase: string) => void;
}): Promise<AttachmentSourceResult> {
    const { item, localSizeStrategy, signal, throwIfTimedOut } = args;
    const maxFileSizeMB = effectiveMaxFileSizeMB(args.maxFileSizeMB);

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

    const defaultMaxMB = effectiveMaxFileSizeMB();
    if ((data.length / 1024 / 1024) <= defaultMaxMB) {
        if (remoteDataCache.size >= REMOTE_CACHE_MAX) {
            const now = Date.now();
            for (const [key, value] of remoteDataCache) {
                if (now - value.ts > REMOTE_CACHE_TTL_MS) remoteDataCache.delete(key);
            }
        }
        if (remoteDataCache.size >= REMOTE_CACHE_MAX) {
            const oldest = remoteDataCache.keys().next().value;
            if (oldest !== undefined) remoteDataCache.delete(oldest);
        }
        remoteDataCache.set(cacheKey, { data, ts: Date.now() });
    }

    return data;
}

/** Check whether in-memory attachment data exceeds a caller's size limit. */
export function checkAttachmentDataSize(
    data: Uint8Array,
    skipLimits?: boolean,
    maxFileSizeMB?: number,
): { sizeMB: number; maxMB: number } | null {
    if (skipLimits) return null;
    const maxMB = effectiveMaxFileSizeMB(maxFileSizeMB);
    const sizeMB = data.length / 1024 / 1024;
    return sizeMB > maxMB ? { sizeMB, maxMB } : null;
}

/** Load bytes from an already-resolved attachment source. */
export async function loadAttachmentData(args: {
    item: Zotero.Item;
    source: AttachmentFileSource;
    maxFileSizeMB: number;
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

        const exceeded = checkAttachmentDataSize(data, args.skipSizeCheck, args.maxFileSizeMB);
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

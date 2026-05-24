import { logger } from '../../utils/logger';
import { getPref } from '../../utils/prefs';
import {
    getAttachmentDataInMemory,
    isAttachmentAvailableRemotely,
} from '../../utils/webAPI';
import { makeRemoteFilePath } from '../documentFileIdentity';

import type { DownloadOptions } from '../../utils/webAPI';

/**
 * Check if remote file access is enabled and the file is reachable on the
 * server.
 */
export function isRemoteAccessAvailable(item: Zotero.Item): boolean {
    return getPref('accessRemoteFiles') && isAttachmentAvailableRemotely(item);
}

const AGENT_DOWNLOAD_OPTIONS: DownloadOptions = {
    errorDelayIntervals: [],   // no retries in agent/background request paths
    timeout: 20_000,
};

const _remoteDataCache = new Map<string, { data: Uint8Array; ts: number }>();
const _remoteInflight = new Map<string, Promise<Uint8Array>>();
const REMOTE_CACHE_TTL_MS = 120_000;
const REMOTE_CACHE_MAX = 10;

/**
 * Load PDF data from local disk or remote storage.
 *
 * Remote downloads are briefly cached in memory to avoid redundant downloads
 * across sequential handler calls.
 */
export async function loadPdfData(
    item: Zotero.Item,
    filePath: string,
    isRemoteOnly: boolean,
    onRemoteFailure?: (error: unknown) => void,
): Promise<Uint8Array> {
    if (!isRemoteOnly) {
        return IOUtils.read(filePath);
    }

    const cacheKey = makeRemoteFilePath(item);
    const itemRef = `${item.libraryID}-${item.key}`;

    const cached = _remoteDataCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < REMOTE_CACHE_TTL_MS) {
        cached.ts = Date.now();
        logger(`loadPdfData: remote cache hit for ${itemRef} (${(cached.data.length / 1024 / 1024).toFixed(2)}MB)`, 3);
        return cached.data;
    }

    const inflight = _remoteInflight.get(cacheKey);
    if (inflight) {
        logger(`loadPdfData: awaiting in-flight remote download for ${itemRef}`, 3);
        return inflight;
    }

    logger(`loadPdfData: downloading remote PDF for ${itemRef}`, 3);
    const startedAt = Date.now();
    const downloadPromise = getAttachmentDataInMemory(item, AGENT_DOWNLOAD_OPTIONS);
    _remoteInflight.set(cacheKey, downloadPromise);

    let data: Uint8Array;
    try {
        data = await downloadPromise;
        logger(`loadPdfData: downloaded remote PDF for ${itemRef} (${(data.length / 1024 / 1024).toFixed(2)}MB in ${Date.now() - startedAt}ms)`, 3);
    } catch (error) {
        onRemoteFailure?.(error);
        throw error;
    } finally {
        _remoteInflight.delete(cacheKey);
    }

    const maxMB = getPref('maxFileSizeMB');
    const withinSizeLimit = (data.length / 1024 / 1024) <= maxMB;

    if (withinSizeLimit) {
        if (_remoteDataCache.size >= REMOTE_CACHE_MAX) {
            const now = Date.now();
            for (const [k, v] of _remoteDataCache) {
                if (now - v.ts > REMOTE_CACHE_TTL_MS) _remoteDataCache.delete(k);
            }
        }
        if (_remoteDataCache.size >= REMOTE_CACHE_MAX) {
            const oldest = _remoteDataCache.keys().next().value;
            if (oldest !== undefined) _remoteDataCache.delete(oldest);
        }
        _remoteDataCache.set(cacheKey, { data, ts: Date.now() });
    }

    return data;
}

/**
 * Check whether remote PDF data exceeds the configured size limit.
 */
export function checkRemotePdfSize(
    data: Uint8Array,
    skipLimits?: boolean,
    maxFileSizeMB?: number,
): { sizeMB: number; maxMB: number } | null {
    if (skipLimits) return null;
    const maxMB = maxFileSizeMB ?? getPref('maxFileSizeMB');
    const sizeMB = data.length / 1024 / 1024;
    return sizeMB > maxMB ? { sizeMB, maxMB } : null;
}

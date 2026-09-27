import { logger } from '@beaver/agent-core/platform/logger';

/** Prefix for synthetic file paths representing remote-only files. */
export const REMOTE_PATH_PREFIX = 'remote:';

export interface FileSignature {
    mtime_ms: number;
    size_bytes: number;
}

export const REMOTE_FILE_SIGNATURE: FileSignature = {
    mtime_ms: 0,
    size_bytes: 0,
};

/** Build a synthetic file path for a remote-only attachment. */
export function makeRemoteFilePath(item: Zotero.Item): string {
    const hash = item.attachmentSyncedHash;
    const id = hash
        ? `h:${hash}`
        : `k:${item.libraryID}-${item.key}-v${item.version || 0}`;
    return `${REMOTE_PATH_PREFIX}${id}`;
}

/** Check if a file path represents a remote-only attachment. */
export function isRemoteFilePath(filePath: string): boolean {
    return filePath.startsWith(REMOTE_PATH_PREFIX);
}

/** Return the freshness signature for a local or synthetic remote path. */
export async function getFileSignature(filePath: string): Promise<FileSignature> {
    if (isRemoteFilePath(filePath)) {
        return { ...REMOTE_FILE_SIGNATURE };
    }
    const stat = await IOUtils.stat(filePath);
    return {
        mtime_ms: stat.lastModified ?? 0,
        size_bytes: stat.size ?? 0,
    };
}

export interface RemoteFileVersion {
    md5: string | null;
    mtime: number | null;
}

/**
 * The server's md5 and modification time for a stored file.
 *
 * Each synced item version carries the server's file md5/mtime, and Zotero keeps
 * the latest one in its sync cache. That is the authoritative value for a file
 * that is not on this computer: `attachmentSyncedHash` /
 * `attachmentSyncedModificationTime` are set only when the file is downloaded or
 * uploaded here, so they are empty for a never-downloaded file and stale for one
 * removed locally before the server copy was replaced. They are the fallback
 * when the cache has no file values.
 */
export async function getRemoteFileVersion(item: Zotero.Item): Promise<RemoteFileVersion> {
    try {
        const local = Zotero.Sync.Data.Local as any;
        const version = await local.getLatestCacheObjectVersion('item', item.libraryID, item.key);
        if (version) {
            const data = (await local.getCacheObject('item', item.libraryID, item.key, version))?.data;
            if (typeof data?.md5 === 'string' && data.md5) {
                return { md5: data.md5, mtime: typeof data.mtime === 'number' ? data.mtime : null };
            }
        }
    } catch (error) {
        logger(`getRemoteFileVersion: sync cache read failed for ${item.libraryID}-${item.key}: ${error}`, 2);
    }
    return {
        md5: item.attachmentSyncedHash || null,
        mtime: item.attachmentSyncedModificationTime || null,
    };
}

/** Content hash of a remote-only file; see `getRemoteFileVersion`. */
export async function getRemoteFileHash(item: Zotero.Item): Promise<string | null> {
    return (await getRemoteFileVersion(item)).md5;
}

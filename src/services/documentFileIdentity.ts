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

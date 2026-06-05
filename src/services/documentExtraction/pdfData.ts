import type { AttachmentFileSource } from './attachmentSource';
import {
    checkAttachmentDataSize,
    isRemoteAccessAvailable,
    loadAttachmentData,
} from './attachmentSource';

export { isRemoteAccessAvailable };

/**
 * Compatibility wrapper for PDF callers. New code should use
 * `loadAttachmentData` with an `AttachmentFileSource`.
 */
export async function loadPdfData(
    item: Zotero.Item,
    filePath: string,
    isRemoteOnly: boolean,
    onRemoteFailure?: (error: unknown) => void,
): Promise<Uint8Array> {
    const source: AttachmentFileSource = isRemoteOnly
        ? { kind: 'remote', filePath, isRemoteOnly: true }
        : { kind: 'local', filePath, isRemoteOnly: false };
    const result = await loadAttachmentData({
        item,
        source,
        maxFileSizeMB: 0,
        skipSizeCheck: true,
        onRemoteDownloadFailure: onRemoteFailure,
    });
    if (result.kind === 'ok') {
        return result.data;
    }
    throw result.error ?? new Error(result.code);
}

/** Compatibility wrapper for existing PDF callers. */
export function checkRemotePdfSize(
    data: Uint8Array,
    skipLimits?: boolean,
    maxFileSizeMB?: number,
): { sizeMB: number; maxMB: number } | null {
    return checkAttachmentDataSize(data, skipLimits, maxFileSizeMB);
}

import type { ExtractContentKind } from './shared/extractionSchemaVersions';
import { expectedExtractionSchemaVersion } from './shared/extractionSchemaVersions';
import { resolveAttachmentFileSource, type AttachmentSourceResult } from './attachmentSource';
import {
    getFileSignature,
    getRemoteFileVersion,
    isRemoteFilePath,
    type FileSignature,
} from '../documentFileIdentity';

export interface SourceObservation {
    identity: string;
    signature: FileSignature | null;
}

/** Cheap identity of extraction inputs; item metadata and reading activity are excluded. */
export async function observeAttachmentSource(
    item: Zotero.Item,
    kind: ExtractContentKind,
    resolved?: AttachmentSourceResult,
): Promise<SourceObservation | null> {
    try {
        const source = resolved ?? await resolveAttachmentFileSource({ item, localSizeStrategy: 'stat' });
        const schema = expectedExtractionSchemaVersion(kind);
        if (source.kind === 'error' && source.code === 'file_missing') {
            return { identity: JSON.stringify([kind, schema, 'missing']), signature: null };
        }
        const path = source.kind === 'ok' ? source.source.filePath : await item.getFilePathAsync();
        if (!path) return null;
        if (isRemoteFilePath(path)) {
            // Synthetic cache paths may contain item.version. That changes on metadata sync
            // too, so only the server's file md5/mtime belongs in the processing identity.
            const remote = await getRemoteFileVersion(item);
            return {
                identity: JSON.stringify([kind, schema, 'remote', remote.md5, remote.mtime]),
                signature: null,
            };
        }
        const signature = await getFileSignature(path);
        return {
            identity: JSON.stringify([kind, schema, path, signature.mtime_ms, signature.size_bytes]),
            signature,
        };
    } catch {
        // A failed stat is not evidence of changed bytes. A later check can try again.
        return null;
    }
}

/**
 * Whether `stored` is a remote identity recorded without the server md5 and
 * `observed` is the same kind and schema with the md5 now known.
 *
 * Remote identities used to be built from the synced-hash fields alone, which
 * are empty until a file is downloaded. Those rows cannot tell whether they were
 * extracted from the current server content. They adopt the observed identity
 * without work; re-extracting every such row at once would download each
 * remote-only file again.
 */
export function isLegacyRemoteIdentity(stored: string, observed: string): boolean {
    try {
        const before = JSON.parse(stored);
        const after = JSON.parse(observed);
        return Array.isArray(before) && Array.isArray(after)
            && before.length === 5 && after.length === 5
            && before[2] === 'remote' && after[2] === 'remote'
            && before[0] === after[0] && before[1] === after[1]
            && before[3] === null && before[4] === null
            && typeof after[3] === 'string';
    } catch {
        return false;
    }
}

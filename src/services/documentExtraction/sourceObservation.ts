import type { ExtractContentKind } from './shared/extractionSchemaVersions';
import { expectedExtractionSchemaVersion } from './shared/extractionSchemaVersions';
import { resolveAttachmentFileSource, type AttachmentSourceResult } from './attachmentSource';
import { getFileSignature, isRemoteFilePath, type FileSignature } from '../documentFileIdentity';

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
            // too, so only the synced file hash/mtime belongs in the processing identity.
            return {
                identity: JSON.stringify([kind, schema, 'remote', item.attachmentSyncedHash || null,
                    item.attachmentSyncedModificationTime || null]),
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

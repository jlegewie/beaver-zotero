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

/** Local file location and signature recorded in a source identity. */
export interface LocalSourceLocation {
    filePath: string;
    mtimeMs: number;
    sizeBytes: number;
}

function parseLocalIdentity(identity: string): { kind: unknown; schema: unknown; location: LocalSourceLocation } | null {
    try {
        const parts = JSON.parse(identity);
        if (!Array.isArray(parts) || parts.length !== 5) return null;
        const [kind, schema, filePath, mtimeMs, sizeBytes] = parts;
        if (typeof filePath !== 'string' || filePath === 'remote') return null;
        if (typeof mtimeMs !== 'number' || typeof sizeBytes !== 'number') return null;
        return { kind, schema, location: { filePath, mtimeMs, sizeBytes } };
    } catch {
        return null;
    }
}

/**
 * The before/after locations when two local identities of the same kind and
 * schema differ only in path and/or mtime, with the same size. Such a change
 * (a rename, a move, or a rewritten mtime) may leave the bytes untouched, so the
 * caller can compare content hashes before treating it as new content.
 */
export function relocatedLocalIdentity(
    stored: string,
    observed: string,
): { from: LocalSourceLocation; to: LocalSourceLocation } | null {
    const before = parseLocalIdentity(stored);
    const after = parseLocalIdentity(observed);
    if (!before || !after) return null;
    if (before.kind !== after.kind || before.schema !== after.schema) return null;
    if (before.location.sizeBytes !== after.location.sizeBytes) return null;
    if (before.location.filePath === after.location.filePath
        && before.location.mtimeMs === after.location.mtimeMs) return null;
    return { from: before.location, to: after.location };
}

/**
 * External files: user-attached files from disk (not Zotero items).
 *
 * At attach time the file is copied into a Beaver-managed folder and recorded
 * in the `external_files` registry table under an 8-character key (the
 * model-facing id is `ext-<KEY>`). All read/view operations use the copy, so
 * later moves/renames/deletions of the original never break old threads. The
 * original path is stored locally for display only and never sent off-device.
 *
 * This module must stay esbuild-safe (no `react/*` value imports). It is also
 * called from webpack-bundled code, so all plugin-state access goes through
 * `Zotero.Beaver` rather than the bare `addon` global.
 */

import { logger } from '../utils/logger';
import { effectiveMaxFileSizeMB } from './attachmentLimits';
import {
    isExternalFileContentKind,
    type ExternalFileContentKind,
    type ExternalFileRecord,
} from './database';
import { getMuPDFWorkerClient } from '../beaver-extract/MuPDFWorkerClient';

/**
 * Sentinel library id used when external files are keyed into structures that
 * expect a (libraryId, zoteroKey) pair (e.g. the document cache). Real Zotero
 * library ids are positive, so -1 can never collide. Mirrors the backend's
 * EXTERNAL_LIBRARY_ID.
 */
export const EXTERNAL_LIBRARY_ID = -1;

/** Result of attempting to attach an external file. */
export type AttachExternalFileResult =
    | { status: 'attached'; record: ExternalFileRecord }
    | {
        status: 'rejected';
        reason: 'not_found' | 'unsupported_type' | 'file_too_large' | 'error';
        message: string;
    };

/** File-picker filter extensions for the supported kinds. */
export const EXTERNAL_FILE_PICKER_EXTENSIONS = [
    '*.pdf', '*.epub', '*.txt', '*.md', '*.markdown',
    '*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.bmp',
];

const EXTENSION_KIND_MAP: Record<string, ExternalFileContentKind> = {
    pdf: 'pdf',
    epub: 'epub',
    txt: 'text',
    md: 'text',
    markdown: 'text',
    png: 'image',
    jpg: 'image',
    jpeg: 'image',
    gif: 'image',
    webp: 'image',
    bmp: 'image',
};

const EXTENSION_MIME_MAP: Record<string, string> = {
    pdf: 'application/pdf',
    epub: 'application/epub+zip',
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
};

/**
 * Map a MIME type to the external-file content kind, mirroring
 * `getReadableContentKind` for Zotero attachments: pdf, epub, image/* and
 * text/* are supported; text/html is excluded (HTML is only supported as
 * Zotero snapshots) as are all other types.
 */
export function contentKindFromMime(mimeType: string | null | undefined): ExternalFileContentKind | null {
    const mime = (mimeType || '').toLowerCase().split(';')[0].trim();
    if (!mime) return null;
    if (mime === 'application/pdf') return 'pdf';
    if (mime === 'application/epub+zip') return 'epub';
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return null;
    if (mime.startsWith('text/')) return 'text';
    return null;
}

function fileExtension(filename: string): string {
    const dot = filename.lastIndexOf('.');
    if (dot <= 0 || dot === filename.length - 1) return '';
    return filename.slice(dot + 1).toLowerCase();
}

/** Folder holding the managed copies of attached external files. */
export function getExternalFilesDir(): string {
    return PathUtils.join(Zotero.DataDirectory.dir, 'beaver', 'external-files');
}

function getDB() {
    const db = Zotero.Beaver?.db;
    if (!db) {
        throw new Error('Beaver database is not available');
    }
    return db;
}

async function generateUniqueExtKey(): Promise<string> {
    const db = getDB();
    for (let attempt = 0; attempt < 5; attempt++) {
        const key = Zotero.Utilities.generateObjectKey() as string;
        if (!(await db.getExternalFileByKey(key))) {
            return key;
        }
    }
    throw new Error('Failed to generate a unique external file key');
}

/**
 * Resolve content kind and MIME type for a source file. Prefers Zotero's
 * content-sniffing MIME detection, falling back to the file extension.
 */
async function resolveKindAndMime(
    sourcePath: string,
    filename: string,
): Promise<{ contentKind: ExternalFileContentKind; mimeType: string } | null> {
    const extension = fileExtension(filename);
    let detectedMime: string | null = null;
    try {
        detectedMime = await Zotero.MIME.getMIMETypeFromFile(sourcePath);
    } catch (error) {
        logger(`externalFiles: MIME detection failed for '${filename}': ${error}`, 2);
    }

    let kind = contentKindFromMime(detectedMime);
    let mime = detectedMime || '';
    if (!kind && extension in EXTENSION_KIND_MAP) {
        // MIME sniffing can return generic types (e.g. application/octet-stream
        // or text/plain for markdown); trust a known extension as fallback.
        kind = EXTENSION_KIND_MAP[extension];
        mime = EXTENSION_MIME_MAP[extension];
    }
    if (!kind) return null;
    if (!mime) mime = EXTENSION_MIME_MAP[extension] || 'application/octet-stream';
    return { contentKind: kind, mimeType: mime };
}

/**
 * Best-effort PDF page count, written to the registry after the attach
 * completes. Failures are logged and never surface to the caller.
 */
function schedulePageCount(record: ExternalFileRecord): void {
    (async () => {
        const data = await IOUtils.read(record.storedPath);
        const count = await getMuPDFWorkerClient().getPageCount(data);
        if (Number.isFinite(count) && count > 0) {
            await getDB().setExternalFilePageCount(record.extKey, count);
            record.pageCount = count;
        }
    })().catch((error) => {
        logger(`externalFiles: page count failed for ${record.extKey} ('${record.filename}'): ${error}`, 2);
    });
}

/**
 * Attach an external file: validate kind and size, copy it into the managed
 * folder, and record it in the registry.
 *
 * Accepts either a path string (file picker) or an object with a `path`
 * property (`nsIFile` from drag-and-drop).
 */
export async function attachExternalFile(
    source: string | { path: string },
): Promise<AttachExternalFileResult> {
    try {
        const sourcePath = typeof source === 'string' ? source : source.path;
        const filename = PathUtils.filename(sourcePath);

        if (!(await IOUtils.exists(sourcePath))) {
            return { status: 'rejected', reason: 'not_found', message: `File not found: ${filename}` };
        }
        const stat = await IOUtils.stat(sourcePath);
        if ((stat.type as string) === 'directory') {
            return { status: 'rejected', reason: 'unsupported_type', message: `Folders are not supported: ${filename}` };
        }

        const resolved = await resolveKindAndMime(sourcePath, filename);
        if (!resolved || !isExternalFileContentKind(resolved.contentKind)) {
            return {
                status: 'rejected',
                reason: 'unsupported_type',
                message: `Unsupported file type: ${filename}`,
            };
        }

        const maxSizeMB = effectiveMaxFileSizeMB();
        const sizeBytes = stat.size ?? 0;
        if (sizeBytes > maxSizeMB * 1024 * 1024) {
            return {
                status: 'rejected',
                reason: 'file_too_large',
                message: `File too large: ${filename} (max ${maxSizeMB} MB)`,
            };
        }

        const extKey = await generateUniqueExtKey();
        const extension = fileExtension(filename);
        const storedDir = getExternalFilesDir();
        await IOUtils.makeDirectory(storedDir, { createAncestors: true, ignoreExisting: true });
        const storedPath = PathUtils.join(storedDir, extension ? `${extKey}.${extension}` : extKey);
        await IOUtils.copy(sourcePath, storedPath);
        const storedStat = await IOUtils.stat(storedPath);

        const record: ExternalFileRecord = {
            extKey,
            filename,
            originalPath: sourcePath,
            storedPath,
            contentKind: resolved.contentKind,
            mimeType: resolved.mimeType,
            fileSize: storedStat.size ?? sizeBytes,
            mtimeMs: storedStat.lastModified ?? 0,
            pageCount: null,
            createdAt: new Date().toISOString(),
        };
        await getDB().upsertExternalFile(record);

        if (record.contentKind === 'pdf') {
            schedulePageCount(record);
        }

        logger(`externalFiles: attached '${filename}' as ext-${extKey} (${record.contentKind}, ${record.fileSize} bytes)`, 3);
        return { status: 'attached', record };
    } catch (error) {
        logger(`externalFiles: attach failed: ${error}`, 1);
        return { status: 'rejected', reason: 'error', message: 'Failed to attach file' };
    }
}

/**
 * Look up an external file and verify its managed copy still exists on this
 * device. Returns a structured miss so callers can produce the
 * "attached on a different computer" error for the model.
 */
export async function resolveExternalFile(
    extKey: string,
): Promise<
    | { ok: true; record: ExternalFileRecord }
    | { ok: false; record: ExternalFileRecord | null }
> {
    const record = await getDB().getExternalFileByKey(extKey);
    if (!record) return { ok: false, record: null };
    const exists = await IOUtils.exists(record.storedPath).catch(() => false);
    if (!exists) return { ok: false, record };
    return { ok: true, record };
}

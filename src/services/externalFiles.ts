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
import { createAbortController } from '../utils/abortController';
import { effectiveMaxFileSizeMB } from './attachmentLimits';
import {
    isExternalFileContentKind,
    type ExternalFileContentKind,
    type ExternalFileRecord,
} from './database';
import { getMuPDFWorkerClient } from '../beaver-extract/MuPDFWorkerClient';
import { MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS } from './agentDataProvider/timeout';

/**
 * Internal deadline for the external-file PDF worker probes (page count and OCR
 * needs). Each probe runs on the shared hot MuPDF worker, so it must never age
 * a worker op past that worker's busy-age lease. The deadline equals the
 * interactive hot-slot ceiling (MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS), which is
 * kept at or below that lease; on expiry the worker call aborts and each
 * caller's existing failure handling applies (page count stays null; the OCR
 * check fails open).
 */
const PDF_WORKER_PROBE_DEADLINE_MS = MAX_INTERACTIVE_PDF_TIMEOUT_SECONDS * 1000;

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
        reason: 'not_found' | 'unsupported_type' | 'file_too_large' | 'requires_vision' | 'requires_ocr' | 'error';
        message: string;
    };

export interface AttachExternalFileOptions {
    supportsVision?: boolean;
    canHandleOCRLocally?: boolean;
}

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
        const controller = createAbortController();
        const timer = setTimeout(() => controller.abort(), PDF_WORKER_PROBE_DEADLINE_MS);
        try {
            const count = await getMuPDFWorkerClient().getPageCount(data, controller.signal);
            if (Number.isFinite(count) && count > 0) {
                await getDB().setExternalFilePageCount(record.extKey, count);
                record.pageCount = count;
            }
        } finally {
            clearTimeout(timer);
        }
    })().catch((error) => {
        logger(`externalFiles: page count failed for ${record.extKey} ('${record.filename}'): ${error}`, 2);
    });
}

/**
 * Reject scanned PDFs up front when neither model vision nor plus tools can
 * provide OCR for the attached file.
 */
async function checkPdfOcrCompatibility(
    sourcePath: string,
    filename: string,
    options: AttachExternalFileOptions,
): Promise<AttachExternalFileResult | null> {
    if (options.canHandleOCRLocally !== false) return null;
    // Everything that can fail stays inside the try so this check keeps failing
    // open: an unreadable file or an expired probe must not block the attach.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const controller = createAbortController();
        timer = setTimeout(() => controller.abort(), PDF_WORKER_PROBE_DEADLINE_MS);
        const data = await IOUtils.read(sourcePath);
        const ocr = await getMuPDFWorkerClient().analyzeOCRNeeds(data, undefined, controller.signal);
        if (ocr.needsOCR) {
            return {
                status: 'rejected',
                reason: 'requires_ocr',
                message: `PDF requires OCR and the selected model cannot read it: ${filename}`,
            };
        }
    } catch (error) {
        logger(`externalFiles: OCR compatibility check failed for '${filename}': ${error}`, 2);
    } finally {
        clearTimeout(timer);
    }
    return null;
}

/**
 * SHA-256 of a file's content (hex). Returns null on failure — attaches then
 * proceed without deduplication rather than failing.
 */
async function computeFileSha256(sourcePath: string): Promise<string | null> {
    try {
        return await IOUtils.computeHexDigest(sourcePath, 'sha256');
    } catch (error) {
        logger(`externalFiles: hashing failed for '${sourcePath}': ${error}`, 2);
        return null;
    }
}

/**
 * Reuse an existing registry row for identical content (same SHA-256).
 *
 * Refreshes the display fields to the latest attach (message attachments
 * snapshot their own filename, so past threads are unaffected) and re-copies
 * the source to the original stored path when the managed copy has been
 * deleted — which also heals `ext-<KEY>` reads in older threads.
 */
async function reuseExternalFile(
    existing: ExternalFileRecord,
    sourcePath: string,
    filename: string,
): Promise<ExternalFileRecord | null> {
    const copyExists = await IOUtils.exists(existing.storedPath).catch(() => false);
    if (!copyExists) {
        try {
            await IOUtils.makeDirectory(getExternalFilesDir(), { createAncestors: true, ignoreExisting: true });
            await IOUtils.copy(sourcePath, existing.storedPath);
        } catch (error) {
            logger(`externalFiles: re-copy for dedup hit ext-${existing.extKey} failed: ${error}`, 2);
            return null;
        }
    }
    const storedStat = await IOUtils.stat(existing.storedPath);
    const record: ExternalFileRecord = {
        ...existing,
        filename,
        originalPath: sourcePath,
        fileSize: storedStat.size ?? existing.fileSize,
        mtimeMs: storedStat.lastModified ?? existing.mtimeMs,
    };
    await getDB().upsertExternalFile(record);
    logger(
        `externalFiles: dedup hit — '${filename}' matches ext-${record.extKey}`
        + `${copyExists ? '' : ' (managed copy restored)'}`,
        3,
    );
    return record;
}

/**
 * Attach an external file: validate kind and size, copy it into the managed
 * folder, and record it in the registry. Identical content (same SHA-256)
 * reuses the existing registry row and copy, so repeat attaches keep one
 * stable `ext-<KEY>` id and stay warm in the document caches.
 *
 * Accepts either a path string (file picker) or an object with a `path`
 * property (`nsIFile` from drag-and-drop).
 */
export async function attachExternalFile(
    source: string | { path: string },
    options: AttachExternalFileOptions = {},
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
        if (resolved.contentKind === 'image' && options.supportsVision === false) {
            return {
                status: 'rejected',
                reason: 'requires_vision',
                message: `Images require a model with vision support: ${filename}`,
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
        if (resolved.contentKind === 'pdf') {
            const ocrRejection = await checkPdfOcrCompatibility(sourcePath, filename, options);
            if (ocrRejection) return ocrRejection;
        }

        // Deduplicate by content hash: identical bytes reuse the existing
        // key/copy (best-effort — a failed hash just skips dedup).
        const sha256 = await computeFileSha256(sourcePath);
        if (sha256) {
            const existing = await getDB().getExternalFileBySha256(sha256);
            if (existing) {
                const reused = await reuseExternalFile(existing, sourcePath, filename);
                if (reused) {
                    if (reused.contentKind === 'pdf' && reused.pageCount == null) {
                        schedulePageCount(reused);
                    }
                    return { status: 'attached', record: reused };
                }
            }
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
            sha256,
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

/** Count and total size of the external files registry. */
export async function getExternalFilesStats(): Promise<{ count: number; totalBytes: number }> {
    return getDB().getExternalFileStats();
}

/**
 * Delete all external files: managed copies, registry rows, and the cached
 * extractions keyed under the external sentinel library. Files referenced in
 * past conversations stop being readable by the agent (the designed
 * "not available on this device" degradation); chips and metadata still
 * render from inline message data.
 */
export async function deleteAllExternalFiles(): Promise<{ deletedCount: number }> {
    const db = getDB();
    const { count } = await db.getExternalFileStats();

    // Remove the managed folder wholesale (also sweeps orphaned copies),
    // then recreate it for future attaches.
    const dir = getExternalFilesDir();
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true } as any).catch((error) => {
        logger(`externalFiles: failed to remove external files folder: ${error}`, 1);
    });
    await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true }).catch(() => undefined);

    await db.deleteAllExternalFiles();

    // Drop cached extractions of the deleted files (document cache keys
    // external entries under the sentinel library id).
    await Zotero.Beaver?.documentCache?.invalidateByLibrary(EXTERNAL_LIBRARY_ID)?.catch?.(() => undefined);

    logger(`externalFiles: deleted all external files (${count} registry rows)`, 3);
    return { deletedCount: count };
}

/**
 * Reveal the managed external-files folder in the system file manager,
 * creating it first so the reveal never fails on a fresh profile.
 */
export async function revealExternalFilesDir(): Promise<void> {
    const dir = getExternalFilesDir();
    await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true }).catch(() => undefined);
    await Zotero.File.reveal(dir);
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

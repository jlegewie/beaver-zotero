/**
 * Authorization of local file paths for item import.
 *
 * The plugin is the security boundary: the backend can be told anything by the
 * model (prompt injection, `~/.ssh/…`). A path is importable only if it lies
 * strictly inside a folder the user attached to *that* thread. Authorized
 * folders come from the plugin, never from the request; until conversations
 * can carry attached folders `getAuthorizedFolders` returns none, so every path
 * is refused. Development and staging builds can inject folders for tests.
 *
 * Checks, at resolution and again at write time:
 * - canonical containment: the path and each folder are normalized with
 *   symlinks resolved, and the path must be strictly inside a folder;
 * - no `..` segments, no hidden entries below the folder, regular files only;
 * - PDF or EPUB by content (magic bytes), within the external-file size limit;
 * - at write time, an unchanged size and mtime (no swap after approval).
 */

import { effectiveMaxFileSizeMB } from '@beaver/agent-core/transport/attachmentLimits';

export type PathAuthorization =
    | { ok: true; path: string; filename: string; size: number; mtimeMs: number; mimeType: 'application/pdf' | 'application/epub+zip' }
    | { ok: false; code: 'path_not_authorized' | 'file_not_found' | 'unsupported_type' | 'file_too_large' | 'file_changed'; message: string };

const testFolders = new Map<string, string[]>();

function testSeamEnabled(): boolean {
    return process.env.NODE_ENV === 'development' || process.env.BUILD_ENV === 'staging';
}

/**
 * Inject authorized folders for a thread (`'*'` for every thread). Honored only
 * in development and staging builds; production ignores it.
 */
export function setTestAuthorizedFolders(threadId: string, folders: string[] | null): void {
    if (!testSeamEnabled()) return;
    if (folders && folders.length) testFolders.set(threadId, folders);
    else testFolders.delete(threadId);
}

/** Folders the user attached to `threadId`. None until folder attachments exist. */
export function getAuthorizedFolders(threadId: string | null | undefined): string[] {
    if (!testSeamEnabled()) return [];
    return [...(testFolders.get('*') ?? []), ...(threadId ? testFolders.get(threadId) ?? [] : [])];
}

function nsFile(path: string): any {
    return (Zotero.File as any).pathToFile(path);
}

/** Absolute path with symlinks resolved, or null if it does not exist. */
function canonicalPath(path: string): string | null {
    try {
        const file = nsFile(path);
        if (!file.exists()) return null;
        file.normalize();
        return file.path as string;
    } catch {
        return null;
    }
}

function segments(path: string): string[] {
    return path.split(/[\\/]+/).filter(Boolean);
}

function isInside(child: string, folder: string): boolean {
    const sep = child.includes('\\') && !child.includes('/') ? '\\' : '/';
    const base = folder.endsWith(sep) ? folder : folder + sep;
    return child.startsWith(base) && child.length > base.length;
}

async function sniffMimeType(path: string): Promise<'application/pdf' | 'application/epub+zip' | null> {
    const head: Uint8Array = await IOUtils.read(path, { maxBytes: 64 });
    const text = String.fromCharCode(...Array.from(head));
    if (text.startsWith('%PDF-')) return 'application/pdf';
    if (text.startsWith('PK\u0003\u0004') && text.includes('mimetypeapplication/epub+zip')) return 'application/epub+zip';
    return null;
}

/**
 * Authorize `rawPath` for `threadId`. `expected` (size/mtime recorded at
 * resolution) makes a changed file fail with `file_changed`.
 * `folders` overrides the thread's authorized folders (callers that already resolved them).
 */
export async function authorizePath(
    rawPath: string,
    options: { threadId?: string | null; expected?: { size?: number; mtime_ms?: number }; folders?: string[] } = {},
): Promise<PathAuthorization> {
    const denied = (message: string): PathAuthorization => ({ ok: false, code: 'path_not_authorized', message });
    if (typeof rawPath !== 'string' || !rawPath.trim()) return denied('No path given.');
    const path = rawPath.trim();
    if (!/^(\/|[A-Za-z]:[\\/])/.test(path)) return denied('Only absolute paths can be imported.');
    if (segments(path).some((segment) => segment === '..' || segment === '.')) {
        return denied('Paths with relative segments cannot be imported.');
    }

    const folders = (options.folders ?? getAuthorizedFolders(options.threadId))
        .map(canonicalPath)
        .filter((folder): folder is string => !!folder);
    if (!folders.length) {
        return denied('Local paths are not authorized for this conversation. Ask the user to attach the file.');
    }

    const canonical = canonicalPath(path);
    if (!canonical) return { ok: false, code: 'file_not_found', message: 'The file does not exist.' };
    const folder = folders.find((candidate) => isInside(canonical, candidate));
    if (!folder) return denied('The file is not inside a folder attached to this conversation.');
    // Hidden entries below the attached folder are refused; the folder itself
    // may live under a hidden directory the user chose to attach.
    if (segments(canonical.slice(folder.length)).some((segment) => segment.startsWith('.'))) {
        return denied('Hidden files and folders cannot be imported.');
    }

    const file = nsFile(canonical);
    if (!file.isFile()) return denied('Only regular files can be imported.');
    const size = Number(file.fileSize);
    const mtimeMs = Number(file.lastModifiedTime);
    const maxBytes = effectiveMaxFileSizeMB() * 1024 * 1024;
    if (size > maxBytes) {
        return { ok: false, code: 'file_too_large', message: `The file is larger than ${effectiveMaxFileSizeMB()} MB.` };
    }
    const mimeType = await sniffMimeType(canonical);
    if (!mimeType) return { ok: false, code: 'unsupported_type', message: 'Only PDF and EPUB files can be imported from a path.' };

    const expected = options.expected;
    if (expected && ((expected.size !== undefined && expected.size !== size)
        || (expected.mtime_ms !== undefined && Math.abs(expected.mtime_ms - mtimeMs) > 1))) {
        return { ok: false, code: 'file_changed', message: 'The file changed after it was approved. Import it again.' };
    }

    return { ok: true, path: canonical, filename: file.leafName as string, size, mtimeMs, mimeType };
}

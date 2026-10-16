import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/transport/attachmentLimits', () => ({ effectiveMaxFileSizeMB: () => 1 }));

import {
    authorizePath,
    getAuthorizedFolders,
    setTestAuthorizedFolders,
} from '../../../src/services/itemImport/pathAccess';

interface FakeEntry {
    kind: 'file' | 'dir';
    size?: number;
    mtime?: number;
    /** Where normalize() resolves to (a symlink target). */
    realPath?: string;
    head?: string;
}

let fs: Map<string, FakeEntry>;
const originalNodeEnv = process.env.NODE_ENV;
const originalBuildEnv = process.env.BUILD_ENV;

const PDF_HEAD = '%PDF-1.7\n';
const EPUB_HEAD = 'PK\u0003\u0004' + '\u0000'.repeat(26) + 'mimetypeapplication/epub+zip';

function file(path: string, entry: Partial<FakeEntry> = {}) {
    fs.set(path, { kind: 'file', size: 1000, mtime: 5000, head: PDF_HEAD, ...entry });
}

beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'development';
    delete process.env.BUILD_ENV;
    setTestAuthorizedFolders('*', null);
    setTestAuthorizedFolders('t1', null);
    fs = new Map([['/home/user/papers', { kind: 'dir' }]]);
    (Zotero.File as any).pathToFile = vi.fn((path: string) => {
        let current = path;
        return {
            get path() { return current; },
            exists: () => fs.has(current),
            normalize: () => { current = fs.get(current)?.realPath ?? current; },
            isFile: () => fs.get(current)?.kind === 'file',
            get fileSize() { return fs.get(current)?.size ?? 0; },
            get lastModifiedTime() { return fs.get(current)?.mtime ?? 0; },
            get leafName() { return current.split('/').pop(); },
        };
    });
    (globalThis as any).IOUtils.read = vi.fn(async (path: string) => {
        const head = fs.get(path)?.head ?? '';
        return Uint8Array.from(Array.from(head).map((char) => char.charCodeAt(0)));
    });
});

afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalBuildEnv === undefined) delete process.env.BUILD_ENV;
    else process.env.BUILD_ENV = originalBuildEnv;
});

describe('authorized folder test seam', () => {
    it('returns folders for the thread plus the wildcard in development', () => {
        setTestAuthorizedFolders('*', ['/a']);
        setTestAuthorizedFolders('t1', ['/b']);
        expect(getAuthorizedFolders('t1')).toEqual(['/a', '/b']);
        expect(getAuthorizedFolders('other')).toEqual(['/a']);
        expect(getAuthorizedFolders(null)).toEqual(['/a']);
    });

    it('clears a thread entry with null or an empty list', () => {
        setTestAuthorizedFolders('t1', ['/b']);
        setTestAuthorizedFolders('t1', []);
        expect(getAuthorizedFolders('t1')).toEqual([]);
    });

    it('honors the seam in staging builds', () => {
        process.env.NODE_ENV = 'production';
        process.env.BUILD_ENV = 'staging';
        setTestAuthorizedFolders('t1', ['/b']);
        expect(getAuthorizedFolders('t1')).toEqual(['/b']);
    });

    it('ignores injection and returns no folders in production builds', () => {
        process.env.NODE_ENV = 'development';
        setTestAuthorizedFolders('t1', ['/b']);
        process.env.NODE_ENV = 'production';
        setTestAuthorizedFolders('t1', ['/c']);
        expect(getAuthorizedFolders('t1')).toEqual([]);
        process.env.NODE_ENV = 'test';
        expect(getAuthorizedFolders('t1')).toEqual([]);
    });
});

describe('authorizePath', () => {
    const folders = ['/home/user/papers'];

    it('refuses every path when the thread has no authorized folders', async () => {
        file('/home/user/papers/a.pdf');
        const result = await authorizePath('/home/user/papers/a.pdf', { threadId: 't1' });
        expect(result).toMatchObject({ ok: false, code: 'path_not_authorized' });
    });

    it('authorizes a PDF inside the thread\'s folder and reports its facts', async () => {
        setTestAuthorizedFolders('t1', folders);
        file('/home/user/papers/a.pdf', { size: 1234, mtime: 9999 });
        const result = await authorizePath('/home/user/papers/a.pdf', { threadId: 't1' });
        expect(result).toEqual({
            ok: true,
            path: '/home/user/papers/a.pdf',
            filename: 'a.pdf',
            size: 1234,
            mtimeMs: 9999,
            mimeType: 'application/pdf',
        });
    });

    it('does not authorize a folder attached to another thread', async () => {
        setTestAuthorizedFolders('t2', folders);
        file('/home/user/papers/a.pdf');
        expect(await authorizePath('/home/user/papers/a.pdf', { threadId: 't1' })).toMatchObject({ ok: false, code: 'path_not_authorized' });
    });

    it('recognizes an EPUB by content', async () => {
        file('/home/user/papers/b.epub', { head: EPUB_HEAD });
        const result = await authorizePath('/home/user/papers/b.epub', { folders });
        expect(result).toMatchObject({ ok: true, mimeType: 'application/epub+zip' });
    });

    it('uses explicit folders over the thread lookup', async () => {
        setTestAuthorizedFolders('t1', ['/elsewhere']);
        file('/home/user/papers/a.pdf');
        expect((await authorizePath('/home/user/papers/a.pdf', { threadId: 't1', folders })).ok).toBe(true);
    });

    it.each([
        ['', 'No path'],
        ['   ', 'No path'],
        ['papers/a.pdf', 'absolute'],
        ['./a.pdf', 'absolute'],
        ['/home/user/papers/../secret.pdf', 'relative segments'],
        ['/home/user/./papers/a.pdf', 'relative segments'],
    ])('rejects %j before touching the filesystem', async (path, message) => {
        const result = await authorizePath(path, { folders });
        expect(result).toMatchObject({ ok: false, code: 'path_not_authorized' });
        expect((result as any).message).toContain(message);
        expect((Zotero.File as any).pathToFile).not.toHaveBeenCalled();
    });

    it.each([
        '/home/user/papers/.hidden/a.pdf',
        '/home/user/papers/.a.pdf',
    ])('rejects the hidden entry %j below the attached folder', async (path) => {
        file(path);
        const result = await authorizePath(path, { folders });
        expect(result).toMatchObject({ ok: false, code: 'path_not_authorized' });
        expect((result as any).message).toContain('Hidden');
    });

    it('accepts files in an attached folder that itself sits under a hidden directory', async () => {
        fs.set('/home/user/.local/papers', { kind: 'dir' });
        file('/home/user/.local/papers/a.pdf');
        const result = await authorizePath('/home/user/.local/papers/a.pdf', { folders: ['/home/user/.local/papers'] });
        expect(result.ok).toBe(true);
    });

    it('accepts a Windows drive path as absolute', async () => {
        fs.set('C:\\papers', { kind: 'dir' });
        file('C:\\papers\\a.pdf');
        // The fake resolves paths verbatim; leaf names for backslash paths are not split.
        const result = await authorizePath('C:\\papers\\a.pdf', { folders: ['C:\\papers'] });
        expect(result.ok).toBe(true);
    });

    it('reports file_not_found for a missing file', async () => {
        const result = await authorizePath('/home/user/papers/missing.pdf', { folders });
        expect(result).toMatchObject({ ok: false, code: 'file_not_found' });
    });

    it('ignores authorized folders that do not exist', async () => {
        file('/home/user/papers/a.pdf');
        const result = await authorizePath('/home/user/papers/a.pdf', { folders: ['/gone'] });
        expect(result).toMatchObject({ ok: false, code: 'path_not_authorized' });
    });

    it('rejects a file outside the authorized folder', async () => {
        fs.set('/home/user/other', { kind: 'dir' });
        file('/home/user/other/a.pdf');
        const result = await authorizePath('/home/user/other/a.pdf', { folders });
        expect(result).toMatchObject({ ok: false, code: 'path_not_authorized' });
        expect((result as any).message).toContain('not inside a folder');
    });

    it('rejects a sibling folder sharing the authorized folder\'s name as a prefix', async () => {
        fs.set('/home/user/papers-private', { kind: 'dir' });
        file('/home/user/papers-private/a.pdf');
        expect(await authorizePath('/home/user/papers-private/a.pdf', { folders })).toMatchObject({ ok: false, code: 'path_not_authorized' });
    });

    it('rejects the authorized folder itself', async () => {
        expect(await authorizePath('/home/user/papers', { folders })).toMatchObject({ ok: false, code: 'path_not_authorized' });
    });

    it('rejects a symlink inside the folder that resolves outside it', async () => {
        file('/etc/secret.pdf');
        file('/home/user/papers/link.pdf', { realPath: '/etc/secret.pdf' });
        const result = await authorizePath('/home/user/papers/link.pdf', { folders });
        expect(result).toMatchObject({ ok: false, code: 'path_not_authorized' });
    });

    it('rejects a symlink that resolves into a hidden location', async () => {
        file('/home/user/papers/.ssh/key.pdf');
        file('/home/user/papers/link.pdf', { realPath: '/home/user/papers/.ssh/key.pdf' });
        const result = await authorizePath('/home/user/papers/link.pdf', { folders });
        expect(result).toMatchObject({ ok: false, code: 'path_not_authorized' });
        expect((result as any).message).toContain('Hidden');
    });

    it('allows a symlinked authorized folder by comparing canonical paths', async () => {
        fs.set('/mnt/data/papers', { kind: 'dir' });
        fs.set('/home/user/papers', { kind: 'dir', realPath: '/mnt/data/papers' });
        file('/mnt/data/papers/a.pdf');
        const result = await authorizePath('/mnt/data/papers/a.pdf', { folders });
        expect(result.ok).toBe(true);
    });

    it('rejects a directory', async () => {
        fs.set('/home/user/papers/sub', { kind: 'dir' });
        const result = await authorizePath('/home/user/papers/sub', { folders });
        expect(result).toMatchObject({ ok: false, code: 'path_not_authorized' });
        expect((result as any).message).toContain('regular files');
    });

    it('rejects content that is neither PDF nor EPUB even with a .pdf name', async () => {
        file('/home/user/papers/fake.pdf', { head: 'MZ\u0090\u0000 executable' });
        expect(await authorizePath('/home/user/papers/fake.pdf', { folders })).toMatchObject({ ok: false, code: 'unsupported_type' });
    });

    it('rejects a zip that is not an EPUB', async () => {
        file('/home/user/papers/a.zip', { head: 'PK\u0003\u0004' + 'x'.repeat(30) });
        expect(await authorizePath('/home/user/papers/a.zip', { folders })).toMatchObject({ ok: false, code: 'unsupported_type' });
    });

    it('rejects a file over the size limit before reading it', async () => {
        file('/home/user/papers/big.pdf', { size: 1024 * 1024 + 1 });
        const result = await authorizePath('/home/user/papers/big.pdf', { folders });
        expect(result).toMatchObject({ ok: false, code: 'file_too_large' });
        expect((globalThis as any).IOUtils.read).not.toHaveBeenCalled();
    });

    it('accepts a file exactly at the size limit', async () => {
        file('/home/user/papers/edge.pdf', { size: 1024 * 1024 });
        expect((await authorizePath('/home/user/papers/edge.pdf', { folders })).ok).toBe(true);
    });

    describe('recheck against recorded size and mtime', () => {
        beforeEach(() => file('/home/user/papers/a.pdf', { size: 1000, mtime: 5000 }));

        it('passes when size and mtime match', async () => {
            const result = await authorizePath('/home/user/papers/a.pdf', { folders, expected: { size: 1000, mtime_ms: 5000 } });
            expect(result.ok).toBe(true);
        });

        it('tolerates a one millisecond mtime difference', async () => {
            const result = await authorizePath('/home/user/papers/a.pdf', { folders, expected: { size: 1000, mtime_ms: 5001 } });
            expect(result.ok).toBe(true);
        });

        it('reports file_changed when the size differs', async () => {
            const result = await authorizePath('/home/user/papers/a.pdf', { folders, expected: { size: 999 } });
            expect(result).toMatchObject({ ok: false, code: 'file_changed' });
        });

        it('reports file_changed when the mtime differs', async () => {
            const result = await authorizePath('/home/user/papers/a.pdf', { folders, expected: { mtime_ms: 4000 } });
            expect(result).toMatchObject({ ok: false, code: 'file_changed' });
        });

        it('ignores an expectation with neither value', async () => {
            expect((await authorizePath('/home/user/papers/a.pdf', { folders, expected: {} })).ok).toBe(true);
        });
    });
});

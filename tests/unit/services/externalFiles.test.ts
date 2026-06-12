import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

const getPageCountMock = vi.fn().mockResolvedValue(12);
vi.mock('../../../src/beaver-extract/MuPDFWorkerClient', () => ({
    getMuPDFWorkerClient: vi.fn(() => ({ getPageCount: getPageCountMock })),
}));

import {
    attachExternalFile,
    contentKindFromMime,
    getExternalFilesDir,
    resolveExternalFile,
} from '../../../src/services/externalFiles';

const db = {
    upsertExternalFile: vi.fn().mockResolvedValue(undefined),
    getExternalFileByKey: vi.fn().mockResolvedValue(null),
    setExternalFilePageCount: vi.fn().mockResolvedValue(undefined),
};

function setupGlobals({
    mime = 'application/pdf',
    fileExists = true,
    size = 1024,
    generateKey = 'ABCD2345',
}: { mime?: string | null; fileExists?: boolean; size?: number; generateKey?: string } = {}) {
    const io = (globalThis as any).IOUtils;
    io.exists = vi.fn().mockResolvedValue(fileExists);
    io.stat = vi.fn().mockResolvedValue({ size, lastModified: 1718000000000, type: 'regular' });
    io.copy = vi.fn().mockResolvedValue(undefined);
    io.makeDirectory = vi.fn().mockResolvedValue(undefined);
    io.read = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]));

    const zotero = (globalThis as any).Zotero;
    zotero.DataDirectory = { dir: '/mock/data' };
    zotero.MIME = { getMIMETypeFromFile: vi.fn().mockResolvedValue(mime) };
    zotero.Utilities.generateObjectKey = vi.fn(() => generateKey);
    zotero.Beaver = { db };
}

describe('externalFiles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        db.getExternalFileByKey.mockResolvedValue(null);
        getPageCountMock.mockResolvedValue(12);
    });

    describe('contentKindFromMime', () => {
        it('maps supported mime types to kinds', () => {
            expect(contentKindFromMime('application/pdf')).toBe('pdf');
            expect(contentKindFromMime('application/epub+zip')).toBe('epub');
            expect(contentKindFromMime('image/png')).toBe('image');
            expect(contentKindFromMime('image/webp')).toBe('image');
            expect(contentKindFromMime('text/plain')).toBe('text');
            expect(contentKindFromMime('text/markdown; charset=utf-8')).toBe('text');
        });

        it('rejects html and unknown types', () => {
            expect(contentKindFromMime('text/html')).toBeNull();
            expect(contentKindFromMime('application/xhtml+xml')).toBeNull();
            expect(contentKindFromMime('application/msword')).toBeNull();
            expect(contentKindFromMime('')).toBeNull();
            expect(contentKindFromMime(null)).toBeNull();
        });
    });

    describe('attachExternalFile', () => {
        it('copies the file, records it, and returns the record', async () => {
            setupGlobals();
            const result = await attachExternalFile('/home/user/paper.pdf');
            expect(result.status).toBe('attached');
            if (result.status !== 'attached') return;
            expect(result.record.extKey).toBe('ABCD2345');
            expect(result.record.filename).toBe('paper.pdf');
            expect(result.record.contentKind).toBe('pdf');
            expect(result.record.storedPath).toBe(`${getExternalFilesDir()}/ABCD2345.pdf`);
            expect(result.record.originalPath).toBe('/home/user/paper.pdf');
            expect((globalThis as any).IOUtils.copy).toHaveBeenCalledWith(
                '/home/user/paper.pdf',
                `${getExternalFilesDir()}/ABCD2345.pdf`,
            );
            expect(db.upsertExternalFile).toHaveBeenCalledOnce();
        });

        it('accepts nsIFile-like sources from drag-and-drop', async () => {
            setupGlobals({ mime: 'image/png', generateKey: 'IMGK2345' });
            const result = await attachExternalFile({ path: '/tmp/figure.png' });
            expect(result.status).toBe('attached');
            if (result.status !== 'attached') return;
            expect(result.record.contentKind).toBe('image');
            expect(result.record.filename).toBe('figure.png');
        });

        it('retries key generation on collision', async () => {
            setupGlobals();
            const keys = ['DUPL2345', 'FRSH2345'];
            (globalThis as any).Zotero.Utilities.generateObjectKey = vi.fn(() => keys.shift());
            db.getExternalFileByKey
                .mockResolvedValueOnce({ extKey: 'DUPL2345' })
                .mockResolvedValueOnce(null);
            const result = await attachExternalFile('/home/user/paper.pdf');
            expect(result.status).toBe('attached');
            if (result.status !== 'attached') return;
            expect(result.record.extKey).toBe('FRSH2345');
        });

        it('rejects unsupported file types', async () => {
            setupGlobals({ mime: 'application/msword' });
            const result = await attachExternalFile('/home/user/report.docx');
            expect(result).toMatchObject({ status: 'rejected', reason: 'unsupported_type' });
            expect((globalThis as any).IOUtils.copy).not.toHaveBeenCalled();
        });

        it('falls back to the extension when MIME sniffing is generic', async () => {
            setupGlobals({ mime: 'application/octet-stream' });
            const result = await attachExternalFile('/home/user/notes.md');
            expect(result.status).toBe('attached');
            if (result.status !== 'attached') return;
            expect(result.record.contentKind).toBe('text');
            expect(result.record.mimeType).toBe('text/markdown');
        });

        it('rejects oversize files', async () => {
            setupGlobals({ size: 101 * 1024 * 1024 });
            const result = await attachExternalFile('/home/user/huge.pdf');
            expect(result).toMatchObject({ status: 'rejected', reason: 'file_too_large' });
        });

        it('rejects missing files', async () => {
            setupGlobals({ fileExists: false });
            const result = await attachExternalFile('/home/user/missing.pdf');
            expect(result).toMatchObject({ status: 'rejected', reason: 'not_found' });
        });

        it('records a page count for PDFs without failing the attach', async () => {
            setupGlobals();
            const result = await attachExternalFile('/home/user/paper.pdf');
            expect(result.status).toBe('attached');
            // Fire-and-forget page count: allow the microtask queue to drain.
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(db.setExternalFilePageCount).toHaveBeenCalledWith('ABCD2345', 12);
        });

        it('swallows page-count failures', async () => {
            setupGlobals();
            getPageCountMock.mockRejectedValue(new Error('worker crashed'));
            const result = await attachExternalFile('/home/user/paper.pdf');
            expect(result.status).toBe('attached');
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(db.setExternalFilePageCount).not.toHaveBeenCalled();
        });
    });

    describe('resolveExternalFile', () => {
        it('returns the record when the copy exists', async () => {
            setupGlobals();
            const record = { extKey: 'ABCD2345', storedPath: '/mock/data/beaver/external-files/ABCD2345.pdf' };
            db.getExternalFileByKey.mockResolvedValue(record);
            const result = await resolveExternalFile('ABCD2345');
            expect(result).toEqual({ ok: true, record });
        });

        it('misses when the registry has no row', async () => {
            setupGlobals();
            db.getExternalFileByKey.mockResolvedValue(null);
            const result = await resolveExternalFile('UNKNOWN1');
            expect(result).toEqual({ ok: false, record: null });
        });

        it('misses when the copy is gone from disk', async () => {
            setupGlobals({ fileExists: false });
            const record = { extKey: 'ABCD2345', storedPath: '/mock/data/beaver/external-files/ABCD2345.pdf' };
            db.getExternalFileByKey.mockResolvedValue(record);
            const result = await resolveExternalFile('ABCD2345');
            expect(result).toEqual({ ok: false, record });
        });
    });
});

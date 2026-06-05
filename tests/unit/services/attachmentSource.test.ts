import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockIsAttachmentAvailableRemotely = vi.fn<(_: Zotero.Item) => boolean>(() => false);
const mockGetAttachmentDataInMemory = vi.fn<
    (_: Zotero.Item, __?: import('../../../src/utils/webAPI').DownloadOptions) => Promise<Uint8Array>
>(async () => new Uint8Array([1, 2, 3]));

vi.mock('../../../src/utils/webAPI', async () => {
    const actual = await vi.importActual<typeof import('../../../src/utils/webAPI')>(
        '../../../src/utils/webAPI',
    );
    return {
        ...actual,
        isAttachmentAvailableRemotely: (
            item: Parameters<typeof actual.isAttachmentAvailableRemotely>[0],
        ) => mockIsAttachmentAvailableRemotely(item),
        getAttachmentDataInMemory: (
            item: Parameters<typeof actual.getAttachmentDataInMemory>[0],
            options?: Parameters<typeof actual.getAttachmentDataInMemory>[1],
        ) => mockGetAttachmentDataInMemory(item, options),
    };
});

import {
    loadAttachmentData,
    resolveAttachmentFileSource,
} from '../../../src/services/documentExtraction/attachmentSource';
import {
    checkRemotePdfSize,
    loadPdfData,
} from '../../../src/services/documentExtraction/pdfData';
import { createTimeoutController, TimeoutError } from '../../../src/services/agentDataProvider/timeout';

function makeAttachment(overrides: Partial<Zotero.Item> = {}): Zotero.Item {
    const key = `KEY${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    return {
        libraryID: 1,
        key,
        version: 1,
        attachmentLinkMode: Zotero.Attachments.LINK_MODE_IMPORTED_FILE,
        attachmentSyncedHash: `hash-${key}`,
        getFilePathAsync: vi.fn().mockResolvedValue('/storage/test.pdf'),
        ...overrides,
    } as Zotero.Item;
}

describe('attachmentSource', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Zotero.Prefs.get = vi.fn().mockReturnValue(true);
        Zotero.Attachments.getTotalFileSize = vi.fn().mockResolvedValue(1024);
        (globalThis as any).IOUtils.stat.mockResolvedValue({ lastModified: 0, size: 1024 });
        (globalThis as any).IOUtils.read.mockResolvedValue(new Uint8Array([1, 2, 3]));
        mockIsAttachmentAvailableRemotely.mockReturnValue(false);
        mockGetAttachmentDataInMemory.mockResolvedValue(new Uint8Array([1, 2, 3]));
    });

    it('uses Zotero total file size for local PDF-style sources', async () => {
        const item = makeAttachment();

        const result = await resolveAttachmentFileSource({
            item,
            maxFileSizeMB: 10,
            localSizeStrategy: 'zotero-total',
        });

        expect(result.kind).toBe('ok');
        expect(Zotero.Attachments.getTotalFileSize).toHaveBeenCalledWith(item);
        expect((globalThis as any).IOUtils.stat).not.toHaveBeenCalled();
    });

    it('uses IOUtils.stat for local text-style sources', async () => {
        const item = makeAttachment({ getFilePathAsync: vi.fn().mockResolvedValue('/storage/test.txt') });

        const result = await resolveAttachmentFileSource({
            item,
            maxFileSizeMB: 10,
            localSizeStrategy: 'stat',
        });

        expect(result.kind).toBe('ok');
        expect((globalThis as any).IOUtils.stat).toHaveBeenCalledWith('/storage/test.txt');
        expect(Zotero.Attachments.getTotalFileSize).not.toHaveBeenCalled();
    });

    it('does not use remote fallback for missing linked-file attachments', async () => {
        const item = makeAttachment({
            attachmentLinkMode: Zotero.Attachments.LINK_MODE_LINKED_FILE,
            getFilePathAsync: vi.fn().mockResolvedValue(null),
        });
        mockIsAttachmentAvailableRemotely.mockReturnValue(true);

        const result = await resolveAttachmentFileSource({
            item,
            maxFileSizeMB: 10,
            localSizeStrategy: 'stat',
        });

        expect(result).toMatchObject({
            kind: 'error',
            code: 'file_missing',
            remoteAvailable: false,
        });
    });

    it('loads a stored remote-only attachment', async () => {
        const item = makeAttachment({
            key: 'REMOTE01',
            getFilePathAsync: vi.fn().mockResolvedValue(null),
        });
        mockIsAttachmentAvailableRemotely.mockReturnValue(true);
        mockGetAttachmentDataInMemory.mockResolvedValue(new Uint8Array([4, 5, 6]));

        const source = await resolveAttachmentFileSource({
            item,
            maxFileSizeMB: 10,
            localSizeStrategy: 'stat',
        });
        expect(source.kind).toBe('ok');
        if (source.kind !== 'ok') throw new Error('source should resolve');

        const data = await loadAttachmentData({
            item,
            source: source.source,
            maxFileSizeMB: 10,
        });

        expect(data).toEqual({ kind: 'ok', data: new Uint8Array([4, 5, 6]) });
        expect(mockGetAttachmentDataInMemory).toHaveBeenCalledWith(
            item,
            expect.objectContaining({ timeout: 20_000 }),
        );
    });

    it('returns file_too_large for local and remote size failures', async () => {
        Zotero.Attachments.getTotalFileSize = vi.fn().mockResolvedValue(11 * 1024 * 1024);
        const local = await resolveAttachmentFileSource({
            item: makeAttachment(),
            maxFileSizeMB: 10,
            localSizeStrategy: 'zotero-total',
        });
        expect(local).toMatchObject({ kind: 'error', code: 'file_too_large' });

        const remoteItem = makeAttachment({
            key: 'REMOTE02',
            getFilePathAsync: vi.fn().mockResolvedValue(null),
        });
        mockIsAttachmentAvailableRemotely.mockReturnValue(true);
        mockGetAttachmentDataInMemory.mockResolvedValue(new Uint8Array(2 * 1024 * 1024));
        const remoteSource = await resolveAttachmentFileSource({
            item: remoteItem,
            maxFileSizeMB: 10,
            localSizeStrategy: 'stat',
        });
        if (remoteSource.kind !== 'ok') throw new Error('remote source should resolve');

        const remote = await loadAttachmentData({
            item: remoteItem,
            source: remoteSource.source,
            maxFileSizeMB: 1,
        });
        expect(remote).toMatchObject({ kind: 'error', code: 'file_too_large' });
    });

    it('legacy PDF loader returns oversized remote bytes for caller-side size classification', async () => {
        const item = makeAttachment({ key: 'REMOTE05' });
        const bytes = new Uint8Array(2 * 1024 * 1024);
        mockGetAttachmentDataInMemory.mockResolvedValue(bytes);

        const loaded = await loadPdfData(item, 'remote:k:1-REMOTE05-v1', true);

        expect(loaded).toBe(bytes);
        expect(checkRemotePdfSize(loaded, false, 1)).toMatchObject({
            sizeMB: 2,
            maxMB: 1,
        });
    });

    it('returns read_failed and download_failed for expected read failures', async () => {
        (globalThis as any).IOUtils.read.mockRejectedValue(new Error('disk failure'));
        const local = await loadAttachmentData({
            item: makeAttachment(),
            source: { kind: 'local', filePath: '/storage/test.txt', isRemoteOnly: false },
            maxFileSizeMB: 10,
        });
        expect(local).toMatchObject({ kind: 'error', code: 'read_failed' });

        mockGetAttachmentDataInMemory.mockRejectedValue(new Error('download failure'));
        const remote = await loadAttachmentData({
            item: makeAttachment({ key: 'REMOTE03' }),
            source: { kind: 'remote', filePath: 'remote:k:1-REMOTE03-v1', isRemoteOnly: true },
            maxFileSizeMB: 10,
        });
        expect(remote).toMatchObject({ kind: 'error', code: 'download_failed' });
    });

    it('classifies timeouts for path lookup, size check, local read, and remote download', async () => {
        vi.useFakeTimers();
        try {
            const pathTimeout = createTimeoutController(1, 10);
            const pathPromise = resolveAttachmentFileSource({
                item: makeAttachment({ getFilePathAsync: vi.fn(() => new Promise(() => {})) }),
                maxFileSizeMB: 10,
                localSizeStrategy: 'stat',
                signal: pathTimeout.signal,
                throwIfTimedOut: pathTimeout.throwIfTimedOut,
            });
            const pathExpectation = expect(pathPromise).rejects.toBeInstanceOf(TimeoutError);
            await vi.advanceTimersByTimeAsync(1000);
            await pathExpectation;
            pathTimeout.dispose();

            const sizeTimeout = createTimeoutController(1, 10);
            (globalThis as any).IOUtils.stat.mockImplementation(() => new Promise(() => {}));
            const sizePromise = resolveAttachmentFileSource({
                item: makeAttachment({ getFilePathAsync: vi.fn().mockResolvedValue('/storage/test.txt') }),
                maxFileSizeMB: 10,
                localSizeStrategy: 'stat',
                signal: sizeTimeout.signal,
                throwIfTimedOut: sizeTimeout.throwIfTimedOut,
            });
            const sizeExpectation = expect(sizePromise).rejects.toBeInstanceOf(TimeoutError);
            await vi.advanceTimersByTimeAsync(1000);
            await sizeExpectation;
            sizeTimeout.dispose();

            const readTimeout = createTimeoutController(1, 10);
            (globalThis as any).IOUtils.read.mockImplementation(() => new Promise(() => {}));
            const readPromise = loadAttachmentData({
                item: makeAttachment(),
                source: { kind: 'local', filePath: '/storage/test.txt', isRemoteOnly: false },
                maxFileSizeMB: 10,
                signal: readTimeout.signal,
                throwIfTimedOut: readTimeout.throwIfTimedOut,
            });
            const readExpectation = expect(readPromise).rejects.toBeInstanceOf(TimeoutError);
            await vi.advanceTimersByTimeAsync(1000);
            await readExpectation;
            readTimeout.dispose();

            const remoteTimeout = createTimeoutController(1, 10);
            mockGetAttachmentDataInMemory.mockImplementation(() => new Promise(() => {}));
            const remotePromise = loadAttachmentData({
                item: makeAttachment({ key: 'REMOTE04' }),
                source: { kind: 'remote', filePath: 'remote:k:1-REMOTE04-v1', isRemoteOnly: true },
                maxFileSizeMB: 10,
                signal: remoteTimeout.signal,
                throwIfTimedOut: remoteTimeout.throwIfTimedOut,
            });
            const remoteExpectation = expect(remotePromise).rejects.toBeInstanceOf(TimeoutError);
            await vi.advanceTimersByTimeAsync(1000);
            await remoteExpectation;
            remoteTimeout.dispose();
        } finally {
            vi.useRealTimers();
        }
    });
});

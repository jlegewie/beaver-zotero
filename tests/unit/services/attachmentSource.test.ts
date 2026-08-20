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
    // The file-size ceiling is read from the preference on every check, so
    // tests set it here instead of passing a per-call limit.
    let maxFileSizeMBPref = 10;

    beforeEach(() => {
        vi.clearAllMocks();
        maxFileSizeMBPref = 10;
        Zotero.Prefs.get = vi.fn((key: string) =>
            key.endsWith('.maxAttachmentFileSizeMB') ? maxFileSizeMBPref : true,
        ) as any;
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
            localSizeStrategy: 'stat',
        });
        expect(source.kind).toBe('ok');
        if (source.kind !== 'ok') throw new Error('source should resolve');

        const data = await loadAttachmentData({
            item,
            source: source.source,
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
            localSizeStrategy: 'stat',
        });
        if (remoteSource.kind !== 'ok') throw new Error('remote source should resolve');

        maxFileSizeMBPref = 1;
        const remote = await loadAttachmentData({
            item: remoteItem,
            source: remoteSource.source,
        });
        expect(remote).toMatchObject({ kind: 'error', code: 'file_too_large' });
    });

    it('legacy PDF loader returns oversized remote bytes for caller-side size classification', async () => {
        const item = makeAttachment({ key: 'REMOTE05' });
        const bytes = new Uint8Array(2 * 1024 * 1024);
        mockGetAttachmentDataInMemory.mockResolvedValue(bytes);

        const loaded = await loadPdfData(item, 'remote:k:1-REMOTE05-v1', true);

        expect(loaded).toBe(bytes);
        maxFileSizeMBPref = 1;
        expect(checkRemotePdfSize(loaded, false)).toMatchObject({
            sizeMB: 2,
            maxMB: 1,
        });
    });

    // Only `.length` is read on the downloaded bytes, so stub the size rather
    // than allocating hundreds of megabytes per case.
    function fakeBytes(sizeMB: number): Uint8Array {
        return { length: sizeMB * 1024 * 1024 } as unknown as Uint8Array;
    }

    async function remoteSourceFor(key: string) {
        const item = makeAttachment({ key, getFilePathAsync: vi.fn().mockResolvedValue(null) });
        mockIsAttachmentAvailableRemotely.mockReturnValue(true);
        const source = await resolveAttachmentFileSource({ item, localSizeStrategy: 'stat' });
        if (source.kind !== 'ok') throw new Error('remote source should resolve');
        return { item, source: source.source };
    }

    it('caches a remote download too large for the default ceiling', async () => {
        maxFileSizeMBPref = 300;
        mockGetAttachmentDataInMemory.mockResolvedValue(fakeBytes(150));
        const { item, source } = await remoteSourceFor('REMOTE06');

        expect(await loadAttachmentData({ item, source })).toMatchObject({ kind: 'ok' });
        expect(await loadAttachmentData({ item, source })).toMatchObject({ kind: 'ok' });

        expect(mockGetAttachmentDataInMemory).toHaveBeenCalledTimes(1);
    });

    it('declines to cache a remote download the ceiling rejects', async () => {
        mockGetAttachmentDataInMemory.mockResolvedValue(fakeBytes(150));
        const { item, source } = await remoteSourceFor('REMOTE08');

        expect(await loadAttachmentData({ item, source })).toMatchObject({
            kind: 'error',
            code: 'file_too_large',
        });
        expect(await loadAttachmentData({ item, source })).toMatchObject({
            kind: 'error',
            code: 'file_too_large',
        });

        expect(mockGetAttachmentDataInMemory).toHaveBeenCalledTimes(2);
    });

    it('declines to cache a remote download larger than the whole cache budget', async () => {
        maxFileSizeMBPref = 4000;
        mockGetAttachmentDataInMemory.mockResolvedValue(fakeBytes(1200));
        const { item, source } = await remoteSourceFor('REMOTE07');

        expect(await loadAttachmentData({ item, source })).toMatchObject({ kind: 'ok' });
        expect(await loadAttachmentData({ item, source })).toMatchObject({ kind: 'ok' });

        expect(mockGetAttachmentDataInMemory).toHaveBeenCalledTimes(2);
    });

    it('returns read_failed and download_failed for expected read failures', async () => {
        (globalThis as any).IOUtils.read.mockRejectedValue(new Error('disk failure'));
        const local = await loadAttachmentData({
            item: makeAttachment(),
            source: { kind: 'local', filePath: '/storage/test.txt', isRemoteOnly: false },
        });
        expect(local).toMatchObject({ kind: 'error', code: 'read_failed' });

        mockGetAttachmentDataInMemory.mockRejectedValue(new Error('download failure'));
        const remote = await loadAttachmentData({
            item: makeAttachment({ key: 'REMOTE03' }),
            source: { kind: 'remote', filePath: 'remote:k:1-REMOTE03-v1', isRemoteOnly: true },
        });
        expect(remote).toMatchObject({ kind: 'error', code: 'download_failed' });
    });

    it('classifies timeouts for path lookup, size check, local read, and remote download', async () => {
        vi.useFakeTimers();
        try {
            const pathTimeout = createTimeoutController(1, 10);
            const pathPromise = resolveAttachmentFileSource({
                item: makeAttachment({ getFilePathAsync: vi.fn(() => new Promise(() => {})) }),
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

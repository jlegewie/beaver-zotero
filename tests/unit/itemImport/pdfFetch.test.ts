import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    scheduleBackgroundTask: vi.fn(),
    buildPdfResolvers: vi.fn(),
    fetchPdfAttachment: vi.fn(),
    zoteroResolverSource: vi.fn((resolvers: unknown[]) => ({ resolvers })),
    downloadServerPdf: vi.fn(),
    isPdfDocument: vi.fn(() => true),
    downloadPdfLink: vi.fn(),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/backgroundTasks', () => ({
    generateTaskId: (...parts: unknown[]) => parts.join(':'),
    scheduleBackgroundTask: mocks.scheduleBackgroundTask,
}));
vi.mock('../../../src/utils/pdfResolvers', () => ({ buildPdfResolvers: mocks.buildPdfResolvers }));
vi.mock('../../../src/services/pdfAttachmentFetch', () => ({
    fetchPdfAttachment: mocks.fetchPdfAttachment,
    zoteroResolverSource: mocks.zoteroResolverSource,
}));
vi.mock('../../../src/services/serverPdfSource', () => ({ downloadServerPdf: mocks.downloadServerPdf }));
vi.mock('../../../src/utils/attachmentFiles', () => ({ isPdfDocument: mocks.isPdfDocument }));
vi.mock('../../../src/services/itemImport/pdfLinkImport', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/services/itemImport/pdfLinkImport')>()),
    downloadPdfLink: mocks.downloadPdfLink,
}));

import { schedulePdfFetchTask } from '../../../src/services/itemImport/pdfFetch';

let item: any;
let onAttachmentResolved: ReturnType<typeof vi.fn>;

/** Run the scheduled task and return the `attachment_resolved` payload. */
async function runTask(): Promise<any> {
    schedulePdfFetchTask(1, 'ITEM0001', { threadId: 't1', onAttachmentResolved } as any);
    await mocks.scheduleBackgroundTask.mock.calls[0][2](new AbortController().signal);
    return onAttachmentResolved.mock.calls[0][0];
}

beforeEach(() => {
    vi.clearAllMocks();
    onAttachmentResolved = vi.fn();
    item = { key: 'ITEM0001', getAttachments: vi.fn(async () => []), getField: vi.fn(() => '') };
    vi.stubGlobal('Zotero', {
        Beaver: { account: { getGeneration: () => 1 }, libraryScopeInitialized: true, searchableLibraryIds: [1] },
        Libraries: { get: () => ({ editable: true, filesEditable: true }) },
        Items: { getByLibraryAndKeyAsync: vi.fn(async () => item), getAsync: vi.fn() },
    });
    mocks.buildPdfResolvers.mockReturnValue([{ url: 'https://a.example/x.pdf' }]);
});

describe('schedulePdfFetchTask failure telemetry', () => {
    it('tries the user download first and the server copy only after it', async () => {
        mocks.fetchPdfAttachment.mockResolvedValue({ attachment: null });

        await runTask();

        const sources = mocks.fetchPdfAttachment.mock.calls[0][1];
        expect(sources).toEqual([{ resolvers: [{ url: 'https://a.example/x.pdf' }] }, mocks.downloadServerPdf]);
    });

    describe('an import from a PDF link', () => {
        const link = 'https://reports.example.org/report.pdf';
        const ready = { signal: new AbortController().signal, assertAccess: () => {} };

        async function guardedSources(candidates: unknown[]) {
            mocks.fetchPdfAttachment.mockResolvedValue({ attachment: null });
            schedulePdfFetchTask(1, 'ITEM0001', { threadId: 't1', onAttachmentResolved, pdfCandidates: candidates, guardedOnly: true } as any);
            await mocks.scheduleBackgroundTask.mock.calls[0][2](new AbortController().signal);
            return mocks.fetchPdfAttachment.mock.calls[0][1];
        }

        it('attaches the PDF downloaded while resolving it, without a second download', async () => {
            const download = { directory: '/tmp/d', path: '/tmp/d/file.pdf', url: link, mimeType: 'application/pdf' };
            const take = vi.fn((url: string) => (url === link ? download : null));
            (Zotero as any).Beaver.itemImport = { resolvedPdfs: { take } };

            const [guarded, server] = await guardedSources([{ url: link, access_method: 'translator' }]);

            expect(server).toBe(mocks.downloadServerPdf);
            expect(await guarded(ready)).toBe(download);
            expect(mocks.downloadPdfLink).not.toHaveBeenCalled();
        });

        it('downloads it again only through the guarded downloader, never Zotero\'s resolvers, and records the attempt', async () => {
            (Zotero as any).Beaver.itemImport = { resolvedPdfs: { take: vi.fn(() => null) } };
            mocks.downloadPdfLink.mockResolvedValue({ ok: false, code: 'not_found', message: 'The file does not exist (HTTP 404).', status: 404 });

            const sources = await guardedSources([{ url: link, access_method: 'web' }]);

            expect(mocks.buildPdfResolvers).not.toHaveBeenCalled();
            expect(mocks.zoteroResolverSource).not.toHaveBeenCalled();
            expect(sources).toHaveLength(2);
            const recordSourceAttempt = vi.fn();
            expect(await sources[0]({ ...ready, diagnostics: { recordSourceAttempt } })).toBeNull();
            expect(mocks.downloadPdfLink).toHaveBeenCalledWith(link, expect.any(Number));
            expect(recordSourceAttempt).toHaveBeenCalledWith('web', 'reports.example.org', expect.objectContaining({ status: 404 }));
        });
    });

    it('reports no_sources when no resolvers can be built', async () => {
        mocks.buildPdfResolvers.mockReturnValue([]);
        expect(await runTask()).toMatchObject({ attachmentStatus: 'failed', failureReason: 'no_sources' });
    });

    it('reports error, not no_sources, when the item cannot be loaded', async () => {
        vi.mocked(Zotero.Items.getByLibraryAndKeyAsync).mockResolvedValue(false as any);
        const payload = await runTask();
        expect(payload).toMatchObject({ attachmentStatus: 'failed', failureReason: 'error' });
        expect(payload.attempts).toBeUndefined();
    });

    it('reports the reason and attempts recorded by the fetch', async () => {
        mocks.fetchPdfAttachment.mockImplementation(async (_i, _r, _s, _a, diagnostics) => {
            diagnostics.onAccessMethodStart('doi');
            diagnostics.onBeforeRequest('https://doi.org/10.1/x');
            diagnostics.onRequestError({ message: 'HTTP 429', status: 429 });
            return { attachment: null };
        });
        expect(await runTask()).toMatchObject({
            attachmentStatus: 'failed',
            failureReason: 'rate_limited',
            attempts: [{ accessMethod: 'doi', host: 'doi.org', outcome: 'rate_limited', status: 429 }],
        });
    });

    it('reports no_attempts when Zotero tried nothing', async () => {
        mocks.fetchPdfAttachment.mockResolvedValue({ attachment: null });
        expect(await runTask()).toMatchObject({ failureReason: 'no_attempts' });
    });

    it('sends the failed attempts but no reason when a later entry attaches the PDF', async () => {
        mocks.fetchPdfAttachment.mockImplementation(async (_i, _r, _s, _a, diagnostics) => {
            diagnostics.onAccessMethodStart('doi');
            diagnostics.onBeforeRequest('https://doi.org/10.1/x');
            diagnostics.onRequestError({ message: 'HTTP 404', status: 404 });
            diagnostics.recordSourceAttempt('openalex_content', 'content.openalex.org');
            return { attachment: { key: 'PDFKEYAA' }, accessMethod: 'openalex_content' };
        });
        const payload = await runTask();
        expect(payload).toMatchObject({
            attachmentStatus: 'available',
            attachmentKey: '1-PDFKEYAA',
            accessMethod: 'openalex_content',
            attempts: [{ outcome: 'not_found' }, { outcome: 'ok' }],
        });
        expect(payload.failureReason).toBeUndefined();
    });

    it('reports an existing PDF as available without a reason or attempts', async () => {
        item.getAttachments.mockResolvedValue([5]);
        vi.mocked(Zotero.Items.getAsync).mockResolvedValue({ key: 'EXISTING', deleted: false } as any);
        const payload = await runTask();
        expect(payload).toMatchObject({ attachmentStatus: 'available', attachmentKey: '1-EXISTING' });
        expect(payload.failureReason).toBeUndefined();
        expect(payload.attempts).toBeUndefined();
        expect(mocks.fetchPdfAttachment).not.toHaveBeenCalled();
    });

    it('reports error when the fetch throws after a file was downloaded', async () => {
        mocks.fetchPdfAttachment.mockImplementation(async (_i, _r, _s, _a, diagnostics) => {
            diagnostics.onAccessMethodStart('doi');
            diagnostics.onBeforeRequest('https://doi.org/10.1/x');
            diagnostics.markSucceeded();
            throw new Error('disk full');
        });
        expect(await runTask()).toMatchObject({ failureReason: 'error', attempts: [{ outcome: 'ok' }] });
    });
});

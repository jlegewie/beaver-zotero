import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    scheduleBackgroundTask: vi.fn(),
    buildPdfResolvers: vi.fn(),
    fetchPdfAttachment: vi.fn(),
    isPdfDocument: vi.fn(() => true),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/backgroundTasks', () => ({
    generateTaskId: (...parts: unknown[]) => parts.join(':'),
    scheduleBackgroundTask: mocks.scheduleBackgroundTask,
}));
vi.mock('../../../src/utils/pdfResolvers', () => ({ buildPdfResolvers: mocks.buildPdfResolvers }));
vi.mock('../../../src/services/pdfAttachmentFetch', () => ({ fetchPdfAttachment: mocks.fetchPdfAttachment }));
vi.mock('../../../src/utils/attachmentFiles', () => ({ isPdfDocument: mocks.isPdfDocument }));

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
    item = { key: 'ITEM0001', getAttachments: vi.fn(async () => []) };
    vi.stubGlobal('Zotero', {
        Beaver: { account: { getGeneration: () => 1 }, libraryScopeInitialized: true, searchableLibraryIds: [1] },
        Libraries: { get: () => ({ editable: true, filesEditable: true }) },
        Items: { getByLibraryAndKeyAsync: vi.fn(async () => item), getAsync: vi.fn() },
    });
    mocks.buildPdfResolvers.mockReturnValue([{ url: 'https://a.example/x.pdf' }]);
});

describe('schedulePdfFetchTask failure telemetry', () => {
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
            diagnostics.onAccessMethodStart('openalex');
            diagnostics.onBeforeRequest('https://oa.example/x.pdf');
            diagnostics.markSucceeded();
            return { attachment: { key: 'PDFKEYAA' }, accessMethod: 'openalex' };
        });
        const payload = await runTask();
        expect(payload).toMatchObject({
            attachmentStatus: 'available',
            attachmentKey: '1-PDFKEYAA',
            accessMethod: 'openalex',
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

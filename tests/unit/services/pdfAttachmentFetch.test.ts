import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPdfAttachment, zoteroResolverSource } from '../../../src/services/pdfAttachmentFetch';
import { LibraryMutations } from '../../../src/services/libraryMutations';
import { createPdfFetchDiagnostics } from '../../../src/services/pdfFetchDiagnostics';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/systemTimers', () => ({ getSystemTimers: () => ({ setTimeout, clearTimeout }) }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

const result = { url: 'https://example.org/paper.pdf', mimeType: 'application/pdf', props: {} };
let mutations: LibraryMutations;
let download: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
let parent: any;
let controller: AbortController;
let allowed: boolean;
let generation: number;
let assertAccess: () => void;

beforeEach(() => {
    vi.clearAllMocks();
    mutations = new LibraryMutations();
    controller = new AbortController();
    allowed = true;
    generation = 1;
    assertAccess = () => { if (!allowed || generation !== 1) throw new Error('Access revoked'); };
    parent = { id: 1, key: 'PARENTAA', libraryID: 1, deleted: false, getAttachments: vi.fn(() => []) };
    download = vi.fn().mockResolvedValue(result);
    save = vi.fn().mockResolvedValue({ key: 'PDFKEYAA' });
    remove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('Zotero', {
        Beaver: { mutations, account: { getGeneration: () => generation } },
        Attachments: {
            LINK_MODE_LINKED_URL: 3,
            createTemporaryStorageDirectory: vi.fn().mockResolvedValue({ path: '/tmp/pdf-fetch-test' }),
            downloadFirstAvailableFile: download,
            FIND_AVAILABLE_FILE_TYPES: ['application/pdf'],
            getFileBaseNameFromItem: () => 'paper',
            createURLAttachmentFromTemporaryStorageDirectory: save,
        },
        Items: { getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(parent), getAsync: vi.fn() },
        MIME: { getPrimaryExtension: () => 'pdf' },
        File: { rename: vi.fn().mockResolvedValue('paper.pdf') },
        getString: () => 'Full Text',
    });
    vi.stubGlobal('PathUtils', { join: (...parts: string[]) => parts.join('/') });
    vi.stubGlobal('IOUtils', { remove });
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const fetchPdf = () => fetchPdfAttachment(parent, [zoteroResolverSource([{ url: result.url }])], controller.signal, assertAccess);

it('allows unrelated mutations and disposal while a download is stalled', async () => {
    const pending = deferred<any>();
    download.mockReturnValue(pending.promise);
    const fetch = fetchPdf();
    await vi.waitFor(() => expect(download).toHaveBeenCalled());
    expect(mutations.getSnapshot()).toMatchObject({ active: null, pending: 0 });
    await expect(mutations.run(async () => 'edited')).resolves.toBe('edited');
    await mutations.dispose();
    pending.resolve(result);
    await expect(fetch).rejects.toMatchObject({ code: 'operation_cancelled' });
    expect(save).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
});

it.each(['timeout', 'cancel'])('abandons a stalled download on %s and cleans up its late result without saving', async reason => {
    vi.useFakeTimers();
    const pending = deferred<any>();
    download.mockReturnValue(pending.promise);
    const fetch = fetchPdf();
    const rejected = expect(fetch).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(0);
    if (reason === 'cancel') controller.abort();
    else await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(remove).not.toHaveBeenCalled();
    pending.resolve(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(remove).toHaveBeenCalledWith('/tmp/pdf-fetch-test', { recursive: true, ignoreAbsent: true });
    expect(save).not.toHaveBeenCalled();
});

it.each(['scope', 'account', 'deleted', 'cancelled'])('rechecks %s after waiting for attachment admission', async reason => {
    const blocker = deferred<void>();
    const active = mutations.run(() => blocker.promise);
    const fetch = fetchPdf();
    const rejected = expect(fetch).rejects.toThrow();
    await vi.waitFor(() => expect(mutations.getSnapshot().pending).toBe(1));
    if (reason === 'scope') allowed = false;
    if (reason === 'account') generation++;
    if (reason === 'deleted') parent.deleted = true;
    if (reason === 'cancelled') controller.abort();
    blocker.resolve();
    await active;
    await rejected;
    expect(save).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
});

it('uses a PDF attached during download instead of saving a duplicate', async () => {
    const existing = { key: 'EXISTING', deleted: false, isAttachment: () => true, attachmentContentType: 'application/pdf' };
    parent.getAttachments.mockReturnValue([2]);
    vi.mocked(Zotero.Items.getAsync).mockResolvedValue(existing as any);
    await expect(fetchPdf()).resolves.toEqual({ attachment: existing });
    expect(save).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalled();
});

it('retains the queue and shutdown barrier until an admitted save settles', async () => {
    const pending = deferred<any>();
    save.mockReturnValue(pending.promise);
    const fetch = fetchPdf();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ directory: '/tmp/pdf-fetch-test', parentItemID: 1, libraryID: 1, filename: 'paper.pdf', contentType: 'application/pdf' }));
    controller.abort();
    let disposed = false;
    const disposal = mutations.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);
    expect(remove).not.toHaveBeenCalled();
    pending.resolve({ key: 'SAVEDPDF' });
    await expect(fetch).resolves.toMatchObject({ attachment: { key: 'SAVEDPDF' } });
    await disposal;
    expect(remove).toHaveBeenCalled();
});

describe('failure diagnostics', () => {
    const cloudflare403 = {
        message: 'HTTP 403',
        status: 403,
        xmlhttp: { getResponseHeader: (name: string) => (name === 'cf-mitigated' ? 'challenge' : null) },
    };

    /** Drives the hooks the way `downloadFirstAvailableFile` does for each resolver entry. */
    const driveEntries = (steps: Array<{ method: string; url: string; error?: unknown; wins?: boolean }>) =>
        async (_resolvers: unknown, _path: string, options: any) => {
            for (const step of steps) {
                options.onAccessMethodStart(step.method);
                try {
                    await options.onBeforeRequest(step.url);
                    if (step.error) throw step.error;
                    if (step.wins) return result;
                } catch (error) {
                    options.onRequestError(error);
                }
            }
            return false;
        };

    it('records a failed entry and the winning entry that follows it', async () => {
        const diagnostics = createPdfFetchDiagnostics();
        download.mockImplementation(driveEntries([
            { method: 'doi', url: 'https://doi.org/10.1/x', error: cloudflare403 },
            { method: 'openalex', url: 'https://oa.example/paper.pdf', wins: true },
        ]));
        await fetchPdfAttachment(parent, [zoteroResolverSource([{ url: result.url }])], controller.signal, assertAccess, diagnostics);
        expect(diagnostics.attempts()).toEqual([
            { accessMethod: 'doi', host: 'doi.org', outcome: 'bot_challenge', status: 403 },
            { accessMethod: 'openalex', host: 'oa.example', outcome: 'ok' },
        ]);
    });

    it('still sets the access method of the winning entry', async () => {
        download.mockImplementation(driveEntries([{ method: 'openalex', url: 'https://oa.example/p.pdf', wins: true }]));
        await expect(fetchPdfAttachment(parent, [zoteroResolverSource([])], controller.signal, assertAccess, createPdfFetchDiagnostics()))
            .resolves.toMatchObject({ accessMethod: 'openalex' });
    });

    it('reports a skipped CAPTCHA URL as an attempt', async () => {
        const diagnostics = createPdfFetchDiagnostics();
        (Zotero as any).BrowserRequest = { getEntryForURL: (url: string) => (url.includes('captcha.example') ? { captchaLocator: '#c' } : null) };
        download.mockImplementation(driveEntries([{ method: 'url', url: 'https://captcha.example/a' }]));
        await expect(fetchPdfAttachment(parent, [zoteroResolverSource([])], controller.signal, assertAccess, diagnostics))
            .resolves.toEqual({ attachment: null });
        expect(diagnostics.attempts()).toEqual([{ accessMethod: 'url', host: 'captcha.example', outcome: 'captcha_skipped' }]);
        expect(diagnostics.failureReason({ resolverCount: 1, threw: false })).toBe('captcha_skipped');
    });

    it('reports no_pdf_found when a page yields no file and Zotero moves on silently', async () => {
        const diagnostics = createPdfFetchDiagnostics();
        download.mockImplementation(driveEntries([{ method: 'url', url: 'https://publisher.example/article' }]));
        await fetchPdfAttachment(parent, [zoteroResolverSource([])], controller.signal, assertAccess, diagnostics);
        expect(diagnostics.failureReason({ resolverCount: 1, threw: false })).toBe('no_pdf_found');
    });

    it('reports timeout when the budget elapses mid-download and keeps the attempt in flight', async () => {
        vi.useFakeTimers();
        const diagnostics = createPdfFetchDiagnostics();
        const pending = deferred<any>();
        download.mockImplementation(async (_resolvers: unknown, _path: string, options: any) => {
            options.onAccessMethodStart('doi');
            await options.onBeforeRequest('https://doi.org/10.1/x');
            return pending.promise;
        });
        const fetch = fetchPdfAttachment(parent, [zoteroResolverSource([])], controller.signal, assertAccess, diagnostics);
        const rejected = expect(fetch).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(60_000);
        await rejected;
        expect(diagnostics.failureReason({ resolverCount: 1, threw: true })).toBe('timeout');
        expect(diagnostics.attempts()).toEqual([{ accessMethod: 'doi', host: 'doi.org', outcome: 'cancelled' }]);
        pending.resolve(result);
        await vi.advanceTimersByTimeAsync(0);
    });

    it('does not report timeout when the task is aborted', async () => {
        vi.useFakeTimers();
        const diagnostics = createPdfFetchDiagnostics();
        download.mockReturnValue(deferred<any>().promise);
        const fetch = fetchPdfAttachment(parent, [zoteroResolverSource([])], controller.signal, assertAccess, diagnostics);
        const rejected = expect(fetch).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await rejected;
        expect(diagnostics.failureReason({ resolverCount: 1, threw: true })).toBe('error');
    });

    it('reports unsupported_type when the downloaded file cannot be attached', async () => {
        const diagnostics = createPdfFetchDiagnostics();
        download.mockImplementation(async (_resolvers: unknown, _path: string, options: any) => {
            options.onAccessMethodStart('url');
            await options.onBeforeRequest('https://a.example/file.zip');
            return { ...result, mimeType: 'application/zip' };
        });
        await expect(fetchPdfAttachment(parent, [zoteroResolverSource([])], controller.signal, assertAccess, diagnostics)).rejects.toThrow('unsupported type');
        expect(diagnostics.failureReason({ resolverCount: 1, threw: true })).toBe('unsupported_type');
        expect(diagnostics.attempts()).toEqual([{ accessMethod: 'url', host: 'a.example', outcome: 'not_pdf' }]);
    });

    it('reports error when saving fails after a successful download', async () => {
        const diagnostics = createPdfFetchDiagnostics();
        download.mockImplementation(driveEntries([
            { method: 'doi', url: 'https://doi.org/x', error: { message: 'HTTP 404', status: 404 } },
            { method: 'oa', url: 'https://oa.example/p.pdf', wins: true },
        ]));
        save.mockRejectedValue(new Error('disk full'));
        await expect(fetchPdfAttachment(parent, [zoteroResolverSource([])], controller.signal, assertAccess, diagnostics)).rejects.toThrow('disk full');
        expect(diagnostics.failureReason({ resolverCount: 2, threw: true })).toBe('error');
    });

    it('works without a tracker', async () => {
        download.mockImplementation(driveEntries([{ method: 'oa', url: 'https://oa.example/p.pdf', wins: true }]));
        await expect(fetchPdfAttachment(parent, [zoteroResolverSource([])], controller.signal, assertAccess)).resolves.toMatchObject({ accessMethod: 'oa' });
    });
});

describe('ordered sources', () => {
    const serverFile = (overrides: Record<string, unknown> = {}) => ({
        directory: '/tmp/server-pdf',
        path: '/tmp/server-pdf/file.pdf',
        url: 'https://repo.example/paper',
        mimeType: 'application/pdf',
        props: { articleVersion: 'acceptedVersion' },
        accessMethod: 'openalex_content',
        ...overrides,
    });

    it('does not ask a later source once an earlier one found a file', async () => {
        const fallback = vi.fn();
        await expect(fetchPdfAttachment(parent, [zoteroResolverSource([{ url: result.url }]), fallback], controller.signal, assertAccess))
            .resolves.toMatchObject({ attachment: { key: 'PDFKEYAA' } });
        expect(fallback).not.toHaveBeenCalled();
    });

    it('attaches the next source file when the cascade finds none, with its own url and access method', async () => {
        download.mockResolvedValue(false);
        const fallback = vi.fn().mockResolvedValue(serverFile());

        await expect(fetchPdfAttachment(parent, [zoteroResolverSource([{ url: result.url }]), fallback], controller.signal, assertAccess))
            .resolves.toEqual({ attachment: { key: 'PDFKEYAA' }, accessMethod: 'openalex_content' });

        expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ item: parent, signal: controller.signal }));
        expect(save).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/tmp/server-pdf',
            url: 'https://repo.example/paper',
            contentType: 'application/pdf',
        }));
    });

    it('still asks the next source when the cascade runs out of budget', async () => {
        vi.useFakeTimers();
        download.mockReturnValue(deferred<any>().promise);
        const fallback = vi.fn().mockResolvedValue(serverFile());

        const fetch = fetchPdfAttachment(parent, [zoteroResolverSource([]), fallback], controller.signal, assertAccess);
        await vi.advanceTimersByTimeAsync(60_000);

        await expect(fetch).resolves.toMatchObject({ accessMethod: 'openalex_content' });
    });

    it('rethrows the first failure when no source found a file', async () => {
        const first = vi.fn().mockRejectedValue(new Error('unsupported type'));
        const second = vi.fn().mockResolvedValue(null);

        await expect(fetchPdfAttachment(parent, [first, second], controller.signal, assertAccess)).rejects.toThrow('unsupported type');
        expect(second).toHaveBeenCalled();
    });

    it('returns no attachment when every source comes back empty', async () => {
        const sources = [vi.fn().mockResolvedValue(null), vi.fn().mockResolvedValue(null)];
        await expect(fetchPdfAttachment(parent, sources, controller.signal, assertAccess)).resolves.toEqual({ attachment: null });
    });

    it('stops at a cancelled task instead of asking the next source', async () => {
        const first = vi.fn().mockImplementation(async () => {
            controller.abort();
            throw new Error('PDF fetch cancelled or timed out');
        });
        const second = vi.fn();

        await expect(fetchPdfAttachment(parent, [first, second], controller.signal, assertAccess)).rejects.toThrow('cancelled');
        expect(second).not.toHaveBeenCalled();
    });

    it('stops when access was revoked while a source failed', async () => {
        const first = vi.fn().mockImplementation(async () => {
            allowed = false;
            throw new Error('download failed');
        });
        const second = vi.fn();

        await expect(fetchPdfAttachment(parent, [first, second], controller.signal, assertAccess)).rejects.toThrow('Access revoked');
        expect(second).not.toHaveBeenCalled();
    });
});

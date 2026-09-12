import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchPdfAttachment } from '../../../src/services/pdfAttachmentFetch';
import { LibraryMutations } from '../../../src/services/libraryMutations';

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

const fetchPdf = () => fetchPdfAttachment(parent, [{ url: result.url }], controller.signal, assertAccess);

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
    const existing = { key: 'EXISTING', deleted: false, isPDFAttachment: () => true };
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

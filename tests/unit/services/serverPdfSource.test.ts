import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ postForBytes: vi.fn() }));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('@beaver/agent-core/transport/apiService', () => ({
    ApiService: class {
        postForBytes(...args: unknown[]) {
            return mocks.postForBytes(...args);
        }
    },
}));

import { downloadServerPdf } from '../../../src/services/serverPdfSource';
import { createPdfFetchDiagnostics } from '../../../src/services/pdfFetchDiagnostics';

const PDF = new TextEncoder().encode('%PDF-1.7\n...\n%%EOF\n');

function response(bytes: Uint8Array, headers: Record<string, string> = {}) {
    return { bytes, headers: new Headers(headers) };
}

let item: any;
let controller: AbortController;
let allowed: boolean;
let write: ReturnType<typeof vi.fn>;
let remove: ReturnType<typeof vi.fn>;
const assertAccess = () => { if (!allowed) throw new Error('Access revoked'); };
const run = (diagnostics = createPdfFetchDiagnostics()) =>
    downloadServerPdf({ item, signal: controller.signal, assertAccess, diagnostics });

beforeEach(() => {
    vi.clearAllMocks();
    controller = new AbortController();
    allowed = true;
    item = { key: 'ITEM0001', getField: vi.fn((field: string) => (field === 'DOI' ? '10.1016/J.X.2020.1' : '')), getExtraField: vi.fn(() => '') };
    write = vi.fn().mockResolvedValue(undefined);
    remove = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('Zotero', {
        Utilities: { cleanDOI: (value: string) => (/^10\.\S+\/\S+$/.test(value.trim()) ? value.trim() : false) },
        Attachments: { createTemporaryStorageDirectory: vi.fn().mockResolvedValue({ path: '/tmp/server-pdf' }) },
    });
    vi.stubGlobal('PathUtils', { join: (...parts: string[]) => parts.join('/') });
    vi.stubGlobal('IOUtils', { write, remove });
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('downloadServerPdf', () => {
    it('writes the server copy and describes it with the recorded source URL and version', async () => {
        mocks.postForBytes.mockResolvedValue(response(PDF, {
            'X-Beaver-Pdf-Url': 'https://repo.example/paper',
            'X-Beaver-Pdf-Version': 'acceptedVersion',
        }));
        const diagnostics = createPdfFetchDiagnostics();

        const file = await run(diagnostics);

        expect(mocks.postForBytes).toHaveBeenCalledWith(
            '/api/v1/fulltext/pdf',
            { doi: '10.1016/J.X.2020.1' },
            expect.objectContaining({ timeoutMs: expect.any(Number), assertDispatch: expect.any(Function) }),
        );
        expect(write).toHaveBeenCalledWith('/tmp/server-pdf/file.pdf', PDF);
        expect(file).toEqual({
            directory: '/tmp/server-pdf',
            path: '/tmp/server-pdf/file.pdf',
            url: 'https://repo.example/paper',
            mimeType: 'application/pdf',
            props: { articleVersion: 'acceptedVersion' },
            accessMethod: 'openalex_content',
        });
        expect(diagnostics.attempts()).toEqual([
            { accessMethod: 'openalex_content', host: 'content.openalex.org', outcome: 'ok' },
        ]);
    });

    it('reads the DOI from an Extra line when the item has no DOI field', async () => {
        item.getField.mockReturnValue('');
        item.getExtraField.mockReturnValue('10.1234/extra');
        mocks.postForBytes.mockResolvedValue(response(PDF));

        await run();

        expect(mocks.postForBytes.mock.calls[0][1]).toEqual({ doi: '10.1234/extra' });
    });

    it('falls back to the DOI link when the server sends no usable source URL', async () => {
        mocks.postForBytes.mockResolvedValue(response(PDF, { 'X-Beaver-Pdf-Url': 'javascript:alert(1)' }));

        expect(await run()).toMatchObject({ url: 'https://doi.org/10.1016/J.X.2020.1', props: undefined });
    });

    it('asks nothing for an item without a DOI', async () => {
        item.getField.mockReturnValue('');
        const diagnostics = createPdfFetchDiagnostics();

        expect(await run(diagnostics)).toBeNull();
        expect(mocks.postForBytes).not.toHaveBeenCalled();
        expect(diagnostics.attempts()).toEqual([]);
    });

    it('records a server without a copy as not_found and returns null', async () => {
        mocks.postForBytes.mockRejectedValue(Object.assign(new Error('No cached PDF'), { status: 404 }));
        const diagnostics = createPdfFetchDiagnostics();

        expect(await run(diagnostics)).toBeNull();
        expect(diagnostics.attempts()).toEqual([
            { accessMethod: 'openalex_content', host: 'content.openalex.org', outcome: 'not_found', status: 404 },
        ]);
        expect(write).not.toHaveBeenCalled();
    });

    it('refuses a body that is not a PDF without writing it', async () => {
        mocks.postForBytes.mockResolvedValue(response(new TextEncoder().encode('<html>')));
        const diagnostics = createPdfFetchDiagnostics();

        expect(await run(diagnostics)).toBeNull();
        expect(diagnostics.attempts()[0]).toMatchObject({ outcome: 'not_pdf' });
        expect(write).not.toHaveBeenCalled();
    });

    it('stops waiting and records nothing when the task is cancelled mid-request', async () => {
        mocks.postForBytes.mockReturnValue(new Promise(() => {}));
        const diagnostics = createPdfFetchDiagnostics();

        const download = run(diagnostics);
        controller.abort();

        await expect(download).rejects.toThrow('cancelled');
        expect(diagnostics.attempts()).toEqual([]);
    });

    it('sends nothing for a task cancelled before the fallback starts', async () => {
        controller.abort();

        await expect(run()).rejects.toThrow('cancelled');
        expect(mocks.postForBytes).not.toHaveBeenCalled();
    });

    it('throws when access is revoked while the request is in flight', async () => {
        mocks.postForBytes.mockImplementation(async () => {
            allowed = false;
            return response(PDF);
        });

        await expect(run()).rejects.toThrow('Access revoked');
        expect(write).not.toHaveBeenCalled();
    });

    it('removes its directory when writing fails', async () => {
        mocks.postForBytes.mockResolvedValue(response(PDF));
        write.mockRejectedValue(new Error('disk full'));

        await expect(run()).rejects.toThrow('disk full');
        expect(remove).toHaveBeenCalledWith('/tmp/server-pdf', { recursive: true, ignoreAbsent: true });
    });
});

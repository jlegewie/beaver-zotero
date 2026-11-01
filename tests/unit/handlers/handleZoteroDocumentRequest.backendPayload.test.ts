/**
 * zotero_document responses sent over the WebSocket carry documents in the
 * form the backend consumes: cached PDF serializations are spliced in
 * verbatim, and EPUB/snapshot documents drop their derivable citation index.
 * Local callers receive documents as extracted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: { toString: () => 'searchableLibraryIdsAtom' },
}));
vi.mock('../../../src/services/externalFiles', () => ({
    EXTERNAL_LIBRARY_ID: -1,
    resolveExternalFile: vi.fn(),
}));
vi.mock('../../../src/services/documentExtractionCore', () => ({
    extractAndCacheEpubDocument: vi.fn(),
    extractAndCacheResolvedPdfDocument: vi.fn(),
}));

import { handleZoteroDocumentRequest } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';
import { resolveExternalFile } from '../../../src/services/externalFiles';
import {
    extractAndCacheEpubDocument,
    extractAndCacheResolvedPdfDocument,
} from '../../../src/services/documentExtractionCore';
import {
    isPreparedJsonMessage,
    materializePreparedJsonMessage,
} from '@beaver/agent-core/transport/preparedJsonMessage';
import type { WSZoteroDocumentRequest } from '@beaver/agent-core/protocol/agentProtocol';

const EXT_KEY = 'AB12CD34';

const pdfRecord = {
    extKey: EXT_KEY,
    filename: 'paper.pdf',
    originalPath: '/home/user/paper.pdf',
    storedPath: '/mock/data/beaver/external-files/AB12CD34.pdf',
    contentKind: 'pdf' as const,
    mimeType: 'application/pdf',
    fileSize: 1024,
    mtimeMs: 1718000000000,
    pageCount: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
};

function structuredResult() {
    return {
        schemaVersion: '4',
        mode: 'structured',
        document: {
            pageCount: 1,
            bboxOrigin: 'top-left',
            bboxPrecision: 1,
            pages: [{
                index: 0, width: 612, height: 792, viewBox: [0, 0, 612, 792], rotation: 0,
                items: [{ id: 'p1', kind: 'text', pageIndex: 0, order: 0, bbox: [10, 10, 100, 20], text: 'Body.' }],
            }],
        },
    };
}

function mockSerializedPdf(result: unknown) {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(result));
    vi.mocked(extractAndCacheResolvedPdfDocument).mockResolvedValue({
        kind: 'ok',
        cached: true,
        serializedResult: { jsonBytes, byteLength: jsonBytes.byteLength },
        totalPages: 1,
        resolvedAttachment: { libraryId: -1, zoteroKey: EXT_KEY },
        contentType: 'application/pdf',
    } as any);
}

function request(overrides: Partial<WSZoteroDocumentRequest> = {}): WSZoteroDocumentRequest {
    return {
        event: 'zotero_document_request',
        request_id: 'req-1',
        external_file_key: EXT_KEY,
        mode: 'structured',
        ...overrides,
    } as WSZoteroDocumentRequest;
}

async function websocketMessage(req: WSZoteroDocumentRequest): Promise<any> {
    const response = await handleZoteroDocumentRequest(req, { responseMode: 'websocket' });
    expect(isPreparedJsonMessage(response)).toBe(true);
    return JSON.parse(materializePreparedJsonMessage(response as any));
}

describe('handleZoteroDocumentRequest backend document payload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record: pdfRecord });
    });

    it('splices cached PDF serializations into the response without parsing them', async () => {
        mockSerializedPdf(structuredResult());
        const parse = vi.spyOn(JSON, 'parse');

        const response = await handleZoteroDocumentRequest(request(), { responseMode: 'websocket' });

        expect(parse).not.toHaveBeenCalled();
        parse.mockRestore();
        const message = JSON.parse(materializePreparedJsonMessage(response as any));
        expect(message).toMatchObject({ type: 'zotero_document', request_id: 'req-1', content_kind: 'pdf' });
        expect(message.result).toEqual({ content_kind: 'pdf', ...structuredResult() });
    });

    it('rejects serialized PDFs that exceed the payload budget', async () => {
        mockSerializedPdf(structuredResult());

        const response = await handleZoteroDocumentRequest(
            request({ max_payload_bytes: 50 }),
            { responseMode: 'websocket' },
        );

        expect(isPreparedJsonMessage(response)).toBe(false);
        expect((response as any).error_code).toBe('document_too_large');
    });

    it('sends EPUBs without the citation index', async () => {
        vi.mocked(resolveExternalFile).mockResolvedValue({
            ok: true,
            record: { ...pdfRecord, filename: 'book.epub', contentKind: 'epub' as const, mimeType: 'application/epub+zip' },
        });
        vi.mocked(extractAndCacheEpubDocument).mockResolvedValue({
            kind: 'ok',
            cached: true,
            document: {
                content_kind: 'epub',
                schemaVersion: '2',
                sectionCount: 1,
                sections: [{ index: 0, rawHref: 'a.xhtml', items: [] }],
                citationIndex: { p1: { id: 'p1' } },
                diagnostics: { extractedTextChars: 0, sourceTextChars: 0, textCoverage: null },
            },
            resolvedAttachment: { libraryId: -1, zoteroKey: EXT_KEY },
            contentType: 'application/epub+zip',
        } as any);

        const message = await websocketMessage(request());

        expect(message.content_kind).toBe('epub');
        expect(message.result).not.toHaveProperty('citationIndex');
        expect(message.result.sections).toHaveLength(1);
    });

    it('returns documents as extracted to local callers', async () => {
        vi.mocked(extractAndCacheResolvedPdfDocument).mockResolvedValue({
            kind: 'ok',
            cached: true,
            result: structuredResult(),
            totalPages: 1,
            resolvedAttachment: { libraryId: -1, zoteroKey: EXT_KEY },
            contentType: 'application/pdf',
        } as any);

        const response = await handleZoteroDocumentRequest(request());

        expect(response.result).toEqual({ ...structuredResult(), content_kind: 'pdf' });
    });
});

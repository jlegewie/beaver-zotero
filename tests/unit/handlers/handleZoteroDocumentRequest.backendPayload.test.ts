/**
 * zotero_document responses sent over the WebSocket carry the backend
 * projection of the document (no citation index, no PDF margin items unless
 * requested); local callers still receive the full document.
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

function structuredResult(marginCount = 2) {
    const margins = Array.from({ length: marginCount }, (_, i) => ({
        id: `margin${i + 1}`, kind: 'margin', pageIndex: 0, order: i + 1, bbox: [0, 0, 5, 5], text: 'x',
    }));
    return {
        schemaVersion: '4',
        mode: 'structured',
        document: {
            pageCount: 1,
            bboxOrigin: 'top-left',
            bboxPrecision: 1,
            pages: [{
                index: 0, width: 612, height: 792, viewBox: [0, 0, 612, 792], rotation: 0,
                items: [
                    { id: 'p1', kind: 'text', pageIndex: 0, order: 0, bbox: [10, 10, 100, 20], text: 'Body.' },
                    ...margins,
                ],
            }],
            citationIndex: Object.fromEntries(
                ['p1', ...margins.map(m => m.id)].map(id => [id, { id, kind: 'item', pageIndex: 0, itemId: id }]),
            ),
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

async function websocketResult(req: WSZoteroDocumentRequest): Promise<any> {
    const response = await handleZoteroDocumentRequest(req, { responseMode: 'websocket' });
    expect(isPreparedJsonMessage(response)).toBe(true);
    return JSON.parse(materializePreparedJsonMessage(response as any));
}

describe('handleZoteroDocumentRequest backend document payload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(resolveExternalFile).mockResolvedValue({ ok: true, record: pdfRecord });
    });

    it('sends PDFs without the citation index or margin items', async () => {
        mockSerializedPdf(structuredResult());

        const message = await websocketResult(request());

        expect(message).toMatchObject({ type: 'zotero_document', request_id: 'req-1', content_kind: 'pdf' });
        expect(message.result.content_kind).toBe('pdf');
        expect(message.result.document).not.toHaveProperty('citationIndex');
        expect(message.result.document.pages[0].items.map((item: any) => item.id)).toEqual(['p1']);
    });

    it('keeps margin items when the backend asks for them', async () => {
        mockSerializedPdf(structuredResult());

        const message = await websocketResult(request({ include_margins: true }));

        expect(message.result.document).not.toHaveProperty('citationIndex');
        expect(message.result.document.pages[0].items.map((item: any) => item.id))
            .toEqual(['p1', 'margin1', 'margin2']);
    });

    it('applies the payload budget to the projected size', async () => {
        const full = structuredResult(200);
        mockSerializedPdf(full);
        const projectedBytes = JSON.stringify({ content_kind: 'pdf', ...structuredResult(0) }).length;
        expect(JSON.stringify(full).length).toBeGreaterThan(projectedBytes * 5);

        const message = await websocketResult(request({ max_payload_bytes: projectedBytes + 100 }));

        expect(message.error_code).toBeUndefined();
        expect(message.result.document.pages[0].items).toHaveLength(1);
    });

    it('still rejects documents whose projection exceeds the payload budget', async () => {
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

        const message = await websocketResult(request());

        expect(message.content_kind).toBe('epub');
        expect(message.result).not.toHaveProperty('citationIndex');
        expect(message.result.sections).toHaveLength(1);
    });

    it('returns the full document to local callers', async () => {
        vi.mocked(extractAndCacheResolvedPdfDocument).mockResolvedValue({
            kind: 'ok',
            cached: true,
            result: structuredResult(),
            totalPages: 1,
            resolvedAttachment: { libraryId: -1, zoteroKey: EXT_KEY },
            contentType: 'application/pdf',
        } as any);

        const response = await handleZoteroDocumentRequest(request());

        expect(response.result).toMatchObject({ content_kind: 'pdf' });
        expect((response.result as any).document.citationIndex).toBeDefined();
        expect((response.result as any).document.pages[0].items).toHaveLength(3);
    });
});

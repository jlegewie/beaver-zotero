/**
 * Payload-size guard for zotero_document responses: oversized serialized
 * results must come back as a clean document_too_large error instead of an
 * oversized WebSocket message that trips the server's frame limit and kills
 * the connection (1009 / CloseCode.ABNORMAL_CLOSURE).
 */

import { describe, expect, it, vi } from 'vitest';

// The handler module's import chain reaches supabaseClient (which throws
// without env config) — stub it and its store dependencies like the
// companion cache test does.
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: { toString: () => 'searchableLibraryIdsAtom' },
}));

import { guardPayloadSize } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';
import type {
    WSZoteroDocumentRequest,
    WSZoteroDocumentResponse,
    ZoteroDocumentErrorCode,
} from '../../../src/services/agentProtocol';
import type { ExtractContentKind } from '../../../src/services/documentExtraction/shared/contentKinds';

function makeRequest(maxPayloadBytes?: number | null): WSZoteroDocumentRequest {
    return {
        event: 'zotero_document_request',
        request_id: 'r1',
        attachment: { library_id: 1, zotero_key: 'PDF12345' },
        mode: 'structured',
        ...(maxPayloadBytes !== undefined ? { max_payload_bytes: maxPayloadBytes } : {}),
    } as WSZoteroDocumentRequest;
}

function makeResponse(result: any): WSZoteroDocumentResponse {
    return {
        type: 'zotero_document',
        request_id: 'r1',
        resolved_attachment: { library_id: 1, zotero_key: 'PDF12345' },
        content_type: 'application/pdf',
        content_kind: 'pdf',
        result,
    };
}

const errorResponse = (
    error: string,
    error_code: ZoteroDocumentErrorCode,
    total_pages: number | null = null,
    content_kind?: ExtractContentKind,
): WSZoteroDocumentResponse => ({
    type: 'zotero_document',
    request_id: 'r1',
    ...(content_kind ? { content_kind } : {}),
    total_pages,
    error,
    error_code,
});

describe('guardPayloadSize', () => {
    it('passes the response through when no limit was requested (old backend)', () => {
        const response = makeResponse({ pad: 'x'.repeat(10_000) });
        expect(guardPayloadSize(makeRequest(), response, null, 'pdf', errorResponse)).toBe(response);
        expect(guardPayloadSize(makeRequest(null), response, null, 'pdf', errorResponse)).toBe(response);
        expect(guardPayloadSize(makeRequest(0), response, null, 'pdf', errorResponse)).toBe(response);
    });

    it('passes the response through when the payload is within the limit', () => {
        const response = makeResponse({ pad: 'x'.repeat(1000) });
        const out = guardPayloadSize(makeRequest(100_000), response, null, 'pdf', errorResponse);
        expect(out).toBe(response);
    });

    it('returns document_too_large when the payload exceeds the limit', () => {
        const response = makeResponse({ pad: 'x'.repeat(10_000) });
        const out = guardPayloadSize(makeRequest(1000), response, 42, 'pdf', errorResponse);

        expect(out.error_code).toBe('document_too_large');
        expect(out.error).toContain('too large to transfer');
        expect(out.error).toContain('across 42 pages');
        expect(out.error).toContain('Do not try again');
        expect(out.total_pages).toBe(42);
        expect(out.content_kind).toBe('pdf');
        expect(out.result).toBeUndefined();
        expect(out.resolved_attachment).toBeUndefined();
    });

    it('measures UTF-8 bytes, not string length', () => {
        // 1000 three-byte characters: length 1000, but 3000 UTF-8 bytes.
        const response = makeResponse({ pad: '€'.repeat(1000) });
        const out = guardPayloadSize(makeRequest(2000), response, null, 'pdf', errorResponse);
        expect(out.error_code).toBe('document_too_large');
    });

    it('omits the page clause when total pages are unknown', () => {
        const response = makeResponse({ pad: 'x'.repeat(10_000) });
        const out = guardPayloadSize(makeRequest(1000), response, null, 'text', errorResponse);
        expect(out.error_code).toBe('document_too_large');
        expect(out.error).not.toContain('across');
        expect(out.content_kind).toBe('text');
    });
});

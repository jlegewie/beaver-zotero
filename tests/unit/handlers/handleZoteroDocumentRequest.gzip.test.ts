/**
 * Negotiation matrix for finalizeSuccessResponse: JSON vs binary envelope vs
 * document_too_large, against gzip-capable and legacy backends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { finalizeSuccessResponse } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';
import {
    LEGACY_MAX_JSON_BYTES,
    SMALL_PAYLOAD_THRESHOLD_BYTES,
    isWSBinaryEnvelope,
} from '../../../src/services/wsBinaryEnvelope';
import type {
    WSZoteroDocumentRequest,
    WSZoteroDocumentResponse,
    ZoteroDocumentErrorCode,
} from '../../../src/services/agentProtocol';
import type { ExtractContentKind } from '../../../src/services/documentExtraction/shared/contentKinds';
import { gzipString, gunzipToString } from '../../../src/utils/gzip';

const takeGzipPayload = vi.fn();

function makeRequest(overrides: Partial<WSZoteroDocumentRequest> = {}): WSZoteroDocumentRequest {
    return {
        event: 'zotero_document_request',
        request_id: 'r1',
        attachment: { library_id: 1, zotero_key: 'PDF12345' },
        mode: 'structured',
        ...overrides,
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

function finalize(
    request: WSZoteroDocumentRequest,
    result: any,
    cacheSourceResult: object = result,
) {
    return finalizeSuccessResponse({
        request,
        response: makeResponse(result),
        cacheSourceResult,
        totalPages: 42,
        contentKind: 'pdf',
        errorResponse,
    });
}

/** A real gzip blob whose ISIZE trailer is patched to claim `size` bytes. */
function gzWithClaimedSize(size: number): Uint8Array {
    const blob = gzipString('{"x": 1}');
    new DataView(blob.buffer, blob.byteOffset + blob.byteLength - 4, 4)
        .setUint32(0, size, true);
    return blob;
}

beforeEach(() => {
    takeGzipPayload.mockReset();
    takeGzipPayload.mockReturnValue(undefined);
    (globalThis as any).Zotero.Beaver = { documentCache: { takeGzipPayload } };
});

afterEach(() => {
    delete (globalThis as any).Zotero.Beaver;
});

describe('finalizeSuccessResponse negotiation matrix', () => {
    it('legacy backend, small result: plain JSON response', () => {
        const result = { mode: 'structured', document: { pageCount: 1, pages: [] } };
        const out = finalize(makeRequest(), result);
        expect(isWSBinaryEnvelope(out)).toBe(false);
        expect((out as WSZoteroDocumentResponse).result).toBe(result);
    });

    it('legacy backend, oversized result: document_too_large error', () => {
        takeGzipPayload.mockReturnValue(gzWithClaimedSize(LEGACY_MAX_JSON_BYTES + 1));
        const out = finalize(makeRequest(), { mode: 'structured' });
        expect(isWSBinaryEnvelope(out)).toBe(false);
        const response = out as WSZoteroDocumentResponse;
        expect(response.error_code).toBe('document_too_large');
        expect(response.error).toContain('Do not try again');
        expect(response.total_pages).toBe(42);
        expect(response.result).toBeUndefined();
    });

    it('gzip backend, small result: plain JSON response', () => {
        takeGzipPayload.mockReturnValue(gzipString('{"small": true}'));
        const out = finalize(
            makeRequest({ accept_encoding: ['gzip'], max_payload_bytes: 14e6, max_decompressed_bytes: 64e6 }),
            { mode: 'structured' },
        );
        expect(isWSBinaryEnvelope(out)).toBe(false);
    });

    it('gzip backend, large result: binary envelope reusing the cached blob', () => {
        const blob = gzWithClaimedSize(SMALL_PAYLOAD_THRESHOLD_BYTES + 1);
        takeGzipPayload.mockReturnValue(blob);
        const result = { mode: 'structured', document: { pageCount: 1, pages: [] } };
        const out = finalize(
            makeRequest({ accept_encoding: ['gzip'], max_payload_bytes: 14e6, max_decompressed_bytes: 64e6 }),
            result,
        );

        expect(isWSBinaryEnvelope(out)).toBe(true);
        if (!isWSBinaryEnvelope(out)) throw new Error('unreachable');
        expect(out.payload).toBe(blob);
        // Header is the response minus `result`.
        expect(out.header.result).toBeUndefined();
        expect(out.header.type).toBe('zotero_document');
        expect(out.header.request_id).toBe('r1');
        expect(out.header.content_kind).toBe('pdf');
    });

    it('gzip backend, compressed payload over max_payload_bytes: document_too_large', () => {
        const blob = gzipString(JSON.stringify({ pad: 'x'.repeat(100_000) }));
        takeGzipPayload.mockReturnValue(blob);
        const out = finalize(
            makeRequest({ accept_encoding: ['gzip'], max_payload_bytes: 16, max_decompressed_bytes: 64e6 }),
            { mode: 'structured' },
        );
        expect((out as WSZoteroDocumentResponse).error_code).toBe('document_too_large');
    });

    it('gzip backend, decompressed size over max_decompressed_bytes: document_too_large', () => {
        takeGzipPayload.mockReturnValue(gzWithClaimedSize(64e6 + 1));
        const out = finalize(
            makeRequest({ accept_encoding: ['gzip'], max_payload_bytes: 14e6, max_decompressed_bytes: 64e6 }),
            { mode: 'structured' },
        );
        expect((out as WSZoteroDocumentResponse).error_code).toBe('document_too_large');
    });

    it('gzip backend, no cached blob: compresses the response result on demand', () => {
        // Large enough to clear the small-payload fast path.
        const result = { mode: 'structured', pad: 'y'.repeat(SMALL_PAYLOAD_THRESHOLD_BYTES) };
        const out = finalize(
            makeRequest({ accept_encoding: ['gzip'], max_payload_bytes: 14e6, max_decompressed_bytes: 64e6 }),
            result,
        );

        expect(isWSBinaryEnvelope(out)).toBe(true);
        if (!isWSBinaryEnvelope(out)) throw new Error('unreachable');
        expect(JSON.parse(gunzipToString(out.payload))).toEqual(result);
    });

    it('gzip backend, no cached blob, small result: skips compression entirely', () => {
        const result = { mode: 'structured', document: { pageCount: 1, pages: [] } };
        const out = finalize(
            makeRequest({ accept_encoding: ['gzip'], max_payload_bytes: 14e6, max_decompressed_bytes: 64e6 }),
            result,
        );
        expect(isWSBinaryEnvelope(out)).toBe(false);
        expect((out as WSZoteroDocumentResponse).result).toBe(result);
    });

    it('looks up the cache blob by the cache source object, not the response copy', () => {
        const cacheSource = { mode: 'structured', document: { pageCount: 1, pages: [] } };
        const spread = { ...cacheSource, content_kind: 'pdf' };
        takeGzipPayload.mockReturnValue(gzWithClaimedSize(SMALL_PAYLOAD_THRESHOLD_BYTES + 1));

        finalize(
            makeRequest({ accept_encoding: ['gzip'], max_payload_bytes: 14e6, max_decompressed_bytes: 64e6 }),
            spread,
            cacheSource,
        );
        expect(takeGzipPayload).toHaveBeenCalledWith(cacheSource);
    });
});

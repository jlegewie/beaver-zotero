/**
 * `readBackendDocument`: the document a table fill posts is the one the chat
 * socket would have sent for the same request, serialized once — EPUB and
 * snapshot documents without their citation index — and a failed read
 * comes back as its error code.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/transport/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: { toString: () => 'searchableLibraryIdsAtom' },
}));
vi.mock('../../../src/services/documentExtraction', async () => {
    const actual = await vi.importActual<typeof import('../../../src/services/documentExtraction')>(
        '../../../src/services/documentExtraction',
    );
    return {
        ...actual,
        resolveToReadableAttachment: vi.fn(),
        validateZoteroItemReference: vi.fn(() => null),
    };
});
vi.mock('../../../src/services/documentExtractionCore', () => ({
    extractAndCacheEpubDocument: vi.fn(),
    extractAndCacheResolvedPdfDocument: vi.fn(),
    extractAndCacheSnapshotDocument: vi.fn(),
}));

import { readBackendDocument } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';
import { resolveToReadableAttachment } from '../../../src/services/documentExtraction';
import { extractAndCacheSnapshotDocument } from '../../../src/services/documentExtractionCore';

const snapshot = {
    schemaVersion: '1',
    sections: [{ id: 's1', blocks: [] }],
    citationIndex: { s1: { section: 0 } },
};

function item() {
    return {
        id: 9,
        key: 'SNAP0001',
        libraryID: 1,
        parentItemID: null,
        isAttachment: () => true,
        isTopLevelItem: () => true,
        hasTag: () => false,
        getField: () => '',
        loadAllData: vi.fn().mockResolvedValue(undefined),
        loadDataType: vi.fn().mockResolvedValue(undefined),
        numAnnotations: () => 0,
        attachmentFilename: 'page.html',
        attachmentContentType: 'text/html',
    };
}

const request = {
    event: 'zotero_document_request' as const,
    request_id: 'req-fill',
    attachment: { library_id: 1, zotero_key: 'SNAP0001' },
    mode: 'structured' as const,
};

describe('readBackendDocument', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Libraries.userLibraryID = 1;
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(item()),
            getAsync: vi.fn().mockResolvedValue(null),
        };
        vi.mocked(resolveToReadableAttachment).mockImplementation(
            async (resolved: any) =>
                ({ resolved: true, item: resolved, key: '1-SNAP0001', contentKind: 'snapshot', contentType: 'text/html' }) as any,
        );
    });

    it('returns the backend projection serialized, as the socket sends it', async () => {
        vi.mocked(extractAndCacheSnapshotDocument).mockResolvedValue({
            kind: 'ok',
            document: snapshot,
            cached: false,
            contentType: 'text/html',
            resolvedAttachment: { libraryId: 1, zoteroKey: 'SNAP0001' },
        } as any);
        const read = await readBackendDocument(request);
        expect(read.ok).toBe(true);
        if (!read.ok) return;
        expect(read.contentKind).toBe('snapshot');
        expect(JSON.parse(read.json)).toEqual({ schemaVersion: '1', sections: [{ id: 's1', blocks: [] }] });
    });

    it('returns a failed read as its error code', async () => {
        vi.mocked(extractAndCacheSnapshotDocument).mockResolvedValue({
            kind: 'error',
            code: 'empty_document',
            message: 'Nothing to read.',
        } as any);
        expect(await readBackendDocument(request)).toMatchObject({
            ok: false,
            code: 'empty_document',
            contentKind: 'snapshot',
        });
    });
});

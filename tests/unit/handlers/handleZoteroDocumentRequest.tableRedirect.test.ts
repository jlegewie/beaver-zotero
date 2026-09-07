/**
 * `read` on a stored table: a Beaver table is a snapshot attachment, so search
 * surfaces it and the model tries to read it like any other document. The
 * handler must answer with the table's handle and the `beaver_table` code
 * instead of extracting the rendered HTML.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The handler module's import chain reaches supabaseClient (which throws
// without env config) — stub it and its store dependencies like the
// companion handler tests do.
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

import { handleZoteroDocumentRequest } from '../../../src/services/agentDataProvider/handleZoteroDocumentRequest';
import { resolveToReadableAttachment } from '../../../src/services/documentExtraction';
import { getReadableContentKind } from '../../../src/services/documentExtraction/attachmentResolution';
import { TABLE_TAG, TABLE_URL_PREFIX } from '../../../src/services/artifacts/tableItemIdentity';

/** An item that satisfies the real `isTableItem` marks. */
function makeTableItem(overrides: Record<string, unknown> = {}) {
    return {
        id: 7,
        key: 'TBL12345',
        libraryID: 1,
        attachmentLinkMode: (globalThis as any).Zotero.Attachments.LINK_MODE_IMPORTED_URL,
        attachmentContentType: 'text/html',
        isAttachment: () => true,
        isTopLevelItem: () => true,
        isPDFAttachment: () => false,
        hasTag: (tag: string) => tag === TABLE_TAG,
        getField: (field: string) => (field === 'url' ? `${TABLE_URL_PREFIX}my-table` : ''),
        loadAllData: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function documentRequest() {
    return {
        event: 'zotero_document_request' as const,
        request_id: 'req-table',
        attachment: { library_id: 1, zotero_key: 'TBL12345' },
        mode: 'structured' as const,
    };
}

describe('handleZoteroDocumentRequest table redirect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.Libraries.userLibraryID = 1;
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn().mockResolvedValue(makeTableItem()),
        };
        vi.mocked(resolveToReadableAttachment).mockImplementation(
            async (item: any) =>
                ({
                    resolved: true,
                    item,
                    key: '1-TBL12345',
                    contentKind: 'snapshot',
                    contentType: 'text/html',
                }) as any,
        );
    });

    it('answers a table item with beaver_table and its portable handle', async () => {
        const response = await handleZoteroDocumentRequest(documentRequest());

        expect(response).toMatchObject({
            type: 'zotero_document',
            request_id: 'req-table',
            error_code: 'beaver_table',
        });
        expect(response.error).toContain('u-TBL12345');
        expect(response.error).toContain('Beaver table');
    });

    // The redirect is guarded on `contentKind === 'snapshot'`, so a table that
    // classified as anything else would silently fall through to extraction.
    it('classifies a table item as a snapshot', () => {
        expect(getReadableContentKind(makeTableItem() as any)).toBe('snapshot');
    });

    it('leaves an ordinary snapshot attachment on the extraction path', async () => {
        // Same item without the tag: not one of ours, so the redirect must not fire.
        (globalThis as any).Zotero.Items.getByLibraryAndKeyAsync = vi
            .fn()
            .mockResolvedValue(makeTableItem({ hasTag: () => false }));

        const response = await handleZoteroDocumentRequest(documentRequest());

        expect(response.error_code).not.toBe('beaver_table');
    });
});

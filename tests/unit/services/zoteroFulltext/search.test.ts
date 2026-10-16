import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchable = vi.hoisted(() => ({ ids: [1, 2] as number[] }));

vi.mock('../../../../src/services/agentDataProvider/utils', () => ({
    getSearchableLibraryIds: () => [...searchable.ids],
    isLibraryAccessReady: () => true,
    librariesFilterError: () => null,
    resolveLibrariesFilter: () => ({ libraryIds: [], unresolved: [], excluded: [] }),
}));
vi.mock('../../../../src/services/agentDataProvider/handleResolveSearchFiltersRequest', () => ({
    handleResolveSearchFiltersRequest: vi.fn(),
}));
vi.mock('../../../../src/services/documentExtraction/attachmentSource', () => ({ resolveAttachmentFileSource: vi.fn() }));
vi.mock('../../../../src/utils/zoteroSerializers', () => ({
    serializeAttachmentStub: vi.fn(), serializeItemStub: vi.fn(), safeStub: vi.fn(),
}));
vi.mock('../../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: (id: number) => (id === 1 ? 'u' : `g${id}`),
    resolveLibraryRef: (ref: { library_id: number }) => ref.library_id,
}));

import { withoutRevokedLibraries } from '../../../../src/services/zoteroFulltext/search';
import type { WSZoteroFulltextSearchResponse } from '../../../../packages/agent-core/src/protocol/agentProtocol';

const ref = (library: number, key: string) => ({ library_id: library, zotero_key: key });

function response(): WSZoteroFulltextSearchResponse {
    return {
        type: 'zotero_fulltext_search',
        request_id: 'r',
        status: 'ok',
        engine: 'fts5',
        terms: ['x'],
        documents: [
            { attachment: ref(2, 'BBBB'), content_kind: 'pdf', stage1_rank: 1, passage_source: 'zotero' },
            { attachment: ref(1, 'AAAA'), content_kind: 'pdf', stage1_rank: 2, passage_source: 'zotero' },
        ],
        passages: [
            { document: 0, rank: 1, text: 'from group', page_index: 0 },
            { document: 1, rank: 2, text: 'from user', page_index: 1 },
        ],
        dropped: [{ attachment: ref(2, 'CCCC'), reason: 'timeout' }],
        unindexed_attachments: [ref(2, 'DDDD'), ref(1, 'EEEE')],
        coverage: { total: 10, indexed: 9, partial: 0 },
    };
}

describe('withoutRevokedLibraries', () => {
    beforeEach(() => { searchable.ids = [1, 2]; });

    it('returns the response unchanged while every scope library is searchable', () => {
        const original = response();
        expect(withoutRevokedLibraries(original, [1, 2])).toBe(original);
    });

    it('removes data from a library excluded during the search', () => {
        searchable.ids = [1];
        const filtered = withoutRevokedLibraries(response(), [1, 2]);
        expect(filtered.documents.map((d) => d.attachment.zotero_key)).toEqual(['AAAA']);
        expect(filtered.passages).toEqual([{ document: 0, rank: 1, text: 'from user', page_index: 1 }]);
        expect(filtered.dropped).toBeUndefined();
        expect(filtered.unindexed_attachments).toEqual([ref(1, 'EEEE')]);
        expect(filtered.coverage).toBeUndefined();
    });

    it('reports no matches when nothing searchable is left', () => {
        searchable.ids = [];
        const filtered = withoutRevokedLibraries(response(), [1, 2]);
        expect(filtered.status).toBe('no_matches');
        expect(filtered.documents).toEqual([]);
    });
});

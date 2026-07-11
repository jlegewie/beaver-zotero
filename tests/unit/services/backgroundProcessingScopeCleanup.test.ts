import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listAllRefs } = vi.hoisted(() => ({ listAllRefs: vi.fn() }));

vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({
    searchIndexApiClient: { listAllRefs },
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getIndexScopeRef: vi.fn(() => 'lLOCAL123'),
    getZoteroUserIdentifier: vi.fn(() => ({ localUserKey: 'LOCAL123' })),
}));
vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

import { purgeExcludedLibraries } from '../../../src/services/backgroundProcessing/exclusionCleanup';

describe('background processing scope cleanup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listAllRefs.mockResolvedValue([
            { zotero_key: 'REMOTE01', doc_hash: 'b'.repeat(64) },
        ]);
    });

    it('purges local derived state and durably untags only an explicitly excluded library', async () => {
        const db = {
            getAttachmentProcessingStatesByLibrary: vi.fn(async () => [{
                libraryId: 1,
                zoteroKey: 'LOCAL001',
                itemId: 10,
                contentKind: 'pdf',
                structuredDocumentHash: 'a'.repeat(64),
                upsertStatus: 'done',
            }]),
            deleteBackgroundJobsByLibrary: vi.fn(async () => undefined),
            enqueueBackgroundJobs: vi.fn(async () => []),
            deleteAttachmentProcessingStatesByLibrary: vi.fn(async () => undefined),
            deleteProcessingIndexState: vi.fn(async () => undefined),
        };
        const invalidateByLibrary = vi.fn(async () => undefined);
        (globalThis as any).Zotero.Beaver = {
            db,
            searchableLibraryIds: [],
            documentCache: { invalidateByLibrary },
            backgroundExtractor: { notify: vi.fn() },
        };

        await purgeExcludedLibraries([1], true, () => false);

        expect(db.deleteBackgroundJobsByLibrary).toHaveBeenCalledWith(1);
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({
                jobType: 'fulltext_untag',
                zoteroKey: 'LOCAL001',
                payload: expect.objectContaining({ doc_hash: 'a'.repeat(64) }),
            }),
            expect.objectContaining({
                jobType: 'fulltext_untag',
                zoteroKey: 'REMOTE01',
                payload: expect.objectContaining({ doc_hash: 'b'.repeat(64) }),
            }),
        ]));
        expect(invalidateByLibrary).toHaveBeenCalledWith(1);
        expect(db.deleteAttachmentProcessingStatesByLibrary).toHaveBeenCalledWith(1);
        expect(db.deleteProcessingIndexState).toHaveBeenCalledWith(1);
    });

    it('reports completion once both local ledger and remote refs are empty', async () => {
        listAllRefs.mockResolvedValueOnce([]);
        const db = {
            getAttachmentProcessingStatesByLibrary: vi.fn(async () => []),
            deleteBackgroundJobsByLibrary: vi.fn(async () => undefined),
            enqueueBackgroundJobs: vi.fn(async () => []),
            deleteAttachmentProcessingStatesByLibrary: vi.fn(async () => undefined),
            deleteProcessingIndexState: vi.fn(async () => undefined),
        };
        (globalThis as any).Zotero.Beaver = {
            db,
            searchableLibraryIds: [],
            documentCache: { invalidateByLibrary: vi.fn(async () => undefined) },
            backgroundExtractor: { notify: vi.fn() },
        };

        const completed = await purgeExcludedLibraries([1], true, () => false);

        expect(completed).toEqual(new Set([1]));
        expect(db.enqueueBackgroundJobs).not.toHaveBeenCalled();
    });
});

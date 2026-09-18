import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listAllRefs } = vi.hoisted(() => ({ listAllRefs: vi.fn() }));

vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({
    searchIndexApiClient: { listAllRefs },
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getIndexScopeRef: vi.fn(() => 'lLOCAL123'),
    getZoteroUserIdentifier: vi.fn(() => ({ localUserKey: 'LOCAL123' })),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { getIndexScopeRef } from '../../../src/utils/zoteroUtils';
import { purgeExcludedLibraries } from '../../../src/services/backgroundProcessing/exclusionCleanup';

describe('background processing scope cleanup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getIndexScopeRef).mockReturnValue('lLOCAL123');
        listAllRefs.mockResolvedValue([
            { zotero_key: 'REMOTE01', doc_hash: 'b'.repeat(64) },
        ]);
    });

    it.each([true, false])('purges excluded-library refs with search entitlement %s', async (hasAccess) => {
        const db = {
            getAttachmentProcessingStatesByLibrary: vi.fn(async () => [{
                libraryId: 1,
                zoteroKey: 'LOCAL001',
                itemId: 10,
                contentKind: 'pdf',
                structuredDocumentHash: 'a'.repeat(64),
                upsertStatus: 'done',
                upsertRemoteIdentity: { index_account_id: 'account-b', index_scope_ref: 'g123', index_local_id: 'OLDDEVICE' },
            }]),
            deleteBackgroundJobsByLibrary: vi.fn(async () => undefined),
            enqueueBackgroundJobs: vi.fn(async () => []),
            deleteAttachmentProcessingStatesByLibrary: vi.fn(async () => undefined),
            deleteProcessingIndexState: vi.fn(async () => undefined),
        };
        const invalidateByLibrary = vi.fn(async () => undefined);
        (globalThis as any).Zotero.Beaver = {
            db,
            account: { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'account-a' } } }) },
            searchableLibraryIds: [],
            documentCache: { invalidateByLibrary },
            backgroundExtractor: { notify: vi.fn() },
        };

        await purgeExcludedLibraries([1], () => false);

        expect(db.deleteBackgroundJobsByLibrary).toHaveBeenCalledWith(1);
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({
                jobType: 'fulltext_untag',
                zoteroKey: 'LOCAL001',
                payload: expect.objectContaining({ doc_hash: 'a'.repeat(64), index_account_id: 'account-b', index_scope_ref: 'g123', index_local_id: 'OLDDEVICE' }),
            }),
            expect.objectContaining({
                jobType: 'fulltext_untag',
                zoteroKey: 'REMOTE01',
                payload: expect.objectContaining({ doc_hash: 'b'.repeat(64), index_account_id: 'account-a', index_scope_ref: 'lLOCAL123', index_local_id: 'LOCAL123' }),
            }),
        ]));
        expect(invalidateByLibrary).toHaveBeenCalledWith(1);
        expect(db.deleteAttachmentProcessingStatesByLibrary).toHaveBeenCalledWith(1);
        expect(db.deleteProcessingIndexState).toHaveBeenCalledWith(1);
    });

    it.each([true, false])('preserves ledger ownership with a resolvable current scope: %s', async (scopeKnown) => {
        if (!scopeKnown) vi.mocked(getIndexScopeRef).mockReturnValue(null);
        const hash = 'a'.repeat(64);
        listAllRefs.mockResolvedValue([{ zotero_key: 'SAMEKEY1', doc_hash: hash }]);
        const identity = { index_account_id: 'account-b', index_scope_ref: 'g123', index_local_id: 'OLDDEVICE' };
        const row = { libraryId: 1, zoteroKey: 'SAMEKEY1', itemId: 10, contentKind: 'pdf',
            structuredDocumentHash: hash, upsertStatus: null, upsertRemoteIdentity: identity };
        const db = {
            getAttachmentProcessingStatesByLibrary: vi.fn(async () => [row, { ...row, zoteroKey: 'NEVERUP1', upsertRemoteIdentity: null }]),
            deleteBackgroundJobsByLibrary: vi.fn(), enqueueBackgroundJobs: vi.fn(),
            deleteAttachmentProcessingStatesByLibrary: vi.fn(), deleteProcessingIndexState: vi.fn(),
        };
        Zotero.Beaver = { db, searchableLibraryIds: [],
            account: { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'account-a' } } }) },
        } as any;
        await purgeExcludedLibraries([1], () => false);
        const jobs = db.enqueueBackgroundJobs.mock.calls[0][0];
        expect(jobs).toHaveLength(scopeKnown ? 2 : 1);
        expect(jobs[0].payload).toMatchObject({ ...identity, doc_hash: hash });
        expect(jobs.some((job: any) => job.zoteroKey === 'NEVERUP1')).toBe(false);
        if (scopeKnown) expect(jobs[1].payload).toMatchObject({ index_account_id: 'account-a', index_scope_ref: 'lLOCAL123', doc_hash: hash });
        else expect(listAllRefs).not.toHaveBeenCalled();
    });

    it('deduplicates listed membership while retaining the ledger content kind', async () => {
        const hash = 'a'.repeat(64);
        listAllRefs.mockResolvedValue([{ zotero_key: 'SAMEKEY1', doc_hash: hash }]);
        const db = {
            getAttachmentProcessingStatesByLibrary: vi.fn(async () => [{
                libraryId: 1, zoteroKey: 'SAMEKEY1', itemId: 10, contentKind: 'epub', structuredDocumentHash: hash,
                upsertRemoteIdentity: { index_account_id: 'account-a', index_scope_ref: 'lLOCAL123', index_local_id: 'LOCAL123' },
            }]),
            deleteBackgroundJobsByLibrary: vi.fn(), enqueueBackgroundJobs: vi.fn(),
            deleteAttachmentProcessingStatesByLibrary: vi.fn(), deleteProcessingIndexState: vi.fn(),
        };
        Zotero.Beaver = { db, searchableLibraryIds: [],
            account: { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'account-a' } } }) },
        } as any;
        await purgeExcludedLibraries([1], () => false);
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith([expect.objectContaining({
            contentKind: 'epub', payload: expect.objectContaining({ content_kind: 'epub', doc_hash: hash }),
        })]);
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
            account: { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'account-a' } } }) },
            searchableLibraryIds: [],
            documentCache: { invalidateByLibrary: vi.fn(async () => undefined) },
            backgroundExtractor: { notify: vi.fn() },
        };

        const completed = await purgeExcludedLibraries([1], () => false);

        expect(completed).toEqual(new Set([1]));
        expect(db.enqueueBackgroundJobs).not.toHaveBeenCalled();
    });
});

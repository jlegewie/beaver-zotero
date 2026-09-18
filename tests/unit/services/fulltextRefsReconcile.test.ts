import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verify, requirements, enabled } = vi.hoisted(() => ({ verify: vi.fn(), requirements: vi.fn(), enabled: vi.fn(() => true) }));
vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({ searchIndexApiClient: { verify, requirements } }));
vi.mock('../../../src/services/backgroundProcessing/utils', () => ({
    backgroundProcessingEnabled: vi.fn(() => true),
    isBackgroundProcessingLibraryEnabled: enabled,
    buildIndexJobPayload: vi.fn((_kind, options) => ({ content_kind: 'pdf', doc_hash: options.docHash })),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getIndexScopeRef: vi.fn(() => 'lLOCAL123'),
    getZoteroUserIdentifier: vi.fn(() => ({ localUserKey: 'LOCAL123' })),
}));
import { reconcileRemoteRefs } from '../../../src/services/backgroundProcessing/remoteRefsReconcile';

const row = (key = 'LOCAL001') => ({ libraryId: 1, zoteroKey: key, itemId: 10, contentKind: 'pdf', structuredDocumentHash: 'a'.repeat(64), extractStatus: 'done', extractSchemaVersion: '4', upsertStatus: 'done', upsertIndexVersion: '3' });

describe('strong fulltext reconciliation', () => {
    let db: any;
    beforeEach(() => {
        vi.clearAllMocks();
        enabled.mockReturnValue(true);
        requirements.mockResolvedValue({ index_version: 3, extract_schema_versions: { pdf: ['4'], epub: ['2'], snapshot: ['1'] } });
        verify.mockImplementation(async (_device, refs) => ({ checked_at: '2026-09-17T00:00:00Z', refs: refs.map((ref: any) => ({ ...ref, state: 'current', index_version: 3, extract_schema_version: '4', chunk_count: 1 })) }));
        db = { getAttachmentProcessingStatesByLibrary: vi.fn(async () => [row()]), markAttachmentUpsertDone: vi.fn(), enqueueBackgroundJobs: vi.fn() };
        (globalThis as any).Zotero.Beaver = { hasSearchIndexAccess: true, db, backgroundExtractor: { notify: vi.fn() } };
    });
    it('never deletes remote data when this device has an empty ledger', async () => {
        db.getAttachmentProcessingStatesByLibrary.mockResolvedValue([]);
        await reconcileRemoteRefs([1], () => false);
        expect(verify).not.toHaveBeenCalled();
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith([]);
    });
    it('adopts server-confirmed membership with conditional local writes', async () => {
        await reconcileRemoteRefs([1], () => false);
        expect(db.markAttachmentUpsertDone).toHaveBeenCalledWith(expect.objectContaining({ expectedUpsertStatus: 'done', expectedUpsertIndexVersion: '3', structuredDocumentHash: row().structuredDocumentHash }));
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith([]);
    });
    it('routes confirmed membership through ownership transfer after switching accounts', async () => {
        Zotero.Beaver.account = { getSnapshot: () => ({ session: { user: { id: 'account-b' } } }) } as any;
        db.getAttachmentProcessingStatesByLibrary.mockResolvedValue([{ ...row(), upsertRemoteIdentity: {
            index_account_id: 'account-a', index_scope_ref: 'lLOCAL123', index_local_id: 'LOCAL123',
        } }]);
        await reconcileRemoteRefs([1], () => false);
        expect(db.markAttachmentUpsertDone).not.toHaveBeenCalled();
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith([expect.objectContaining({ jobType: 'fulltext_upsert' })]);
    });
    it.each(['missing', 'obsolete', 'pending'])('repairs %s membership despite historical upload success', async (state) => {
        verify.mockResolvedValue({ refs: [{ scope_ref: 'lLOCAL123', zotero_key: 'LOCAL001', doc_hash: row().structuredDocumentHash, state }] });
        await reconcileRemoteRefs([1], () => false);
        expect(db.markAttachmentUpsertDone).not.toHaveBeenCalled();
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith([expect.objectContaining({ jobType: 'fulltext_upsert' })]);
    });
    it('does not interpret transport failure as missing membership', async () => {
        verify.mockRejectedValue(new Error('offline'));
        await expect(reconcileRemoteRefs([1], () => false)).rejects.toThrow('offline');
        expect(db.markAttachmentUpsertDone).not.toHaveBeenCalled();
        expect(db.enqueueBackgroundJobs).not.toHaveBeenCalled();
    });
    it('limits verification to 50 exact references per request', async () => {
        db.getAttachmentProcessingStatesByLibrary.mockResolvedValue(Array.from({ length: 101 }, (_, i) => row(String(i))));
        await reconcileRemoteRefs([1], () => false);
        expect(verify.mock.calls.map((call) => call[1].length)).toEqual([50, 50, 1]);
    });
    it('ignores late results after cancellation', async () => {
        let cancelled = false;
        verify.mockImplementation(async () => { cancelled = true; return { refs: [] }; });
        await reconcileRemoteRefs([1], () => cancelled);
        expect(db.enqueueBackgroundJobs).not.toHaveBeenCalled();
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verify, requirements, enabled } = vi.hoisted(() => ({ verify: vi.fn(), requirements: vi.fn(), enabled: vi.fn(() => true) }));
vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({ searchIndexApiClient: { verify, requirements } }));
vi.mock('../../../src/services/backgroundProcessing/utils', () => ({
    backgroundProcessingEnabled: vi.fn(() => true),
    isBackgroundProcessingLibraryEnabled: enabled,
    buildIndexJobPayload: vi.fn((_kind, options) => ({ content_kind: 'pdf', doc_hash: options.docHash })),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getIndexScopeRef: vi.fn((id: number) => id === 1 ? 'lLOCAL123' : `g${id}`),
    getZoteroUserIdentifier: vi.fn(() => ({ localUserKey: 'LOCAL123' })),
}));
import { reconcileRemoteRefs } from '../../../src/services/backgroundProcessing/remoteRefsReconcile';

const row = (key = 'LOCAL001') => ({ libraryId: 1, zoteroKey: key, itemId: 10, contentKind: 'pdf', structuredDocumentHash: 'a'.repeat(64), extractStatus: 'done', extractSchemaVersion: '4', upsertStatus: 'done', upsertIndexVersion: '3' });
const current = { index_version: 3, index_validity: 'current', index_incarnation: 'epoch', extract_schema_versions: { pdf: ['4'], epub: ['1'], snapshot: ['1'] } };

describe('bounded fulltext recovery', () => {
    let db: any;
    let owner: any;
    let generation: number;
    beforeEach(() => {
        vi.clearAllMocks();
        enabled.mockReturnValue(true);
        requirements.mockResolvedValue(current);
        generation = 1;
        db = { getAttachmentIndexRecoveryCandidates: vi.fn(async () => [row()]), markAttachmentUpsertDone: vi.fn(), enqueueBackgroundJobs: vi.fn() };
        owner = { hasSearchIndexAccess: true, db, backgroundExtractor: { notify: vi.fn() },
            account: { getGeneration: () => generation, getSnapshot: () => ({ session: { user: { id: 'account' } } }) },
            background: { searchReadiness: { setRequirements: vi.fn(), getSummary: vi.fn(() => null) } } };
        (globalThis as any).Zotero.Beaver = owner;
    });
    it('does no verification or deletion when the device has an empty ledger', async () => {
        db.getAttachmentIndexRecoveryCandidates.mockResolvedValue([]);
        await reconcileRemoteRefs([1], () => false);
        expect(verify).not.toHaveBeenCalled();
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith([]);
        expect(db.markAttachmentUpsertDone).not.toHaveBeenCalled();
    });
    it('recovers through ordinary upserts bound to the current account and incarnation', async () => {
        await reconcileRemoteRefs([1], () => false);
        expect(db.getAttachmentIndexRecoveryCandidates).toHaveBeenCalledWith(1, {
            accountId: 'account', scopeRef: 'lLOCAL123', localId: 'LOCAL123', incarnation: 'epoch', indexVersion: 3,
        }, 50);
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith([expect.objectContaining({ jobType: 'fulltext_upsert',
            payload: expect.objectContaining({ recovery_incarnation: 'epoch', doc_hash: row().structuredDocumentHash }) })]);
        expect(db.markAttachmentUpsertDone).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
    });
    it('refreshes validity without querying the ledger when selection is not requested', async () => {
        await reconcileRemoteRefs([1], () => false, () => false);
        expect(requirements).toHaveBeenCalledTimes(1);
        expect(owner.background.searchReadiness.setRequirements).toHaveBeenCalled();
        expect(db.getAttachmentIndexRecoveryCandidates).not.toHaveBeenCalled();
    });
    it('does not query the ledger against a legacy requirements contract', async () => {
        requirements.mockResolvedValue({ index_version: 3, extract_schema_versions: current.extract_schema_versions });
        const select = vi.fn(() => true);
        await reconcileRemoteRefs([1], () => false, select);
        expect(select).not.toHaveBeenCalled();
        expect(db.getAttachmentIndexRecoveryCandidates).not.toHaveBeenCalled();
    });
    it('does not recover during unknown validity or a transport outage', async () => {
        requirements.mockResolvedValueOnce({ ...current, index_validity: 'unknown', index_incarnation: null });
        const select = vi.fn(() => true);
        await reconcileRemoteRefs([1], () => false, select);
        expect(select).not.toHaveBeenCalled();
        expect(db.getAttachmentIndexRecoveryCandidates).not.toHaveBeenCalled();
        requirements.mockRejectedValueOnce(new Error('offline'));
        await expect(reconcileRemoteRefs([1], () => false)).rejects.toThrow('offline');
        expect(db.enqueueBackgroundJobs).not.toHaveBeenCalled();
    });
    it('recovers a missing index without acknowledging local successes', async () => {
        requirements.mockResolvedValue({ ...current, index_validity: 'missing', index_incarnation: null });
        await reconcileRemoteRefs([1], () => false);
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith([expect.objectContaining({ payload: expect.objectContaining({ recovery_incarnation: null }) })]);
        expect(db.markAttachmentUpsertDone).not.toHaveBeenCalled();
    });
    it('shares the fifty-job limit across libraries and leaves excluded libraries untouched', async () => {
        enabled.mockImplementation(id => id !== 2);
        db.getAttachmentIndexRecoveryCandidates.mockImplementation(async (_id, _identity, limit) =>
            Array.from({ length: Math.min(30, limit) }, (_, i) => row(String(i))));
        await reconcileRemoteRefs([1, 2, 3, 4], () => false);
        expect(db.getAttachmentIndexRecoveryCandidates.mock.calls.map((args: any[]) => [args[0], args[2]])).toEqual([[1, 50], [3, 20]]);
        expect(db.enqueueBackgroundJobs.mock.calls[0][0]).toHaveLength(50);
        expect(verify).not.toHaveBeenCalled();
    });
    it('does no attachment reads for a settled current summary', async () => {
        owner.background.searchReadiness.getSummary.mockReturnValue({ index_incarnation: 'epoch', libraries: [{ discovery_complete: true, pending: 0 }] });
        await reconcileRemoteRefs([1], () => false);
        expect(requirements).toHaveBeenCalledTimes(1);
        expect(db.getAttachmentIndexRecoveryCandidates).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
    });
    it.each(['requirements', 'ledger'])('ignores late %s results after an account switch', async stage => {
        if (stage === 'requirements') requirements.mockImplementation(async () => { generation++; return current; });
        else db.getAttachmentIndexRecoveryCandidates.mockImplementation(async () => { generation++; return [row()]; });
        await reconcileRemoteRefs([1], () => false);
        expect(db.enqueueBackgroundJobs).not.toHaveBeenCalled();
    });
    it('ignores late results after cancellation', async () => {
        let cancelled = false;
        requirements.mockImplementation(async () => { cancelled = true; return current; });
        await reconcileRemoteRefs([1], () => cancelled);
        expect(db.enqueueBackgroundJobs).not.toHaveBeenCalled();
    });
});

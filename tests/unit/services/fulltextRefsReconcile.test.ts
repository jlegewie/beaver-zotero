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
const current = { index_version: 3, index_validity: 'current', namespace_generation: 2, extract_schema_versions: { pdf: ['4'], epub: ['1'], snapshot: ['1'] } };

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
    it('recovers through ordinary upserts bound to the current account and namespace generation', async () => {
        await reconcileRemoteRefs([1], () => false);
        expect(db.getAttachmentIndexRecoveryCandidates).toHaveBeenCalledWith(1, {
            accountId: 'account', scopeRef: 'lLOCAL123', localId: 'LOCAL123', namespaceGeneration: 2, indexVersion: 3,
        }, 50);
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith([expect.objectContaining({ jobType: 'fulltext_upsert',
            payload: expect.objectContaining({ doc_hash: row().structuredDocumentHash }) })]);
        expect(db.markAttachmentUpsertDone).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
    });
    it('does not query the ledger against a legacy requirements contract', async () => {
        requirements.mockResolvedValue({ index_version: 3, extract_schema_versions: current.extract_schema_versions });
        await reconcileRemoteRefs([1], () => false);
        expect(db.getAttachmentIndexRecoveryCandidates).not.toHaveBeenCalled();
    });
    it('does not recover during unknown validity or a transport outage', async () => {
        requirements.mockResolvedValueOnce({ ...current, index_validity: 'unknown', namespace_generation: null });
        await reconcileRemoteRefs([1], () => false);
        expect(db.getAttachmentIndexRecoveryCandidates).not.toHaveBeenCalled();
        requirements.mockRejectedValueOnce(new Error('offline'));
        await expect(reconcileRemoteRefs([1], () => false)).rejects.toThrow('offline');
        expect(db.enqueueBackgroundJobs).not.toHaveBeenCalled();
    });
    it('does not repeatedly recover against incarnation-only requirements', async () => {
        requirements.mockResolvedValue({ index_version: 3, extract_schema_versions: current.extract_schema_versions,
            index_validity: 'current', index_incarnation: 'legacy' });
        expect(await reconcileRemoteRefs([1], () => false)).toBe(0);
        expect(await reconcileRemoteRefs([1], () => false)).toBe(0);
        expect(db.getAttachmentIndexRecoveryCandidates).not.toHaveBeenCalled();
        expect(db.enqueueBackgroundJobs).not.toHaveBeenCalled();
        expect(owner.backgroundExtractor.notify).not.toHaveBeenCalled();
    });
    it.each([undefined, null, 0, -1, 1.5, '2', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'rejects an invalid namespace generation: %s', async namespace_generation => {
            requirements.mockResolvedValue({ ...current, namespace_generation });
            expect(await reconcileRemoteRefs([1], () => false)).toBe(0);
            expect(db.getAttachmentIndexRecoveryCandidates).not.toHaveBeenCalled();
            expect(db.enqueueBackgroundJobs).not.toHaveBeenCalled();
        },
    );
    it('recovers a missing index using its current generation without acknowledging local successes', async () => {
        requirements.mockResolvedValue({ ...current, index_validity: 'missing', namespace_generation: 2 });
        await reconcileRemoteRefs([1], () => false);
        expect(db.getAttachmentIndexRecoveryCandidates).toHaveBeenCalledWith(1, expect.objectContaining({ namespaceGeneration: 2 }), 50);
        expect(db.enqueueBackgroundJobs).toHaveBeenCalledWith([expect.objectContaining({ payload: expect.objectContaining({ doc_hash: row().structuredDocumentHash }) })]);
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
        owner.background.searchReadiness.getSummary.mockReturnValue({ namespace_generation: 2, libraries: [{ discovery_complete: true, pending: 0 }] });
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

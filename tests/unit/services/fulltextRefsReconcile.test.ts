import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listAllRefs } = vi.hoisted(() => ({ listAllRefs: vi.fn() }));

vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({
    searchIndexApiClient: { listAllRefs },
}));
vi.mock('../../../src/services/backgroundProcessing/utils', () => ({
    backgroundProcessingEnabled: vi.fn(() => true),
    isBackgroundProcessingLibraryEnabled: vi.fn(() => true),
    buildIndexJobPayload: vi.fn(() => ({ content_kind: 'pdf' })),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getIndexScopeRef: vi.fn(() => 'lLOCAL123'),
    getZoteroUserIdentifier: vi.fn(() => ({ localUserKey: 'LOCAL123' })),
}));
vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

import { reconcileRemoteRefs } from '../../../src/services/backgroundProcessing/remoteRefsReconcile';

describe('fulltext refs reconciliation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listAllRefs.mockResolvedValue([
            { zotero_key: 'REMOTE01', doc_hash: 'a'.repeat(64) },
        ]);
    });

    it('never treats an empty or warming local ledger as permission to untag remote refs', async () => {
        const enqueueBackgroundJobs = vi.fn(async () => []);
        (globalThis as any).Zotero.Beaver = {
            hasSearchIndexAccess: true,
            db: {
                getAttachmentProcessingStatesByLibrary: vi.fn(async () => []),
                enqueueBackgroundJobs,
            },
            backgroundExtractor: { notify: vi.fn() },
        };

        await reconcileRemoteRefs([1], () => false);

        expect(listAllRefs).toHaveBeenCalled();
        for (const [jobs] of enqueueBackgroundJobs.mock.calls) {
            expect(jobs).toEqual([]);
        }
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listRefs } = vi.hoisted(() => ({ listRefs: vi.fn() }));

vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({
    searchIndexApiClient: { listRefs },
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

import { reconcileRemoteRefs } from '../../../react/hooks/useFulltextUpsertLane';

describe('fulltext refs reconciliation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        listRefs.mockResolvedValue({
            refs: [{ zotero_key: 'REMOTE01', doc_hash: 'a'.repeat(64) }],
            next_cursor: null,
        });
    });

    it('never treats an empty or warming local ledger as permission to untag remote refs', async () => {
        const enqueueBackgroundJob = vi.fn(async () => undefined);
        (globalThis as any).Zotero.Beaver = {
            hasSearchIndexAccess: true,
            db: {
                getAttachmentProcessingStatesByLibrary: vi.fn(async () => []),
                enqueueBackgroundJob,
            },
            backgroundExtractor: { notify: vi.fn() },
        };

        await reconcileRemoteRefs([1], () => false);

        expect(listRefs).toHaveBeenCalled();
        expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));

import { getSpecialCollectionItemCounts } from '../../../src/services/agentDataProvider/specialCollectionCounts';

describe('getSpecialCollectionItemCounts', () => {
    const queryAsync = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        (globalThis as any).Zotero.DB = { queryAsync };
        queryAsync.mockImplementation(async (_sql: string, _params: any[], opts: any) => {
            opts.onRow({ getResultByIndex: (i: number) => [5, 2, 1][i] });
        });
    });

    it('counts a view in the requested library', async () => {
        const counts = await getSpecialCollectionItemCounts('publications', 1);

        expect(counts).toEqual({ itemCount: 5, standaloneAttachmentCount: 2, standaloneNoteCount: 1 });
        const [sql, params] = queryAsync.mock.calls[0];
        expect(params).toEqual([1]);
        expect(sql).toContain('publicationsItems');
        expect(sql).toContain('deletedItems');
    });

    it('mirrors Zotero by leaving My Publications items out of Unfiled Items', async () => {
        await getSpecialCollectionItemCounts('unfiled', 3);

        const [sql, params] = queryAsync.mock.calls[0];
        expect(params).toEqual([3]);
        expect(sql).toContain('collectionItems');
        expect(sql).toContain('NOT IN (SELECT itemID FROM publicationsItems)');
    });

    it('counts trashed children of a live parent as their own rows', async () => {
        await getSpecialCollectionItemCounts('trash', 1);

        const [sql] = queryAsync.mock.calls[0];
        expect(sql).toContain('IA.parentItemID NOT IN (SELECT itemID FROM deletedItems)');
    });

    it('does not count Duplicate Items', async () => {
        expect(await getSpecialCollectionItemCounts('duplicates', 1)).toBeNull();
        expect(queryAsync).not.toHaveBeenCalled();
    });

    it('returns null instead of throwing when the query fails', async () => {
        queryAsync.mockRejectedValue(new Error('no such table'));

        expect(await getSpecialCollectionItemCounts('retracted', 1)).toBeNull();
    });
});

/**
 * Focused unit tests for getCollectionScopeItemIds
 * (src/services/agentDataProvider/utils.ts).
 *
 * The module has a wide transitive dependency surface (document extraction,
 * sync, popups, etc.) that getCollectionScopeItemIds itself never touches, so
 * every unrelated dependency is stubbed out just to make the module
 * importable in isolation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({
    logger: vi.fn(),
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    safeIsInTrash: vi.fn(),
    safeFileExists: vi.fn(),
    isLinkedUrlAttachment: vi.fn(),
}));
vi.mock('../../../src/utils/sync', () => ({
    syncingItemFilterAsync: vi.fn(),
}));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(),
}));
vi.mock('../../../src/utils/webAPI', () => ({
    isAttachmentOnServer: vi.fn(),
}));
vi.mock('../../../react/utils/popupMessageUtils', () => ({
    addPopupMessageAtom: {},
}));
vi.mock('../../../react/utils/sourceUtils', () => ({
    wasItemAddedBeforeLastSync: vi.fn(),
}));
vi.mock('../../../react/atoms/deferredToolPreferences', () => ({
    deferredToolPreferencesAtom: {},
}));
vi.mock('../../../src/utils/agentItemSupport', () => ({
    isAgentSupportedItem: vi.fn(),
}));
vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => [1, 100]) },
}));
vi.mock('@beaver/agent-core/run-state/atoms', () => ({
    activeRunAtom: Symbol('activeRunAtom'),
}));
vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfo', () => ({
    getAttachmentInfo: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfoBatch', () => ({
    getBestAttachmentBatch: vi.fn(),
    prepareAttachmentInfoBatchData: vi.fn(),
    processAttachmentInfoBatch: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction', () => ({
    loadPdfData: vi.fn(),
    isRemoteAccessAvailable: vi.fn(),
    validateZoteroItemReference: vi.fn(),
    checkRemotePdfSize: vi.fn(),
    preflightCachedPdfMeta: vi.fn(),
    resolveToPdfAttachment: vi.fn(),
    resolveToImageAttachment: vi.fn(),
}));

import { getCollectionScopeItemIds } from '../../../src/services/agentDataProvider/utils';

/** Item IDs held directly by each collection ID. */
const itemsByCollectionId = new Map<number, number[]>([
    [10, []],
    [11, [101, 102]],
    [12, [102, 103]],
    [20, [201]],
]);

/** Descendant collection IDs by collection ID (all levels). */
const descendantsByCollectionId = new Map<number, number[]>([
    [10, [11, 12]],
    [11, []],
    [12, []],
    [20, []],
]);

function collection(id: number): Zotero.Collection {
    return {
        id,
        getDescendents: vi.fn(() =>
            (descendantsByCollectionId.get(id) ?? []).map(descendantId => ({
                id: descendantId,
                key: `COLL${descendantId}`,
                name: `Collection ${descendantId}`,
                type: 'collection',
                level: 1,
                parent: id,
            }))
        ),
    } as unknown as Zotero.Collection;
}

describe('getCollectionScopeItemIds', () => {
    let previousZotero: any;
    let queryAsync: any;

    beforeEach(() => {
        vi.clearAllMocks();
        previousZotero = (globalThis as any).Zotero;
        queryAsync = vi.fn(async (_sql: string, params: number[], options: any) => {
            for (const collectionId of params) {
                for (const itemId of itemsByCollectionId.get(collectionId) ?? []) {
                    options.onRow({ getResultByIndex: () => itemId });
                }
            }
        });
        (globalThis as any).Zotero = {
            DB: { queryAsync },
        };
    });

    afterEach(() => {
        (globalThis as any).Zotero = previousZotero;
    });

    it('returns an empty array without querying the database', async () => {
        expect(await getCollectionScopeItemIds([])).toEqual([]);
        expect(queryAsync).not.toHaveBeenCalled();
    });

    it('includes items from subcollections when the parent holds none directly', async () => {
        const result = await getCollectionScopeItemIds([collection(10)]);

        expect(result.sort((a, b) => a - b)).toEqual([101, 102, 103]);
        expect(queryAsync).toHaveBeenCalledTimes(1);
        expect(queryAsync.mock.calls[0][1]).toEqual([10, 11, 12]);
        expect(queryAsync.mock.calls[0][0]).toContain('deletedItems');
    });

    it('returns an item once when it appears in several collections in the scope', async () => {
        const result = await getCollectionScopeItemIds([collection(10), collection(12), collection(20)]);

        expect(result.sort((a, b) => a - b)).toEqual([101, 102, 103, 201]);
        // Collection 12 is both an input and a descendant of collection 10, so
        // it is queried once.
        expect(queryAsync.mock.calls[0][1]).toEqual([10, 11, 12, 20]);
    });
});

import { describe, it, expect, vi } from 'vitest';
import { Action, ActionTargetType } from '@beaver/agent-core/types/actions';
import type { LibraryViewInfo, SelectedCollectionInfo, ZoteroContext } from '../../../react/atoms/zoteroContext';

// actionVisibility has Zotero/supabase-coupled value imports that run side
// effects at module load. Stub the leaf modules so importing the pure rules
// doesn't pull in that chain.
vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: () => true,
    isAgentSupportedItem: () => true,
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({ safeIsInTrash: () => false }));
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: () => 'Mock Item' }));

import {
    pureCollectionSelection,
    getActiveTarget,
    isActionVisible,
    computeActionGroups,
    ActionContext,
} from '../../../react/utils/actionVisibility';

const collection = (id: number, name: string, libraryId = 1): SelectedCollectionInfo => ({
    collectionId: id,
    collectionName: name,
    libraryId,
});

/**
 * A collections-tree selection. `rowCount` defaults to the number of
 * collections (a pure collection selection); pass a larger value to model a
 * selection that also contains non-collection rows.
 */
function libraryView(
    collections: SelectedCollectionInfo[],
    rowCount = collections.length,
    treeRowType: LibraryViewInfo['treeRowType'] = 'collection',
): LibraryViewInfo {
    return {
        treeRowType,
        libraryId: 1,
        libraryName: 'My Library',
        collectionId: collections[0]?.collectionId ?? null,
        collectionName: collections[0]?.collectionName ?? null,
        searchName: null,
        selectedRowCount: rowCount,
        selectedCollections: collections,
        selectedLibraryIds: [1],
    };
}

function ctx(view: LibraryViewInfo): ActionContext {
    return {
        zotero: {
            type: 'collection',
            isLibraryTab: true,
            selectedItemCount: 0,
            selectedItems: [],
            libraryView: view,
            selectedTags: [],
            readerAttachment: null,
            noteItem: null,
            recentlyAddedTodayCount: 0,
        } as ZoteroContext,
        manualItems: [],
    };
}

const action = (id: string, targets: ActionTargetType[]): Action => ({
    id, title: id, text: `prompt ${id}`, targets, category: undefined,
});

const COLLECTION_ACTION = action('summarize-collection', ['collection']);

describe('pureCollectionSelection', () => {
    it('returns the single selected collection', () => {
        const result = pureCollectionSelection(libraryView([collection(1, 'Methods')]));
        expect(result.map(c => c.collectionName)).toEqual(['Methods']);
    });

    it('returns every collection when the selection is all collections', () => {
        const result = pureCollectionSelection(
            libraryView([collection(1, 'Methods'), collection(2, 'Theory'), collection(3, 'Data')]),
        );
        expect(result.map(c => c.collectionId)).toEqual([1, 2, 3]);
    });

    it('returns nothing when the selection mixes collections with other rows', () => {
        // Two collections selected alongside a saved search: 3 rows, 2 collections
        const result = pureCollectionSelection(
            libraryView([collection(1, 'Methods'), collection(2, 'Theory')], 3),
        );
        expect(result).toEqual([]);
    });

    it('returns nothing when no collection is selected', () => {
        expect(pureCollectionSelection(libraryView([], 1, 'library'))).toEqual([]);
    });
});

describe('collection target visibility', () => {
    it('is visible for a single collection and for several', () => {
        expect(isActionVisible(COLLECTION_ACTION, ctx(libraryView([collection(1, 'Methods')])))).toBe(true);
        expect(isActionVisible(
            COLLECTION_ACTION,
            ctx(libraryView([collection(1, 'Methods'), collection(2, 'Theory')])),
        )).toBe(true);
    });

    it('is hidden for a mixed selection', () => {
        expect(isActionVisible(
            COLLECTION_ACTION,
            ctx(libraryView([collection(1, 'Methods')], 2)),
        )).toBe(false);
    });
});

describe('getActiveTarget — collection labels', () => {
    it('names the collection when exactly one is selected', () => {
        const active = getActiveTarget(ctx(libraryView([collection(1, 'Methods')])));
        expect(active).toMatchObject({ targetType: 'collection', label: 'Methods' });
    });

    it('counts them when several are selected', () => {
        const active = getActiveTarget(ctx(libraryView([
            collection(1, 'Methods'), collection(2, 'Theory'),
        ])));
        expect(active).toMatchObject({ targetType: 'collection', label: '2 collections selected' });
    });

    it('reports no collection target for a mixed selection', () => {
        const active = getActiveTarget(ctx(libraryView([collection(1, 'Methods')], 2)));
        expect(active).toBeNull();
    });
});

describe('computeActionGroups — collection group', () => {
    it('labels the group by count when several collections are selected', () => {
        const groups = computeActionGroups(
            [COLLECTION_ACTION],
            ctx(libraryView([collection(1, 'Methods'), collection(2, 'Theory'), collection(3, 'Data')])),
        );
        const group = groups.find(g => g.id === 'collection');
        expect(group).toMatchObject({ label: '3 collections selected', targetType: 'collection' });
    });

    it('omits the group entirely for a mixed selection', () => {
        const groups = computeActionGroups(
            [COLLECTION_ACTION],
            ctx(libraryView([collection(1, 'Methods')], 2)),
        );
        expect(groups.find(g => g.id === 'collection')).toBeUndefined();
    });
});

import { describe, it, expect, vi } from 'vitest';
import { Action, ActionTargetType } from '@beaver/agent-core/types/actions';
import type { LibraryViewInfo, SelectedCollectionInfo, SelectedViewInfo, ZoteroContext } from '../../../react/atoms/zoteroContext';

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
    collectionTargetSelection,
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

const view = (type: SelectedViewInfo['type'], name: string, libraryId = 1): SelectedViewInfo => ({
    type,
    name,
    libraryId,
});

/**
 * A collections-tree selection. `rowCount` defaults to the number of
 * collections and views (a pure collection-target selection); pass a larger
 * value to model a selection that also contains other rows, such as a library
 * root or the Trash.
 */
function libraryView(
    collections: SelectedCollectionInfo[],
    rowCount = collections.length,
    treeRowType: LibraryViewInfo['treeRowType'] = 'collection',
    views: SelectedViewInfo[] = [],
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
        selectedViews: views,
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

/** A selection of only views (saved searches, special views). */
function viewSelection(views: SelectedViewInfo[], rowCount = views.length): LibraryViewInfo {
    return libraryView([], rowCount, views[0]?.type ?? 'library', views);
}

describe('collectionTargetSelection', () => {
    it('returns the single selected collection', () => {
        const result = collectionTargetSelection(libraryView([collection(1, 'Methods')]));
        expect(result.collections.map(c => c.collectionName)).toEqual(['Methods']);
        expect(result.views).toEqual([]);
    });

    it('returns every collection when the selection is all collections', () => {
        const result = collectionTargetSelection(
            libraryView([collection(1, 'Methods'), collection(2, 'Theory'), collection(3, 'Data')]),
        );
        expect(result.collections.map(c => c.collectionId)).toEqual([1, 2, 3]);
    });

    it('returns a selected special view or saved search', () => {
        expect(collectionTargetSelection(viewSelection([view('unfiled', 'Unfiled Items')])).views)
            .toEqual([view('unfiled', 'Unfiled Items')]);
        expect(collectionTargetSelection(viewSelection([view('search', 'To read')])).views)
            .toEqual([view('search', 'To read')]);
    });

    it('returns collections and views selected together', () => {
        const result = collectionTargetSelection(
            libraryView([collection(1, 'Methods')], 2, 'collection', [view('search', 'To read')]),
        );
        expect(result.collections.map(c => c.collectionId)).toEqual([1]);
        expect(result.views.map(v => v.name)).toEqual(['To read']);
    });

    it('returns nothing when the selection mixes targets with other rows', () => {
        // Two collections selected alongside a library root: 3 rows, 2 collections
        const result = collectionTargetSelection(
            libraryView([collection(1, 'Methods'), collection(2, 'Theory')], 3),
        );
        expect(result).toEqual({ collections: [], views: [] });
        // Unfiled Items alongside the Trash
        expect(collectionTargetSelection(viewSelection([view('unfiled', 'Unfiled Items')], 2)))
            .toEqual({ collections: [], views: [] });
    });

    it('returns nothing when no collection or view is selected', () => {
        expect(collectionTargetSelection(libraryView([], 1, 'library'))).toEqual({ collections: [], views: [] });
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

    it('is visible for Unfiled Items and other collection-like views', () => {
        for (const type of ['unfiled', 'publications', 'retracted', 'search'] as const) {
            expect(isActionVisible(COLLECTION_ACTION, ctx(viewSelection([view(type, type)])))).toBe(true);
        }
    });

    it('is hidden for a library root', () => {
        expect(isActionVisible(COLLECTION_ACTION, ctx(libraryView([], 1, 'library')))).toBe(false);
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

    it('names a selected special view and uses its icon', () => {
        const active = getActiveTarget(ctx(viewSelection([view('unfiled', 'Unfiled Items')])));
        expect(active).toEqual({
            targetType: 'collection',
            label: 'Unfiled Items',
            iconInfo: { type: 'css-icon', name: 'unfiled' },
        });
    });

    it('names a selected saved search', () => {
        const active = getActiveTarget(ctx(viewSelection([view('search', 'To read')])));
        expect(active).toMatchObject({ targetType: 'collection', label: 'To read', iconInfo: { name: 'search' } });
    });

    it('counts collections and views selected together', () => {
        const active = getActiveTarget(ctx(
            libraryView([collection(1, 'Methods')], 2, 'collection', [view('unfiled', 'Unfiled Items')]),
        ));
        expect(active).toMatchObject({
            targetType: 'collection',
            label: '2 views selected',
            iconInfo: { name: 'collection' },
        });
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

    it('offers collection actions under a special view', () => {
        const groups = computeActionGroups(
            [COLLECTION_ACTION],
            ctx(viewSelection([view('unfiled', 'Unfiled Items')])),
        );
        expect(groups.find(g => g.id === 'collection')).toMatchObject({
            label: 'Unfiled Items',
            targetType: 'collection',
            actions: [COLLECTION_ACTION],
        });
    });

    it('offers view targets outside the library tab, like collections', () => {
        // Views are attached to the message when the action is picked, so a
        // reader tab in front of the library does not hide them.
        const readerCtx = (view: LibraryViewInfo): ActionContext => {
            const base = ctx(view);
            return { ...base, zotero: { ...base.zotero, type: 'idle', isLibraryTab: false } };
        };
        expect(computeActionGroups([COLLECTION_ACTION], readerCtx(viewSelection([view('unfiled', 'Unfiled Items')])))
            .find(g => g.id === 'collection')).toMatchObject({ label: 'Unfiled Items' });
        expect(isActionVisible(COLLECTION_ACTION, readerCtx(viewSelection([view('search', 'To read')])))).toBe(true);
    });

    it('omits the group for a library root', () => {
        const groups = computeActionGroups([COLLECTION_ACTION], ctx(libraryView([], 1, 'library')));
        expect(groups.find(g => g.id === 'collection')).toBeUndefined();
    });

    it('omits the group entirely for a mixed selection', () => {
        const groups = computeActionGroups(
            [COLLECTION_ACTION],
            ctx(libraryView([collection(1, 'Methods')], 2)),
        );
        expect(groups.find(g => g.id === 'collection')).toBeUndefined();
    });
});

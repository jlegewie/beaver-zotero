import { describe, it, expect, vi } from 'vitest';
import { Action, ActionCategory, ActionTargetType } from '../../../react/types/actions';

// actionVisibility has Zotero/supabase-coupled value imports that run side
// effects at module load (e.g. apiService throws on missing env). Stub the
// leaf modules so importing the pure splitter doesn't pull in that chain.
vi.mock('../../../src/utils/agentItemSupport', () => ({
    agentItemFilter: () => true,
    isAgentSupportedItem: () => true,
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({ safeIsInTrash: () => false }));
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: () => 'Mock Item' }));

import { splitCategoryActions } from '../../../react/utils/actionVisibility';

const A = (
    id: string,
    targets: ActionTargetType[],
    category: ActionCategory | undefined,
): Action => ({ id, title: id, text: `prompt ${id}`, targets, category });

// A representative context-visible action list (already visibility-filtered, as
// `actionsForContextAtom` would produce). splitCategoryActions only scopes by
// category and splits selected-target vs library-wide.
const VISIBLE: Action[] = [
    A('fit', ['items'], 'research'),
    A('similar', ['items', 'attachment'], 'research'),
    A('whatsnew', ['global'], 'research'),
    A('tag', ['items'], 'organize'),
    A('untagged', ['global'], 'organize'),
    A('summarize', ['items'], undefined),   // uncategorized ("Actions" bucket)
    A('cleanup', ['global'], undefined),    // uncategorized library-wide
];

describe('splitCategoryActions', () => {
    it('scopes by category and splits selected-target vs library-wide', () => {
        const { targetActions, globalActions } = splitCategoryActions(VISIBLE, 'research', 'items');
        expect(targetActions.map(a => a.id)).toEqual(['fit', 'similar']);
        expect(globalActions.map(a => a.id)).toEqual(['whatsnew']);
    });

    it('category = null selects the uncategorized ("Actions") bucket, including global', () => {
        const { targetActions, globalActions } = splitCategoryActions(VISIBLE, null, 'items');
        expect(targetActions.map(a => a.id)).toEqual(['summarize']);
        expect(globalActions.map(a => a.id)).toEqual(['cleanup']);
        // Categorized actions never leak into the uncategorized bucket.
        const ids = [...targetActions, ...globalActions].map(a => a.id);
        expect(ids).not.toContain('fit');
        expect(ids).not.toContain('whatsnew');
    });

    it('excludes actions from other categories', () => {
        const { targetActions, globalActions } = splitCategoryActions(VISIBLE, 'organize', 'items');
        const ids = [...targetActions, ...globalActions].map(a => a.id);
        expect(ids).toEqual(expect.arrayContaining(['tag', 'untagged']));
        expect(ids).not.toContain('fit');
        expect(ids).not.toContain('whatsnew');
    });

    it('returns only library-wide actions when nothing is selected (active = null)', () => {
        const { targetActions, globalActions } = splitCategoryActions(VISIBLE, 'research', null);
        expect(targetActions).toEqual([]);
        expect(globalActions.map(a => a.id)).toEqual(['whatsnew']);
    });

    it('puts only the active target type in the target section', () => {
        // Active target is a collection, but the visible research actions are
        // items/global → no target-section actions, only library-wide.
        const { targetActions, globalActions } = splitCategoryActions(VISIBLE, 'research', 'collection');
        expect(targetActions).toEqual([]);
        expect(globalActions.map(a => a.id)).toEqual(['whatsnew']);
    });

    it('matches multi-target actions on any accepted kind', () => {
        // 'similar' targets items|attachment — it appears for an attachment
        // context even though single-target items actions do not.
        const { targetActions, globalActions } = splitCategoryActions(VISIBLE, 'research', 'attachment');
        expect(targetActions.map(a => a.id)).toEqual(['similar']);
        expect(globalActions.map(a => a.id)).toEqual(['whatsnew']);
    });

    it('yields an empty result for a category with no visible actions', () => {
        const { targetActions, globalActions } = splitCategoryActions(VISIBLE, 'annotate', 'attachment');
        expect(targetActions).toEqual([]);
        expect(globalActions).toEqual([]);
    });
});

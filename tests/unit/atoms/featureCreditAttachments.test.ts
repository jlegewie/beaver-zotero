import { beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, createStore } from 'jotai';

vi.mock('../../../react/atoms/actions', () => ({ stageActionPillAtom: atom(null, () => true) }));
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: (item: { key: string }) => item.key }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef: () => 1 }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { featureTaskAttachmentSummaryAtom } from '../../../react/atoms/featureCredits';
import {
    createDefaultMessageFilters,
    currentMessageCollectionsAtom,
    currentMessageFiltersAtom,
} from '../../../react/atoms/messageComposition';

const regular = { isRegularItem: () => true };

describe('setup card step 1: attached collections', () => {
    beforeEach(() => {
        (Zotero as any).Collections = {
            get: vi.fn((id: number) => (id === 7 ? { name: 'Graph', libraryID: 1, key: 'GRAPHKEY' } : false)),
            getByLibraryAndKey: vi.fn(() => ({ getChildItems: () => [regular, regular, regular] })),
        };
    });

    it('counts a collection kept as a filter (dragged in or picked under Filter by Collections)', () => {
        const store = createStore();
        store.set(currentMessageFiltersAtom, { ...createDefaultMessageFilters(), collectionIds: [7] });
        expect(store.get(featureTaskAttachmentSummaryAtom).collections).toEqual([{ name: 'Graph', itemCount: 3 }]);
    });

    it('lists a collection that is both attached and a filter once', () => {
        const store = createStore();
        store.set(currentMessageCollectionsAtom, [{ name: 'Graph', zotero_key: 'GRAPHKEY', library_id: 1 } as any]);
        store.set(currentMessageFiltersAtom, { ...createDefaultMessageFilters(), collectionIds: [7] });
        expect(store.get(featureTaskAttachmentSummaryAtom).collections).toHaveLength(1);
    });

    it('ignores a filter for a collection that no longer exists', () => {
        const store = createStore();
        store.set(currentMessageFiltersAtom, { ...createDefaultMessageFilters(), collectionIds: [99] });
        expect(store.get(featureTaskAttachmentSummaryAtom).collections).toEqual([]);
    });
});

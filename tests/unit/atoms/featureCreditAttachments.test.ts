import { beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, createStore } from 'jotai';

vi.mock('../../../react/atoms/actions', () => ({ stageActionPillAtom: atom(null, () => true) }));
vi.mock('../../../react/utils/sourceUtils', () => ({ getDisplayNameFromItem: (item: { key: string }) => item.key }));
vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef: () => 1 }));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: (item: { kind?: string }) => item.kind ?? null,
    getContentKind: (item: { kind?: string }) => item.kind ?? 'other',
}));

import { featureTaskAttachmentSummaryAtom } from '../../../react/atoms/featureCredits';
import {
    createDefaultMessageFilters,
    currentMessageCollectionsAtom,
    currentMessageFiltersAtom,
    currentMessageItemsAtom,
    currentReaderAttachmentAtom,
} from '../../../react/atoms/messageComposition';
import { itemValidationResultsAtom, type ItemValidationState } from '../../../react/atoms/itemValidation';

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

type FakeItem = Record<string, unknown>;

function attachment(key: string, kind: string | null, parent?: FakeItem): FakeItem {
    return {
        key,
        libraryID: 1,
        kind,
        parentItem: parent,
        isAttachment: () => true,
        isAnnotation: () => false,
        isRegularItem: () => false,
    };
}

function paper(key: string, childIDs: number[] = []): FakeItem {
    return {
        key,
        libraryID: 1,
        isAttachment: () => false,
        isAnnotation: () => false,
        isRegularItem: () => true,
        getAttachments: () => childIDs,
    };
}

const checked = (state: 'readable' | 'unreadable', contentKind = 'pdf'): ItemValidationState =>
    ({ state, contentKind, isValidating: false } as ItemValidationState);

describe('setup card step 1: whether attached papers have a file to annotate', () => {
    let items: Map<number, FakeItem>;

    beforeEach(() => {
        items = new Map();
        (Zotero as any).Items = { get: vi.fn((id: number) => items.get(id) ?? false) };
    });

    const summarize = (setup: (store: ReturnType<typeof createStore>) => void) => {
        const store = createStore();
        setup(store);
        return store.get(featureTaskAttachmentSummaryAtom).papers;
    };

    it('rates a paper with no PDF, EPUB or snapshot as having none', () => {
        items.set(1, attachment('NOTEFILE', 'text'));
        expect(summarize((store) => store.set(currentMessageItemsAtom, [paper('P1', [1])] as any)))
            .toEqual([{ name: 'P1', document: 'none' }]);
        expect(summarize((store) => store.set(currentMessageItemsAtom, [paper('P2')] as any)))
            .toEqual([{ name: 'P2', document: 'none' }]);
    });

    it('waits for the readability check of a paper\'s PDF', () => {
        items.set(1, attachment('PDF1', 'pdf'));
        expect(summarize((store) => store.set(currentMessageItemsAtom, [paper('P1', [1])] as any))[0].document).toBe('checking');
        expect(summarize((store) => {
            store.set(currentMessageItemsAtom, [paper('P1', [1])] as any);
            store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('readable')]]));
        })[0].document).toBe('readable');
        expect(summarize((store) => {
            store.set(currentMessageItemsAtom, [paper('P1', [1])] as any);
            store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('unreadable')]]));
        })[0].document).toBe('unreadable');
    });

    it('counts the open reader file once under its paper', () => {
        const parent = paper('P1', [1]);
        const pdf = attachment('PDF1', 'pdf', parent);
        items.set(1, pdf);
        expect(summarize((store) => {
            store.set(currentMessageItemsAtom, [parent] as any);
            store.set(currentReaderAttachmentAtom, pdf as any);
            store.set(itemValidationResultsAtom, new Map([['1-PDF1', checked('readable')]]));
        })).toEqual([{ name: 'P1', document: 'readable' }]);
    });
});

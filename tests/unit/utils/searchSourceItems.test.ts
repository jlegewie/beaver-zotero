/**
 * The source-picker search: Zotero's quick search over the searchable
 * libraries, ranked best first, with the matches the ranking cannot score kept
 * rather than dropped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockItem } from '../../helpers/factories';

const mocks = vi.hoisted(() => ({
    loadFullItemData: vi.fn(async () => {}),
    idsByLibrary: new Map<number, number[]>(),
    itemsById: new Map<number, any>(),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({ loadFullItemData: mocks.loadFullItemData }));

import { searchSourceItems } from '../../../react/utils/search';

class FakeSearch {
    libraryID: number | null = null;
    conditions: [string, string, string][] = [];
    addCondition(condition: string, operator: string, value: string) {
        this.conditions.push([condition, operator, value]);
    }
    async search() {
        return mocks.idsByLibrary.get(this.libraryID as number) ?? [];
    }
}

let nextId = 1;
const item = (title: string, { libraryID = 1, publicationTitle = '', isRegularItem = true } = {}) => {
    const id = nextId++;
    const created = createMockItem({
        id,
        key: `KEY${String(id).padStart(5, '0')}`,
        libraryID,
        isRegularItem,
        fields: { title, date: '2020', publicationTitle },
    });
    mocks.itemsById.set(id, created);
    mocks.idsByLibrary.set(libraryID, [...(mocks.idsByLibrary.get(libraryID) ?? []), id]);
    return created;
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.idsByLibrary.clear();
    mocks.itemsById.clear();
    (globalThis as any).Zotero = {
        Search: FakeSearch,
        Items: {
            getAsync: vi.fn(async (ids: number[]) => ids.map((id) => mocks.itemsById.get(id))),
            loadDataTypes: vi.fn(async () => {}),
        },
        Utilities: { removeDiacritics: (text: string) => text },
        debug: vi.fn(),
        logError: vi.fn(),
    };
});

const titles = (result: { items: any[] } | null) => result?.items.map((i) => i.getField('title'));

describe('searchSourceItems', () => {
    it('keeps a match found only through its journal, after the ones the ranking can read', async () => {
        item('Policing and Schools', { publicationTitle: 'Sociological Review' });
        item('A Review of Policing');

        const result = await searchSourceItems('review', [1], 10);

        expect(titles(result)).toEqual(['A Review of Policing', 'Policing and Schools']);
        expect(result?.matchCount).toBe(2);
    });

    it('returns the best matches up to the limit, and how many matched in all', async () => {
        for (let i = 0; i < 12; i++) item(`Engine study ${i}`);

        const result = await searchSourceItems('engine', [1], 10);

        expect(result?.items).toHaveLength(10);
        expect(result?.matchCount).toBe(12);
        expect(mocks.loadFullItemData).toHaveBeenCalledWith(result?.items);
    });

    it('searches each of the given libraries and no other', async () => {
        item('Engine in my library', { libraryID: 1 });
        item('Engine in a group', { libraryID: 5 });
        item('Engine in an excluded group', { libraryID: 9 });

        const result = await searchSourceItems('engine', [1, 5], 10);

        expect(titles(result)?.sort()).toEqual(['Engine in a group', 'Engine in my library']);
    });

    it('searches nothing when no library is searchable', async () => {
        item('Engine study');
        const search = vi.spyOn(FakeSearch.prototype, 'search');

        expect(await searchSourceItems('engine', [], 10)).toEqual({ items: [], matchCount: 0 });
        expect(search).not.toHaveBeenCalled();
    });

    it('counts and ranks only the matches `include` keeps', async () => {
        item('Engine study');
        item('Engine notes', { isRegularItem: false });

        const result = await searchSourceItems('engine', [1], 10, { include: (i) => i.isRegularItem() });

        expect(titles(result)).toEqual(['Engine study']);
        expect(result?.matchCount).toBe(1);
    });

    it('stops before loading data once the search has been superseded', async () => {
        item('Engine study');

        const result = await searchSourceItems('engine', [1], 10, { isCurrent: () => false });

        expect(result).toBeNull();
        expect((globalThis as any).Zotero.Items.loadDataTypes).not.toHaveBeenCalled();
        expect(mocks.loadFullItemData).not.toHaveBeenCalled();
    });
});

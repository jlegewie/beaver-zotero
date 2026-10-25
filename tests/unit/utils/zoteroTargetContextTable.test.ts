/**
 * On a Beaver table tab, write targets follow the table — its library, no
 * parent — not the library pane's hidden selection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/runtime/windowRuntime', () => ({ getContextWindow: vi.fn(() => null) }));

import {
    getCurrentLibrary,
    getLibraryViewCollection,
    getZoteroTargetContext,
    getZoteroTargetContextSync,
    isLibraryTabSelected,
} from '../../../react/utils/zoteroTargetContext';

const table = { id: 7, key: 'TABLE777', libraryID: 2, parentKey: null };
const unrelated = { id: 9, key: 'PAPER999', libraryID: 1, isAnnotation: () => false, isRegularItem: () => true };

function tableTabWindow(): any {
    return {
        closed: false,
        Zotero_Tabs: {
            selectedType: 'beaver-table',
            selectedID: 'tab-7',
            _tabs: [{ id: 'tab-7', type: 'beaver-table', data: { itemID: 7 } }],
        },
        ZoteroPane: { getSelectedItems: () => [unrelated], collectionsView: null },
    };
}

let previous: any;
beforeEach(() => {
    previous = (globalThis as any).Zotero;
    (globalThis as any).Zotero = {
        ...previous,
        Items: { get: vi.fn((id: number) => (id === 7 ? table : null)), getAsync: vi.fn(async (id: number) => (id === 7 ? table : null)) },
        Libraries: { get: vi.fn((id: number) => ({ libraryID: id })) },
        Reader: { getByTabID: vi.fn(() => null) },
    };
});
afterEach(() => {
    (globalThis as any).Zotero = previous;
});

describe('Zotero target context on a Beaver tab', () => {
    it('targets the table library with no parent, ignoring the library selection', async () => {
        const expected = { targetLibraryId: 2, parentReference: null, collectionToAddTo: null };
        expect(getZoteroTargetContextSync(tableTabWindow())).toEqual(expected);
        expect(await getZoteroTargetContext(tableTabWindow())).toEqual(expected);
        expect(getCurrentLibrary(tableTabWindow())).toEqual({ libraryID: 2 });
    });
});

describe('the library tab\'s collection', () => {
    const collection = { id: 41, key: 'COLL0041', libraryID: 1 };
    function withCollection(win: any, selectedType: string): any {
        win.Zotero_Tabs.selectedType = selectedType;
        win.ZoteroPane.getSelectedCollection = () => collection;
        win.ZoteroPane.collectionsView = { selectedTreeRow: { isCollection: () => true, ref: collection } };
        return win;
    }

    it('is the selected collection while the library tab is selected', () => {
        const win = withCollection(tableTabWindow(), 'library');
        expect(isLibraryTabSelected(win)).toBe(true);
        expect(getLibraryViewCollection(win)).toBe(collection);
    });

    it.each(['beaver-table', 'reader', 'reader-loading'])('is hidden behind a %s tab', (type) => {
        const win = withCollection(tableTabWindow(), type);
        expect(isLibraryTabSelected(win)).toBe(false);
        expect(getLibraryViewCollection(win)).toBeNull();
    });
});

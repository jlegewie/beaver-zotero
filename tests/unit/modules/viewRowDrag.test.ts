import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { attachViewRowDrag, detachViewRowDrag } from '../../../src/modules/viewRowDrag';
import { VIEW_ROW_DRAG_TYPE } from '../../../src/utils/zoteroSelection';

type Handler = (event: any) => void;

function fakeWindow(rows: Record<number, any>) {
    const listeners: Handler[] = [];
    const tree = {
        addEventListener: vi.fn((_type: string, handler: Handler) => listeners.push(handler)),
        removeEventListener: vi.fn((_type: string, handler: Handler) => {
            listeners.splice(listeners.indexOf(handler), 1);
        }),
    };
    const win: any = {
        document: { getElementById: vi.fn((id: string) => (id === 'zotero-collections-tree' ? tree : null)) },
        ZoteroPane: { collectionsView: { getRow: vi.fn((index: number) => rows[index] ?? null) } },
    };
    /** Fire a dragstart from the row at `index` and return what was put on the drag. */
    const dragRow = (index: number) => {
        const data: Record<string, string> = {};
        const event = {
            target: { closest: () => ({ id: `collection-tree-row-${index}` }) },
            dataTransfer: { setData: (type: string, value: string) => { data[type] = value; } },
        };
        listeners.forEach(listener => listener(event));
        return data;
    };
    return { win, tree, listeners, dragRow };
}

describe('viewRowDrag', () => {
    beforeEach(() => vi.clearAllMocks());

    it('adds Beaver drag data to a built-in view row', () => {
        const { win, dragRow } = fakeWindow({
            3: { type: 'unfiled', ref: { libraryID: 1 }, getName: () => 'Unfiled Items' },
        });
        attachViewRowDrag(win);

        const data = dragRow(3);

        expect(JSON.parse(data[VIEW_ROW_DRAG_TYPE])).toEqual({
            libraryID: 1, type: 'unfiled', name: 'Unfiled Items',
        });
    });

    it('leaves collections, saved searches and other views to Zotero', () => {
        const { win, dragRow } = fakeWindow({
            1: { type: 'collection', ref: { libraryID: 1 }, getName: () => 'Methods' },
            2: { type: 'search', ref: { libraryID: 1 }, getName: () => 'Recent' },
            4: { type: 'trash', ref: { libraryID: 1 }, getName: () => 'Trash' },
        });
        attachViewRowDrag(win);

        expect(dragRow(1)).toEqual({});
        expect(dragRow(2)).toEqual({});
        expect(dragRow(4)).toEqual({});
    });

    it('installs one listener per window and removes it on detach', () => {
        const { win, tree, listeners } = fakeWindow({});

        attachViewRowDrag(win);
        attachViewRowDrag(win);
        expect(listeners).toHaveLength(1);

        detachViewRowDrag(win);
        expect(listeners).toHaveLength(0);
        expect(tree.removeEventListener).toHaveBeenCalledWith('dragstart', expect.any(Function), true);
    });

    it('does nothing in a window without a collections tree', () => {
        const win: any = { document: { getElementById: () => null } };

        expect(() => attachViewRowDrag(win)).not.toThrow();
        expect(() => detachViewRowDrag(win)).not.toThrow();
    });
});

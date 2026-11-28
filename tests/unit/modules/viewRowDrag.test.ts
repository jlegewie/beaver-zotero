// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

import { attachViewRowDrag, detachViewRowDrag } from '../../../src/modules/viewRowDrag';
import { VIEW_ROW_DRAG_TYPE } from '../../../src/utils/zoteroSelection';

const collectionsView = (rows: Record<number, any>) => ({ getRow: vi.fn((index: number) => rows[index] ?? null) });

/**
 * Build a collections tree in the document. `id` is the tree's element id: the
 * first library view keeps `zotero-collections-tree`; Zotero 11 suffixes the
 * ids of a window's other library views and gives every tree the class.
 */
function addTree(options: { id: string; className?: string; libraryView?: any }) {
    const tree = document.createElement('div');
    tree.id = options.id;
    if (options.className) tree.className = options.className;
    let container: HTMLElement = tree;
    if (options.libraryView) {
        container = document.createElement('library-view');
        Object.assign(container, options.libraryView);
        container.appendChild(tree);
    }
    document.body.appendChild(container);
    return tree;
}

function addRow(parent: HTMLElement, id: string) {
    const row = document.createElement('div');
    row.className = 'row';
    row.id = id;
    const label = document.createElement('span');
    row.appendChild(label);
    parent.appendChild(row);
    return label;
}

/** Dispatch a dragstart from `target` and return what was put on the drag. */
function dragFrom(target: Element) {
    const data: Record<string, string> = {};
    const event = new Event('dragstart', { bubbles: true });
    Object.defineProperty(event, 'dataTransfer', {
        value: { setData: (type: string, value: string) => { data[type] = value; } },
    });
    target.dispatchEvent(event);
    return data;
}

function fakeWindow(rows: Record<number, any>) {
    return { document, ZoteroPane: { collectionsView: collectionsView(rows) } } as any;
}

describe('viewRowDrag', () => {
    let win: any;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        if (win) detachViewRowDrag(win);
        win = null;
    });

    it('adds Beaver drag data to a built-in view row', () => {
        win = fakeWindow({ 3: { type: 'unfiled', ref: { libraryID: 1 }, getName: () => 'Unfiled Items' } });
        const tree = addTree({ id: 'zotero-collections-tree' });
        const label = addRow(tree, 'zotero-collections-tree-row-3');
        attachViewRowDrag(win);

        const data = dragFrom(label);

        expect(JSON.parse(data[VIEW_ROW_DRAG_TYPE])).toEqual({
            libraryID: 1, type: 'unfiled', name: 'Unfiled Items',
        });
    });

    it("reads the row from a second library tab's own view", () => {
        // The window's active view shows another library; the drag starts in a
        // second library tab whose tree has a suffixed id and the base-id class.
        win = fakeWindow({ 3: { type: 'unfiled', ref: { libraryID: 1 }, getName: () => 'Unfiled Items' } });
        const secondView = {
            collectionsView: collectionsView({
                3: { type: 'publications', ref: { libraryID: 7 }, getName: () => 'My Publications' },
            }),
        };
        const tree = addTree({
            id: 'zotero-collections-tree-tab-k3Xq9TzA',
            className: 'zotero-collections-tree',
            libraryView: secondView,
        });
        const label = addRow(tree, 'zotero-collections-tree-tab-k3Xq9TzA-row-3');
        attachViewRowDrag(win);

        const data = dragFrom(label);

        expect(JSON.parse(data[VIEW_ROW_DRAG_TYPE])).toEqual({
            libraryID: 7, type: 'publications', name: 'My Publications',
        });
        expect(win.ZoteroPane.collectionsView.getRow).not.toHaveBeenCalled();
    });

    it('ignores drags that do not start in a collections tree', () => {
        win = fakeWindow({ 3: { type: 'unfiled', ref: { libraryID: 1 }, getName: () => 'Unfiled Items' } });
        const itemsTree = addTree({ id: 'zotero-items-tree', className: 'zotero-items-tree' });
        const label = addRow(itemsTree, 'zotero-items-tree-row-3');
        attachViewRowDrag(win);

        expect(dragFrom(label)).toEqual({});
    });

    it('leaves collections, saved searches and other views to Zotero', () => {
        win = fakeWindow({
            1: { type: 'collection', ref: { libraryID: 1 }, getName: () => 'Methods' },
            2: { type: 'search', ref: { libraryID: 1 }, getName: () => 'Recent' },
            4: { type: 'trash', ref: { libraryID: 1 }, getName: () => 'Trash' },
        });
        const tree = addTree({ id: 'zotero-collections-tree' });
        attachViewRowDrag(win);

        for (const index of [1, 2, 4]) {
            expect(dragFrom(addRow(tree, `zotero-collections-tree-row-${index}`))).toEqual({});
        }
    });

    it('adds the data once when attached twice, and not after detach', () => {
        const unfiled = { type: 'unfiled', ref: { libraryID: 1 }, getName: () => 'Unfiled Items' };
        win = fakeWindow({ 3: unfiled });
        const tree = addTree({ id: 'zotero-collections-tree' });
        const label = addRow(tree, 'zotero-collections-tree-row-3');

        attachViewRowDrag(win);
        attachViewRowDrag(win);
        dragFrom(label);
        expect(win.ZoteroPane.collectionsView.getRow).toHaveBeenCalledTimes(1);

        detachViewRowDrag(win);
        expect(dragFrom(label)).toEqual({});
    });

    it('does nothing in a window without a document', () => {
        const bare: any = {};

        expect(() => attachViewRowDrag(bare)).not.toThrow();
        expect(() => detachViewRowDrag(bare)).not.toThrow();
    });
});

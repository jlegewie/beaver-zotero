// @vitest-environment jsdom

/**
 * Item menus whose entries resolve asynchronously must not open once the user
 * has moved on: no menu is mounted while the lookup runs, so dismissal has to
 * be tracked separately until the entries arrive.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHost } from '@beaver/agent-ui/host';
import type { MenuItem } from '@beaver/agent-ui/primitives/ContextMenu';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { useItemContextMenu } from '@beaver/agent-ui/chat/useItemContextMenu';
import { beginMenuRequest } from '@beaver/agent-ui/chat/pendingMenuRequest';
import { useRemoveContextMenu } from '../../../react/hooks/useRemoveContextMenu';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** A host lookup the test settles by hand, per item key. */
const pending = new Map<string, (entries: MenuItem[]) => void>();
const itemMenuItems = vi.fn((ref: ZoteroItemReference) =>
    new Promise<MenuItem[]>((resolve) => pending.set(ref.zotero_key, resolve)));
const entry = (label: string): MenuItem => ({ label, onClick: () => {} });
const revealCollection = vi.fn();

let root: Root | null = null;
let container: HTMLDivElement;

/** Two rows, each with its own hook, as the batch rows are built. */
const Row: React.FC<{ itemKey: string }> = ({ itemKey }) => {
    const { openItemMenu, itemMenu } = useItemContextMenu();
    return React.createElement(
        React.Fragment,
        null,
        React.createElement('div', {
            'data-row': itemKey,
            onContextMenu: (event: React.MouseEvent) => openItemMenu({ library_id: 1, zotero_key: itemKey }, event),
        }, itemKey),
        itemMenu,
    );
};

/** A collection row beside an item row, sharing one hook as a list would. */
const MixedList: React.FC = () => {
    const { openItemMenu, openCollectionMenu, itemMenu } = useItemContextMenu();
    return React.createElement(
        React.Fragment,
        null,
        React.createElement('div', {
            'data-row': 'A',
            onContextMenu: (event: React.MouseEvent) => openItemMenu({ library_id: 1, zotero_key: 'A' }, event),
        }, 'item'),
        React.createElement('div', {
            'data-row': 'COLL',
            onContextMenu: (event: React.MouseEvent) => openCollectionMenu({ library_id: 1, zotero_key: 'COLL' }, event),
        }, 'collection'),
        itemMenu,
    );
};

const Chip: React.FC = () => {
    const { contextMenuHandlers, removeMenu } = useRemoveContextMenu({
        onRemove: () => {},
        canEdit: false,
        itemRef: { library_id: 1, zotero_key: 'CHIP' },
    });
    return React.createElement(
        React.Fragment,
        null,
        React.createElement('div', { 'data-row': 'CHIP', ...contextMenuHandlers }, 'chip'),
        removeMenu,
    );
};

function mount(element: React.ReactElement) {
    act(() => { root!.render(element); });
}

function rightClick(key: string) {
    const row = container.querySelector(`[data-row="${key}"]`)!;
    act(() => {
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
}

async function settle(key: string, labels: string[]) {
    await act(async () => {
        pending.get(key)!(labels.map(entry));
        await Promise.resolve();
        await Promise.resolve();
    });
}

function menuLabels(): string[][] {
    return Array.from(container.querySelectorAll('[role="menu"]')).map((menu) =>
        Array.from(menu.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent ?? ''));
}

describe('asynchronous item menus', () => {
    beforeEach(() => {
        pending.clear();
        itemMenuItems.mockClear();
        revealCollection.mockClear();
        setHost({ navigation: { itemMenuItems, revealCollection } as any });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => { root?.unmount(); });
        root = null;
        container.remove();
        setHost({});
    });

    it('opens once the entries arrive', async () => {
        mount(React.createElement(Row, { itemKey: 'A' }));
        rightClick('A');
        expect(menuLabels()).toEqual([]);

        await settle('A', ['Show in Library']);

        expect(menuLabels()).toEqual([['Show in Library']]);
    });

    it('stays closed when the user clicks elsewhere before the entries arrive', async () => {
        mount(React.createElement(Row, { itemKey: 'A' }));
        rightClick('A');
        act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });

        await settle('A', ['Show in Library']);

        expect(menuLabels()).toEqual([]);
    });

    it('stays closed when the user presses Escape before the entries arrive', async () => {
        mount(React.createElement(Row, { itemKey: 'A' }));
        rightClick('A');
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

        await settle('A', ['Show in Library']);

        expect(menuLabels()).toEqual([]);
    });

    it('opens only the latest of two rows whose lookups finish out of order', async () => {
        mount(React.createElement(React.Fragment, null,
            React.createElement(Row, { itemKey: 'A' }),
            React.createElement(Row, { itemKey: 'B' })));
        rightClick('A');
        rightClick('B');

        await settle('B', ['B entry']);
        await settle('A', ['A entry']);

        expect(menuLabels()).toEqual([['B entry']]);
    });

    it('stays closed when the row unmounts before the entries arrive', async () => {
        mount(React.createElement(Row, { itemKey: 'A' }));
        rightClick('A');
        mount(React.createElement('div'));

        await settle('A', ['Show in Library']);

        expect(menuLabels()).toEqual([]);
    });

    it('opens a collection menu at once, revealing the collection', () => {
        mount(React.createElement(MixedList));
        rightClick('COLL');

        expect(menuLabels()).toEqual([['Show in Library']]);
        const item = container.querySelector('[role="menuitem"]') as HTMLElement;
        act(() => { item.click(); });
        expect(revealCollection).toHaveBeenCalledWith({ library_id: 1, zotero_key: 'COLL' });
    });

    it('keeps a collection menu when an earlier item lookup finishes after it', async () => {
        mount(React.createElement(MixedList));
        rightClick('A');
        rightClick('COLL');

        await settle('A', ['Show in Library', 'Open PDF in New Tab']);

        expect(menuLabels()).toEqual([['Show in Library']]);
    });

    it('keeps a chip menu closed when the user clicks elsewhere before its entries arrive', async () => {
        mount(React.createElement(Chip));
        rightClick('CHIP');
        act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });

        await settle('CHIP', ['Show in Library']);

        expect(menuLabels()).toEqual([]);
    });

    it('opens a chip menu with its item entries when left alone', async () => {
        mount(React.createElement(Chip));
        rightClick('CHIP');

        await settle('CHIP', ['Show in Library']);

        expect(menuLabels()).toEqual([['Show in Library']]);
    });
});

describe('beginMenuRequest', () => {
    it('ignores modifier keys pressed on the way to a click', () => {
        const request = beginMenuRequest(document);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
        expect(request.isCurrent()).toBe(true);
        request.settle();
    });

    it('is invalidated by scrolling and by the window losing focus', () => {
        const scrolled = beginMenuRequest(document);
        document.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
        expect(scrolled.isCurrent()).toBe(false);

        const blurred = beginMenuRequest(document);
        window.dispatchEvent(new FocusEvent('blur'));
        expect(blurred.isCurrent()).toBe(false);
    });

    it('stops listening once settled', () => {
        const request = beginMenuRequest(document);
        request.settle();
        document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(request.isCurrent()).toBe(true);
    });
});

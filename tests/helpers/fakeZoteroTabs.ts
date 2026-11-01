/**
 * A stand-in for a main window's `Zotero_Tabs` and the window around it, for
 * unit tests of Beaver tabs. Behaves like Zotero where Beaver depends on it:
 * `add` splices at `index`, `close` runs `onClose` synchronously and removes
 * the container a tick later, `getState` reports `selected`, and the built-in
 * `restoreState` hooks reject an index below 1.
 */

import { vi } from 'vitest';

export interface FakeTab { id: string; type: string; title?: string; data?: any; onClose?: () => void }

// Zotero's tab ids are random, so unique across windows.
let nextTabID = 0;
let nextWindowID = 0;

export class FakeTabs {
    tabs: FakeTab[] = [{ id: 'zotero-pane', type: 'library', data: {} }];
    selectedID = 'zotero-pane';
    tabHooks: Record<string, Record<string, any>> = {
        // Zotero's own: an unloaded tab at `index`, which must be >= 1.
        restoreState: {
            reader: vi.fn(async (tab: FakeTab, index: number) => {
                if (!(index >= 1)) throw new Error(`'index' should be an integer > 0 (was ${index})`);
                this.add({ type: 'reader-unloaded', title: tab.title, data: tab.data });
                return { itemID: tab.data.itemID };
            }),
            note: vi.fn(async (tab: FakeTab, index: number) => {
                if (!(index >= 1)) throw new Error(`'index' should be an integer > 0 (was ${index})`);
                this.add({ type: 'note-unloaded', title: tab.title, data: tab.data });
                return { itemID: tab.data.itemID };
            }),
        },
        getTitle: {},
        undoClose: {},
    };
    deck: HTMLElement;
    rename = vi.fn(async (id: string, title?: string) => {
        const tab = this.tabs.find((t) => t.id === id);
        if (!tab) return;
        tab.title = title || (await this.tabHooks.getTitle?.beaver?.(tab));
    });
    restoreState = vi.fn(async (tabs: FakeTab[]) => {
        for (const tab of tabs) this.add({ type: `${tab.type}-unloaded`, title: tab.title, data: tab.data });
    });

    constructor(private doc: Document) {
        this.deck = doc.createElement('div');
        doc.body.appendChild(this.deck);
    }

    get selectedType() {
        return this.tabs.find((t) => t.id === this.selectedID)?.type;
    }

    add({ type, title, data, index, select, onClose }: any) {
        if (index !== undefined && (!Number.isInteger(index) || index < 1)) throw new Error(`'index' should be an integer > 0 (was ${index})`);
        const id = `tab-${++nextTabID}`;
        const container = this.doc.createElement('div');
        container.id = id;
        this.deck.appendChild(container);
        this.tabs.splice(index || this.tabs.length, 0, { id, type, title, data, onClose });
        if (select) this.selectedID = id;
        return { id, container };
    }

    select(id: string) {
        this.selectedID = id;
    }

    close(ids: string | string[]) {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
            const index = this.tabs.findIndex((t) => t.id === id);
            if (index < 0) continue;
            const [tab] = this.tabs.splice(index, 1);
            if (this.selectedID === id) this.selectedID = 'zotero-pane';
            tab.onClose?.();
            // Zotero removes the container on the next tick.
            setTimeout(() => this.doc.getElementById(id)?.remove());
        }
    }

    // Zotero closes the window's tabs as the window unloads (`ZoteroPane.destroy`).
    closeAll() {
        this.close(this.tabs.slice(1).map((t) => t.id));
    }

    getState() {
        return this.tabs.map((t) => ({
            type: t.type.replace(/-unloaded$/, ''),
            title: t.title,
            data: t.data,
            ...(t.id === this.selectedID ? { selected: true } : {}),
        }));
    }
}

export function fakeWindow() {
    const doc = document.implementation.createHTMLDocument('main');
    const listeners: Record<string, Array<() => void>> = {};
    const handle = { setWarning: vi.fn(), reload: vi.fn() };
    const win: any = {
        closed: false,
        document: doc,
        location: { href: 'chrome://zotero/content/zoteroPane.xhtml' },
        docShell: { outerWindowID: ++nextWindowID },
        __beaverRuntime: { status: 'ready' },
        addEventListener: vi.fn((name: string, fn: () => void) => { (listeners[name] ??= []).push(fn); }),
        dispatch: (name: string) => listeners[name]?.forEach((fn) => fn()),
        BeaverReact: {
            renderTableTab: vi.fn((container: HTMLElement) => {
                container.appendChild(doc.createElement('section'));
                return handle;
            }),
            unmountFromElement: vi.fn((container: HTMLElement) => {
                container.replaceChildren();
                return true;
            }),
        },
        handle,
    };
    win.Zotero_Tabs = new FakeTabs(doc);
    return win;
}


// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { activeItemPane, isLibraryTabSelected, isLibraryTabType, placeLibraryMount } from '../../../src/ui/libraryPane';

function windowWith(itemPane: HTMLElement | null, tabs: any = {}) {
    return { closed: false, document, ZoteroPane: { itemPane }, Zotero_Tabs: tabs } as unknown as Window;
}

function pane(id: string): HTMLElement {
    const el = document.createElement('div');
    el.id = id;
    const content = document.createElement('div');
    content.className = 'content';
    el.appendChild(content);
    document.body.appendChild(el);
    return el;
}

describe('library tab types', () => {
    it('treats Zotero 11 loading states as library tabs', () => {
        expect(isLibraryTabType('library')).toBe(true);
        expect(isLibraryTabType('library-loading')).toBe(true);
        expect(isLibraryTabType('library-unloaded')).toBe(true);
        expect(isLibraryTabType('reader')).toBe(false);
        expect(isLibraryTabType('reader-loading')).toBe(false);
        expect(isLibraryTabType('beaver-table')).toBe(false);
        expect(isLibraryTabType(undefined)).toBe(false);
    });

    it("prefers Zotero's own selected-library flag", () => {
        expect(isLibraryTabSelected(windowWith(null, { selectedIsLibrary: true, selectedType: 'odd' }))).toBe(true);
        expect(isLibraryTabSelected(windowWith(null, { selectedType: 'library-loading' }))).toBe(true);
        expect(isLibraryTabSelected(windowWith(null, { selectedType: 'reader' }))).toBe(false);
    });
});

describe('placeLibraryMount', () => {
    it('reports no pane while the window has no library view', () => {
        document.body.innerHTML = '';
        const mount = document.createElement('div');
        expect(activeItemPane(windowWith(null))).toBeNull();
        expect(placeLibraryMount(windowWith(null), mount)).toBeNull();
        expect(mount.parentElement).toBeNull();
    });

    it("moves into the active view's pane and uncovers what it hid in the previous one", () => {
        document.body.innerHTML = '';
        const first = pane('zotero-item-pane');
        const second = pane('zotero-item-pane-tab-b');
        const mount = document.createElement('div');
        first.appendChild(mount);
        (first.querySelector('.content') as HTMLElement).style.display = 'none';

        expect(placeLibraryMount(windowWith(second), mount)).toBe(second);
        expect(mount.parentElement).toBe(second);
        expect((first.querySelector('.content') as HTMLElement).style.display).toBe('');
    });

    it('reattaches a mount left behind by a closed view', () => {
        document.body.innerHTML = '';
        const closed = pane('zotero-item-pane');
        const mount = document.createElement('div');
        closed.appendChild(mount);
        closed.remove();
        const next = pane('zotero-item-pane-tab-c');

        expect(placeLibraryMount(windowWith(next), mount)).toBe(next);
        expect(mount.isConnected).toBe(true);
    });
});

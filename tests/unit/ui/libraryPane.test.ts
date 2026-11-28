// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { activeItemPane, isLibraryTabSelected, isLibraryTabType, selectLibraryTab } from '../../../src/ui/libraryPane';

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

describe('activeItemPane', () => {
    it('reports no pane while the window has no library view', () => {
        document.body.innerHTML = '';
        expect(activeItemPane(windowWith(null))).toBeNull();
    });

    it("returns the active view's pane", () => {
        document.body.innerHTML = '';
        pane('zotero-item-pane');
        const second = pane('zotero-item-pane-tab-b');
        expect(activeItemPane(windowWith(second))).toBe(second);
    });
});

describe('selectLibraryTab', () => {
    it("uses Zotero 11's selectLibraryTab when present", () => {
        const tabs = { select: vi.fn(), selectLibraryTab: vi.fn() };
        selectLibraryTab(windowWith(null, tabs));
        expect(tabs.selectLibraryTab).toHaveBeenCalledTimes(1);
        expect(tabs.select).not.toHaveBeenCalled();
    });

    it('selects the zotero-pane tab on Zotero 7–10', () => {
        const tabs = { select: vi.fn() };
        selectLibraryTab(windowWith(null, tabs));
        expect(tabs.select).toHaveBeenCalledWith('zotero-pane');
    });
});

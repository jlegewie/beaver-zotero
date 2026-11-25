// @vitest-environment jsdom
/**
 * The development check on Zotero's menus: what counts as a displaced entry,
 * the per-window check that logs it when a menu opens, and the probe the
 * live tests drive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    attachMenuIntegrityCheck,
    findMenuIntegrityProblems,
    probeMenuIntegrity,
} from '../../../src/modules/zoteroMenuIntegrity';

const Z = (globalThis as any).Zotero;

/** The end of Zotero's collection menu, ids as Zotero assigns them, then a plugin entry. */
function collectionMenu(): { popup: HTMLElement; plugin: HTMLElement } {
    const popup = document.createElement('menupopup');
    popup.id = 'zotero-collectionmenu';
    for (const [id, className] of [
        ['loadReport', 'zotero-menuitem-create-report'],
        ['emptyTrash', 'zotero-menuitem-delete-from-lib'],
        ['removeLibrary', 'zotero-menuitem-removeLibrary'],
    ]) {
        const entry = document.createElement('menuitem');
        entry.id = id;
        entry.className = className;
        popup.append(entry);
    }
    const plugin = document.createElement('menuitem');
    plugin.className = 'zotero-custom-menu-item zotero-custom-menu-AbC1-1';
    plugin.setAttribute('label', 'Create Beaver Table');
    plugin.setAttribute('data-l10n-id', 'beaver-create-table');
    popup.append(plugin);
    document.body.append(popup);
    return { popup, plugin };
}

/** Zotero's positional id assignment over the first `count` children, as it runs on each opening. */
function numberByPosition(popup: HTMLElement, ids: string[]): void {
    ids.forEach((id, i) => { (popup.children[i] as HTMLElement).id = id; });
}

let logError: ReturnType<typeof vi.fn>;
let detach: (() => void) | undefined;

beforeEach(() => {
    logError = vi.fn();
    Z.logError = logError;
    document.body.innerHTML = '';
});

afterEach(() => {
    detach?.();
    detach = undefined;
    delete Z.logError;
});

describe('finding displaced menu entries', () => {
    it('finds nothing in a menu whose entries each keep their own id', () => {
        const { popup } = collectionMenu();
        expect(findMenuIntegrityProblems(popup)).toEqual([]);
    });

    it('finds the duplicate id and the plugin entry that took over an id when a plugin entry sits among Zotero\'s', () => {
        const { popup, plugin } = collectionMenu();
        // The plugin entry moved right after Generate Report, then the menu opened again.
        popup.querySelector('.zotero-menuitem-create-report')!.after(plugin);
        numberByPosition(popup, ['loadReport', 'emptyTrash', 'removeLibrary']);

        const problems = findMenuIntegrityProblems(popup);
        expect(problems).toEqual([
            { kind: 'duplicate_id', id: 'removeLibrary', elements: [
                'menuitem.zotero-menuitem-delete-from-lib',
                'menuitem.zotero-menuitem-removeLibrary',
            ] },
            { kind: 'plugin_entry_with_id', id: 'emptyTrash', elements: [
                'menuitem.zotero-custom-menu-item.zotero-custom-menu-AbC1-1 (Create Beaver Table)',
            ] },
        ]);
    });

    it('looks inside submenus too', () => {
        const { popup } = collectionMenu();
        const submenu = document.createElement('menupopup');
        const nested = document.createElement('menuitem');
        nested.className = 'zotero-custom-menu-item';
        nested.id = 'sync';
        submenu.append(nested);
        popup.append(submenu);
        expect(findMenuIntegrityProblems(popup)).toEqual([
            { kind: 'plugin_entry_with_id', id: 'sync', elements: ['menuitem.zotero-custom-menu-item'] },
        ]);
    });
});

describe('the check when a menu opens', () => {
    const open = (popup: HTMLElement) => popup.dispatchEvent(new Event('popupshown', { bubbles: true }));

    it('logs each problem to the error console once, and nothing for a sound menu', () => {
        const { popup, plugin } = collectionMenu();
        detach = attachMenuIntegrityCheck(window);

        open(popup);
        expect(logError).not.toHaveBeenCalled();

        popup.querySelector('.zotero-menuitem-create-report')!.after(plugin);
        numberByPosition(popup, ['loadReport', 'emptyTrash', 'removeLibrary']);
        open(popup);
        open(popup);
        expect(logError).toHaveBeenCalledTimes(2);
        const messages = logError.mock.calls.map(([error]) => String(error.message));
        expect(messages[0]).toContain('in menu #zotero-collectionmenu, 2 elements carry the id "removeLibrary"');
        expect(messages[1]).toContain('a plugin entry carries Zotero\'s id "emptyTrash"');
    });

    it('stops checking once detached', () => {
        const { popup, plugin } = collectionMenu();
        plugin.id = 'emptyTrash';
        attachMenuIntegrityCheck(window)();
        open(popup);
        expect(logError).not.toHaveBeenCalled();
    });

    it('never lets a failing check reach Zotero\'s menu', () => {
        const { popup, plugin } = collectionMenu();
        plugin.id = 'emptyTrash';
        logError.mockImplementation(() => { throw new Error('console gone'); });
        detach = attachMenuIntegrityCheck(window);
        expect(() => open(popup)).not.toThrow();
    });
});

describe('the probe the live tests drive', () => {
    /** A popup that opens when the pane's right-click handler runs, and numbers its entries by position first. */
    function paneWith(popup: HTMLElement, opens = true) {
        const state = { value: 'closed' };
        Object.defineProperty(popup, 'state', { get: () => state.value, configurable: true });
        (popup as any).hidePopup = () => {
            state.value = 'closed';
            popup.dispatchEvent(new Event('popuphidden'));
        };
        const handler = vi.fn(async () => {
            numberByPosition(popup, ['loadReport', 'emptyTrash', 'removeLibrary']);
            if (!opens) return;
            state.value = 'open';
            popup.dispatchEvent(new Event('popupshown'));
        });
        (window as any).ZoteroPane = { onCollectionsContextMenuOpen: handler };
        return handler;
    }

    afterEach(() => {
        delete (window as any).ZoteroPane;
    });

    it('opens the menu through Zotero\'s handler each time and reports what it finds while open', async () => {
        const { popup, plugin } = collectionMenu();
        const handler = paneWith(popup);
        const sound = await probeMenuIntegrity(window, ['collection'], 2);
        expect(handler).toHaveBeenCalledTimes(2);
        expect(sound).toEqual([
            { menu: 'collection', opening: 1, shown: true, beaverEntries: 1, overflow: false, problems: [] },
            { menu: 'collection', opening: 2, shown: true, beaverEntries: 1, overflow: false, problems: [] },
        ]);
        expect((popup as any).state).toBe('closed');

        popup.querySelector('.zotero-menuitem-create-report')!.after(plugin);
        const displaced = await probeMenuIntegrity(window, ['collection'], 1);
        expect(displaced[0].problems.map((p) => `${p.kind}:${p.id}`)).toEqual(['duplicate_id:removeLibrary', 'plugin_entry_with_id:emptyTrash']);
    });

    it('waits for the menu to show from when Zotero has built it, however long the build took', async () => {
        const { popup } = collectionMenu();
        const handler = paneWith(popup);
        const open = handler.getMockImplementation()!;
        handler.mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 8000));
            await open();
        });
        vi.useFakeTimers();
        try {
            const pending = probeMenuIntegrity(window, ['collection'], 1);
            await vi.advanceTimersByTimeAsync(9000);
            expect(await pending).toMatchObject([{ menu: 'collection', opening: 1, shown: true }]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('says when the menu did not open, and when it cannot be probed at all', async () => {
        const { popup } = collectionMenu();
        paneWith(popup, false);
        vi.useFakeTimers();
        try {
            const pending = probeMenuIntegrity(window, ['collection', 'item'], 1);
            await vi.advanceTimersByTimeAsync(6000);
            const results = await pending;
            expect(results[0]).toMatchObject({ menu: 'collection', opening: 1, shown: false });
            expect(results[1]).toMatchObject({ menu: 'item', shown: false, error: 'zotero-itemmenu or ZoteroPane.onItemsContextMenuOpen not found' });
        } finally {
            vi.useRealTimers();
        }
    });
});

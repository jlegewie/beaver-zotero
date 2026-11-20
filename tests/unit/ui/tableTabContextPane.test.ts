// @vitest-environment jsdom
/**
 * Opening the context pane for Beaver's chat on a Beaver table tab.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openTableTabContextPane } from '../../../src/ui/tableTabContextPane';

let layout: string;

/**
 * A window whose context pane a library tab has left collapsed with its
 * splitter hidden. Its `update` does nothing, as Zotero 11's does for a tab
 * type without a context pane.
 */
function libraryLeftWindow(): Window {
    document.body.innerHTML = '';
    for (const id of [
        'zotero-context-splitter',
        'zotero-context-splitter-stacked',
        'zotero-context-pane',
        'zotero-context-pane-inner',
        'zotero-context-pane-sidenav',
    ]) {
        const el = document.createElement('div');
        el.id = id;
        document.body.appendChild(el);
    }
    document.getElementById('zotero-context-splitter')!.setAttribute('hidden', 'true');
    document.getElementById('zotero-context-splitter-stacked')!.setAttribute('hidden', 'true');
    document.getElementById('zotero-context-pane')!.setAttribute('collapsed', 'true');
    return { document, ZoteroContextPane: { update: vi.fn() } } as unknown as Window;
}

beforeEach(() => {
    layout = 'standard';
    Object.assign(Zotero as any, { Prefs: { get: vi.fn((key: string) => (key === 'layout' ? layout : undefined)) } });
});

describe('openTableTabContextPane', () => {
    it("shows the standard splitter after a library tab hid it, though Zotero's update skips the tab", () => {
        const win = libraryLeftWindow();

        openTableTabContextPane(win);

        expect(document.getElementById('zotero-context-pane')!.hasAttribute('collapsed')).toBe(false);
        expect(document.getElementById('zotero-context-splitter')!.hasAttribute('hidden')).toBe(false);
        // "true", not "": Zotero 7–10 read an empty value as off.
        expect(document.getElementById('zotero-context-splitter-stacked')!.getAttribute('hidden')).toBe('true');
        expect(document.getElementById('zotero-context-pane-sidenav')!.hidden).toBe(true);
    });

    it('shows the stacked splitter, and hides the standard one, in the stacked layout', () => {
        layout = 'stacked';
        const win = libraryLeftWindow();
        document.getElementById('zotero-context-splitter')!.removeAttribute('hidden');

        openTableTabContextPane(win);

        expect(document.getElementById('zotero-context-splitter-stacked')!.hasAttribute('hidden')).toBe(false);
        expect(document.getElementById('zotero-context-splitter')!.getAttribute('hidden')).toBe('true');
    });
});

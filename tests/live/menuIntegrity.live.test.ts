/**
 * Live check that Zotero's own context-menu entries keep their ids with
 * Beaver's entries added.
 *
 * Zotero finds its menu entries by id and assigns some menus' ids by position
 * each time they open, so a plugin entry placed among Zotero's takes over the
 * id, and the command, of the entry it displaces. That shows only from the
 * second opening on. `/beaver/test/menu-integrity` opens each menu through
 * Zotero's own right-click handler several times and reports duplicate ids
 * and plugin entries that carry an id.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero, logged in.
 *
 * Side effects: selects the library tab, and opens and closes the collection
 * and item context menus for the current selection.
 *
 * Run with: `npm run test:live -- menuIntegrity`
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { selectLibraryTab } from '../helpers/beaverSurfaces';
import { post } from '../helpers/zoteroHttpClient';
import type { MenuProbeOpening } from '../../src/modules/zoteroMenuIntegrity';

interface MenuIntegrityResponse {
    error?: string;
    windowId?: string;
    menuManager?: boolean;
    results: MenuProbeOpening[];
}

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

describe("Zotero's context menus with Beaver's entries", () => {
    it('keep every entry its own id over repeated openings', async (ctx) => {
        skipIfNoZotero(ctx, available);
        const tab = await selectLibraryTab();
        if (tab.selected_tab_type !== 'library') ctx.skip(`could not select the library tab: ${tab.error ?? 'unknown'}`);

        const response = await post<MenuIntegrityResponse>(
            '/beaver/test/menu-integrity',
            { menus: ['collection', 'item'], openings: 3 },
            { timeout: 60000 },
        );

        expect(response.error).toBeUndefined();
        expect(response.results).toHaveLength(6);
        for (const result of response.results) {
            expect(result.error, `${result.menu} menu`).toBeUndefined();
            expect(result.shown, `${result.menu} menu, opening ${result.opening}, did not open`).toBe(true);
            // Without Beaver's entries in the menu the check proves nothing about
            // them. Entries in MenuManager's overflow submenu exist only once it
            // opens, and sit after Zotero's own.
            if (response.menuManager && !result.overflow) {
                expect(result.beaverEntries, `${result.menu} menu, opening ${result.opening}, has no Beaver entries`).toBeGreaterThan(0);
            }
        }
        const problems = response.results.flatMap((result) =>
            result.problems.map((problem) => ({ menu: result.menu, opening: result.opening, ...problem })));
        expect(problems).toEqual([]);
    }, 90000);
});

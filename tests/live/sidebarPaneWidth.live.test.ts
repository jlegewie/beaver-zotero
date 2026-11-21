/**
 * Live tests: the pane holding the main-window sidebar keeps its width while
 * Zotero sizes that pane itself.
 *
 * Zotero writes the pane's inline width from its own `width` attribute and lays
 * the window out in the same task. On a reader tab it does so on every window
 * resize, and the reader's own resize event counts as one. If that write moved
 * the pane, the reader would resize, Zotero would write again, and the PDF would
 * flicker without end. `/beaver/test/sidebar-pane-width` runs Zotero's code with
 * a width that differs from the sidebar width and measures the pane in the same
 * task, so the check needs no visible window.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero, logged in.
 *   - One main window, in the standard (three-pane) layout.
 *   - The `SMALL_PDF` fixture present and not excluded.
 *
 * Side effects: opens the `SMALL_PDF` reader tab, selects the library tab, and
 * shows the main-window sidebar, which is hidden again in teardown if it was
 * hidden before.
 *
 * Run with: `npm run test:live -- sidebarPaneWidth`
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { SMALL_PDF } from '../helpers/fixtures';
import {
    applicationState,
    selectLibraryTab,
    selectReaderTab,
    setBeaverSidebar,
    sidebarPaneWidth,
} from '../helpers/beaverSurfaces';

const TEST_TIMEOUT_MS = 120000;

let available = false;
let sidebarWasVisible = false;

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) return;
    sidebarWasVisible = (await applicationState()).surfaces.sidebar_visible;
});

afterAll(async () => {
    if (!available || sidebarWasVisible) return;
    await setBeaverSidebar(false).catch(() => undefined);
});

/** Show the sidebar on the selected tab, then let Zotero size its pane. */
async function measure(ctx: any) {
    const shown = await setBeaverSidebar(true);
    expect(shown.ok).toBe(true);
    const res = await sidebarPaneWidth();
    if (res.error === 'stacked_layout') ctx.skip('Zotero is in the stacked layout');
    expect(res.ok).toBe(true);
    // Zotero did write its own width; the check is meaningless otherwise.
    expect(res.inline_width_during).toBe(`${res.zotero_width}px`);
    return res;
}

describe('the sidebar pane keeps its width while Zotero sizes it', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('on a reader tab, through the context pane update that runs on every resize', async (ctx) => {
        const tab = await selectReaderTab(SMALL_PDF);
        if (tab.error === 'not_found') ctx.skip(`The ${SMALL_PDF.description} fixture is not in this library`);
        expect(tab.ok).toBe(true);
        const res = await measure(ctx);
        expect(res.location).toBe('reader');
        expect(res.width_during).toBe(res.width_before);
    }, TEST_TIMEOUT_MS);

    it('on the library tab, through the item pane reacting to its width attribute', async (ctx) => {
        const tab = await selectLibraryTab();
        expect(tab.ok).toBe(true);
        const res = await measure(ctx);
        expect(res.location).toBe('library');
        expect(res.width_during).toBe(res.width_before);
    }, TEST_TIMEOUT_MS);
});

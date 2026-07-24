/**
 * Live tests for which Beaver surface makes reader context available.
 *
 * Reader tracking is shared state, not a sidebar feature. It is mounted once
 * globally and gated on "any Beaver surface is open", so the separate Beaver
 * window gets the same reader context the sidebar does — the open attachment,
 * its page and content kind, and the reader's library — and neither surface's
 * own mount owns it. These tests drive that through dev endpoints:
 *   - `/beaver/test/beaver-window` / `/beaver/test/beaver-sidebar` to open and
 *     close each surface.
 *   - `/beaver/test/select-tab` to open the reader tab under test.
 *   - `/beaver/test/application-state` to read what a run would send.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - Logged in with the profile loaded — reader tracking is gated on library
 *     access being ready, so the suite skips without it.
 *   - The `SMALL_PDF` fixture present in a library that is not excluded in
 *     Beaver Preferences.
 *
 * Side effects: opens a reader tab, and toggles both Beaver surfaces. Both
 * surfaces are closed again in teardown.
 *
 * Run with: `npm run test:live -- beaverWindowContext`
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { SMALL_PDF } from '../helpers/fixtures';
import {
    applicationState,
    closeAllSurfaces,
    getExclusionState,
    selectReaderTab,
    setBeaverSidebar,
    setBeaverWindow,
    type ApplicationStateResponse,
} from '../helpers/beaverSurfaces';

/**
 * Each test drives several surface/tab transitions, each with its own settle
 * budget, so the suite needs far more than the live config's default timeout.
 */
const TEST_TIMEOUT_MS = 120000;

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) return;
    // Open the fixture once up front: the first open of a PDF in a session
    // drags in work that competes with everything else on Zotero's main
    // thread, which would otherwise be charged to whichever test ran first.
    await selectReaderTab(SMALL_PDF).catch(() => undefined);
}, 240000);

afterAll(async () => {
    if (!available) return;
    // Never leave a surface open for the next suite / the user.
    await closeAllSurfaces().catch(() => undefined);
});

/**
 * Put the instance in the state every test here starts from: both surfaces
 * closed, with the fixture's reader tab selected.
 *
 * Skips (rather than fails) when the instance cannot exercise the path — no
 * profile means reader tracking never starts, and a missing fixture means there
 * is no reader to track.
 */
async function openReaderWithBeaverClosed(ctx: any): Promise<void> {
    const { has_profile: hasProfile } = await getExclusionState();
    if (!hasProfile) {
        ctx.skip('Beaver profile is not loaded; log in to run the reader-context tests');
    }
    await closeAllSurfaces();
    const tab = await selectReaderTab(SMALL_PDF);
    if (!tab.ok) {
        ctx.skip(`Could not open the reader tab for ${SMALL_PDF.description}: ${tab.error ?? 'unknown'}`);
    }
}

/** Assert the full reader context for the fixture is present and coherent. */
function expectFixtureReaderContext(state: ApplicationStateResponse): void {
    expect(state.context_atoms.reader_attachment).toEqual({
        library_id: SMALL_PDF.library_id,
        zotero_key: SMALL_PDF.zotero_key,
    });
    expect(state.application_state.current_view).toBe('file_reader');
    expect(state.application_state.reader_state).toMatchObject({
        library_id: SMALL_PDF.library_id,
        zotero_key: SMALL_PDF.zotero_key,
        content_kind: 'pdf',
    });
    expect(state.application_state.reader_state?.current_page).toBeGreaterThan(0);
    // In reader view the current library is taken from the reader attachment.
    expect(state.application_state.current_library?.library_id).toBe(SMALL_PDF.library_id);
}

/** Assert no reader context is reported at all. */
function expectNoReaderContext(state: ApplicationStateResponse): void {
    expect(state.context_atoms.reader_attachment).toBeNull();
    expect(state.context_atoms.reader_text_selection).toBeNull();
    expect(state.application_state.reader_state).toBeUndefined();
}

describe('reader context and Beaver surfaces', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('reports no reader context while no Beaver surface is open', async (ctx) => {
        await openReaderWithBeaverClosed(ctx);

        const state = await applicationState();
        expect(state.surfaces.beaver_ui_visible).toBe(false);
        // The reader tab is open and selected — only the closed surfaces keep
        // tracking off.
        expect(state.application_state.current_view).toBe('file_reader');
        expectNoReaderContext(state);
    }, TEST_TIMEOUT_MS);

    it('tracks the reader when only the separate window is open', async (ctx) => {
        await openReaderWithBeaverClosed(ctx);

        const opened = await setBeaverWindow(true);
        expect(opened.surfaces).toMatchObject({
            window_open: true,
            sidebar_visible: false,
            beaver_ui_visible: true,
        });
        expect(opened.reader_context_settled).toBe(true);
        // The window must know which bundle renders it, so the plugin can close
        // it when that main window unloads.
        expect(opened.owner_is_main_window).toBe(true);

        expectFixtureReaderContext(await applicationState());
    }, TEST_TIMEOUT_MS);

    it('tracks the reader when only the sidebar is open', async (ctx) => {
        await openReaderWithBeaverClosed(ctx);

        const opened = await setBeaverSidebar(true);
        expect(opened.surfaces).toMatchObject({
            sidebar_visible: true,
            window_open: false,
            beaver_ui_visible: true,
        });
        expect(opened.reader_context_settled).toBe(true);

        expectFixtureReaderContext(await applicationState());
    }, TEST_TIMEOUT_MS);

    it('clears reader context when the only open surface closes', async (ctx) => {
        await openReaderWithBeaverClosed(ctx);
        await setBeaverWindow(true);

        const closed = await setBeaverWindow(false);
        expect(closed.surfaces.window_open).toBe(false);
        expect(closed.surfaces.beaver_ui_visible).toBe(false);
        expect(closed.reader_context_settled).toBe(true);

        expectNoReaderContext(await applicationState());
    }, TEST_TIMEOUT_MS);

    it('keeps reader context when one surface closes while the other stays open', async (ctx) => {
        await openReaderWithBeaverClosed(ctx);
        await setBeaverSidebar(true);
        await setBeaverWindow(true);

        const closed = await setBeaverWindow(false);
        expect(closed.surfaces).toMatchObject({
            window_open: false,
            sidebar_visible: true,
            beaver_ui_visible: true,
        });
        expect(closed.reader_context_settled).toBe(true);

        // Tracking is keyed to "any surface open", so the sidebar keeps it alive.
        expectFixtureReaderContext(await applicationState());
    }, TEST_TIMEOUT_MS);

    it('picks up a reader that was already open when the window opens', async (ctx) => {
        await openReaderWithBeaverClosed(ctx);
        // The reader tab was selected before any surface opened, so there is no
        // tab notification to react to — tracking must initialize from the
        // already-selected tab.
        const opened = await setBeaverWindow(true);
        expect(opened.reader_context_settled).toBe(true);

        expectFixtureReaderContext(await applicationState());
    }, TEST_TIMEOUT_MS);

    it('is idempotent when the window is opened twice', async (ctx) => {
        await openReaderWithBeaverClosed(ctx);
        await setBeaverWindow(true);

        const again = await setBeaverWindow(true);
        expect(again.ok).toBe(true);
        expect(again.surfaces.window_open).toBe(true);
        expect(again.reader_context_settled).toBe(true);
        expect(again.owner_is_main_window).toBe(true);

        expectFixtureReaderContext(await applicationState());
    }, TEST_TIMEOUT_MS);

    it('is a no-op when a surface is closed while already closed', async (ctx) => {
        await openReaderWithBeaverClosed(ctx);

        const window = await setBeaverWindow(false);
        expect(window.ok).toBe(true);
        expect(window.surfaces.window_open).toBe(false);
        // No window means no owner to report.
        expect(window.owner_is_main_window).toBeNull();

        const sidebar = await setBeaverSidebar(false);
        expect(sidebar.ok).toBe(true);
        expect(sidebar.surfaces.sidebar_visible).toBe(false);

        expectNoReaderContext(await applicationState());
    }, TEST_TIMEOUT_MS);
});

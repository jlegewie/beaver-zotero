/**
 * Live tests for how reader tracking follows the selected Zotero tab and the
 * library-exclusion boundary.
 *
 * Covers the transitions the tracking hook has to get right while a Beaver
 * surface is open: reader → reader (including across libraries), reader →
 * library tab, and re-selecting the tab already being tracked. Also covers the
 * exclusion choke point — an attachment in a library the user excluded from
 * Beaver must never become reader context, and excluding a library while its
 * reader is open must drop the context that is already staged.
 *
 * Drives the running instance through dev endpoints:
 *   - `/beaver/test/select-tab` to select the library tab or a reader tab.
 *   - `/beaver/test/beaver-window` to open the surface that enables tracking.
 *   - `/beaver/test/excluded-libraries` to change the in-memory excluded set.
 *   - `/beaver/test/application-state` to read what a run would send.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - Logged in with the profile loaded (tracking is gated on library access).
 *   - The `SMALL_PDF` and `NORMAL_PDF` fixtures present and not excluded; the
 *     cross-library test additionally needs `GROUP_LIB_PDF` and skips without it.
 *
 * Side effects: opens reader tabs, selects the library tab, opens the separate
 * Beaver window, and temporarily rewrites the in-memory excluded-libraries set
 * (never persisted to the backend). The cold-open test CLOSES every open reader
 * tab. Beaver's surfaces and the excluded set are restored in teardown; closed
 * reader tabs are not reopened.
 *
 * Run with: `npm run test:live -- readerContextTracking`
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { GROUP_LIB_PDF, NORMAL_PDF, SMALL_PDF } from '../helpers/fixtures';
import {
    applicationState,
    closeAllSurfaces,
    excludeLibraries,
    getExclusionState,
    restoreExclusions,
    selectLibraryTab,
    selectReaderTab,
    setBeaverWindow,
    type ExclusionState,
} from '../helpers/beaverSurfaces';

/**
 * Each test drives several surface/tab transitions, each with its own settle
 * budget, so the suite needs far more than the live config's default timeout.
 */
const TEST_TIMEOUT_MS = 120000;

/**
 * How long to give an effect that is not driven by a settling endpoint — the
 * exclusion tests change the searchable scope directly, and only React's
 * re-run of the tracking effect clears (or restores) the attachment.
 */
const EXCLUSION_SETTLE_MS = 3000;

let available = false;
let originalExclusions: ExclusionState['excluded_libraries'] = [];

beforeAll(async () => {
    available = await isZoteroAvailable();
    if (!available) return;
    originalExclusions = (await getExclusionState()).excluded_libraries ?? [];

    // Open each fixture once up front. The first open of a PDF in a session
    // drags in work (validation, extraction) that competes with everything
    // else on Zotero's main thread; paying that here keeps the per-test
    // transitions measuring the transition rather than the first load.
    for (const fixture of [SMALL_PDF, NORMAL_PDF, GROUP_LIB_PDF]) {
        await selectReaderTab(fixture).catch(() => undefined);
    }
}, 240000);

afterEach(async () => {
    if (!available) return;
    // Exclusions are global state; a leaked one would silently disable every
    // later test's reader context.
    await restoreExclusions(originalExclusions).catch(() => undefined);
});

afterAll(async () => {
    if (!available) return;
    await closeAllSurfaces().catch(() => undefined);
});

/**
 * Open the separate Beaver window with the given attachment's reader selected,
 * so tracking is active and settled before the test acts.
 */
async function trackReader(
    ctx: any,
    attachment: { library_id: number; zotero_key: string; description: string },
): Promise<void> {
    const { has_profile: hasProfile } = await getExclusionState();
    if (!hasProfile) {
        ctx.skip('Beaver profile is not loaded; log in to run the reader-tracking tests');
    }
    const tab = await selectReaderTab(attachment);
    if (!tab.ok) {
        ctx.skip(`Could not open the reader tab for ${attachment.description}: ${tab.error ?? 'unknown'}`);
    }
    const opened = await setBeaverWindow(true);
    expect(opened.surfaces.beaver_ui_visible).toBe(true);
    expect(opened.reader_context_settled).toBe(true);
}

/**
 * Poll until `reader_state.current_page` is a number, or give up.
 *
 * The page is read live off the open reader rather than stored with the
 * attachment, so it lags a cold open by however long the viewer takes to
 * initialize. Returns null if it never resolves.
 */
async function waitForReaderPage(timeoutMs = 30000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const page = (await applicationState()).application_state.reader_state?.current_page;
        if (typeof page === 'number') return page;
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

describe('reader tracking follows the selected tab', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('swaps the attachment when a different reader tab is selected', async (ctx) => {
        await trackReader(ctx, SMALL_PDF);
        expect((await applicationState()).context_atoms.reader_attachment).toEqual({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
        });

        const switched = await selectReaderTab(NORMAL_PDF);
        expect(switched.ok).toBe(true);
        expect(switched.reader_context_settled).toBe(true);

        const state = await applicationState();
        // Nothing from the previous reader may survive the switch: the page and
        // content kind in `reader_state` are read from the OPEN reader, so a
        // stale attachment would be reported alongside the new reader's page.
        expect(state.context_atoms.reader_attachment).toEqual({
            library_id: NORMAL_PDF.library_id,
            zotero_key: NORMAL_PDF.zotero_key,
        });
        expect(state.application_state.reader_state).toMatchObject({
            library_id: NORMAL_PDF.library_id,
            zotero_key: NORMAL_PDF.zotero_key,
            content_kind: 'pdf',
        });
    }, TEST_TIMEOUT_MS);

    it('keeps the attachment when the tracked reader tab is re-selected', async (ctx) => {
        await trackReader(ctx, SMALL_PDF);

        const again = await selectReaderTab(SMALL_PDF);
        expect(again.ok).toBe(true);
        expect(again.reader_context_settled).toBe(true);

        // Re-selecting must be a no-op, not a teardown-and-rebuild.
        expect((await applicationState()).context_atoms.reader_attachment).toEqual({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
        });
    }, TEST_TIMEOUT_MS);

    it('clears reader context when the library tab is selected', async (ctx) => {
        await trackReader(ctx, SMALL_PDF);

        const library = await selectLibraryTab();
        expect(library.ok).toBe(true);
        expect(library.reader_context_settled).toBe(true);
        expect(library.surfaces.is_library_tab).toBe(true);

        const state = await applicationState();
        expect(state.application_state.current_view).toBe('library');
        expect(state.context_atoms.reader_attachment).toBeNull();
        expect(state.context_atoms.reader_text_selection).toBeNull();
        expect(state.application_state.reader_state).toBeUndefined();
    }, TEST_TIMEOUT_MS);

    it('restores reader context when a reader tab is selected again', async (ctx) => {
        await trackReader(ctx, SMALL_PDF);
        await selectLibraryTab();

        const back = await selectReaderTab(SMALL_PDF);
        expect(back.ok).toBe(true);
        expect(back.reader_context_settled).toBe(true);

        const state = await applicationState();
        expect(state.application_state.current_view).toBe('file_reader');
        expect(state.context_atoms.reader_attachment).toEqual({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
        });
    }, TEST_TIMEOUT_MS);

    it('tracks a reader tab that is opened cold while Beaver is already open', async (ctx) => {
        await trackReader(ctx, SMALL_PDF);

        // Closing every reader tab first makes this a cold open: the reader
        // instance does not exist yet when the tab-select notification fires,
        // so tracking has to resolve it by polling rather than reading it
        // straight off the tab.
        const cold = await selectReaderTab(NORMAL_PDF, { closeTabs: true });
        expect(cold.ok).toBe(true);
        expect(cold.reader_context_settled).toBe(true);

        const state = await applicationState();
        expect(state.context_atoms.reader_attachment).toEqual({
            library_id: NORMAL_PDF.library_id,
            zotero_key: NORMAL_PDF.zotero_key,
        });
        expect(state.application_state.reader_state).toMatchObject({
            library_id: NORMAL_PDF.library_id,
            zotero_key: NORMAL_PDF.zotero_key,
            content_kind: 'pdf',
        });

        // `current_page` is read live off the open reader, not stored with the
        // attachment, so a cold open reports null until the PDF viewer has
        // initialized. Tracking is still correct at that point — the page just
        // catches up shortly after.
        expect(await waitForReaderPage()).toBeGreaterThan(0);
    }, TEST_TIMEOUT_MS);

    it('reports the new library when switching to a reader in another library', async (ctx) => {
        await trackReader(ctx, SMALL_PDF);

        const switched = await selectReaderTab(GROUP_LIB_PDF);
        if (!switched.ok) {
            ctx.skip(`No group-library reader available: ${switched.error ?? 'unknown'}`);
        }
        expect(switched.reader_context_settled).toBe(true);

        const state = await applicationState();
        expect(state.context_atoms.reader_attachment).toEqual({
            library_id: GROUP_LIB_PDF.library_id,
            zotero_key: GROUP_LIB_PDF.zotero_key,
        });
        // In reader view the current library follows the reader attachment.
        expect(state.application_state.current_library?.library_id).toBe(GROUP_LIB_PDF.library_id);
    }, TEST_TIMEOUT_MS);
});

describe('reader tracking and excluded libraries', () => {
    beforeEach((ctx) => {
        skipIfNoZotero(ctx, available);
    });

    it('never tracks a reader in an excluded library', async (ctx) => {
        const { has_profile: hasProfile } = await getExclusionState();
        if (!hasProfile) {
            ctx.skip('Beaver profile is not loaded; log in to run the exclusion tests');
        }
        // Exclude BEFORE the reader is opened, so tracking never starts.
        const excluded = await excludeLibraries([SMALL_PDF.library_id]);
        expect(excluded.searchable_library_ids).not.toContain(SMALL_PDF.library_id);

        const tab = await selectReaderTab(SMALL_PDF);
        if (!tab.ok) {
            ctx.skip(`Could not open the reader tab for ${SMALL_PDF.description}: ${tab.error ?? 'unknown'}`);
        }
        const opened = await setBeaverWindow(true);
        expect(opened.reader_context_settled).toBe(true);

        const state = await applicationState();
        // The reader is open — the exclusion, not the tab, is what withholds it.
        expect(state.application_state.current_view).toBe('file_reader');
        expect(state.context_atoms.reader_attachment).toBeNull();
        expect(state.context_atoms.reader_text_selection).toBeNull();
        expect(state.application_state.reader_state).toBeUndefined();
    }, TEST_TIMEOUT_MS);

    it('drops the tracked attachment when its library is excluded mid-session', async (ctx) => {
        await trackReader(ctx, SMALL_PDF);
        expect((await applicationState()).context_atoms.reader_attachment).not.toBeNull();

        await excludeLibraries([SMALL_PDF.library_id]);

        // The hook re-runs on the searchable-scope change; give it a moment to
        // tear the previous setup down.
        await new Promise((resolve) => setTimeout(resolve, EXCLUSION_SETTLE_MS));

        const state = await applicationState();
        expect(state.context_atoms.reader_attachment).toBeNull();
        expect(state.application_state.reader_state).toBeUndefined();
    }, TEST_TIMEOUT_MS);

    it('resumes tracking when the library is no longer excluded', async (ctx) => {
        await trackReader(ctx, SMALL_PDF);
        await excludeLibraries([SMALL_PDF.library_id]);
        await new Promise((resolve) => setTimeout(resolve, EXCLUSION_SETTLE_MS));
        expect((await applicationState()).context_atoms.reader_attachment).toBeNull();

        await restoreExclusions(originalExclusions);
        await new Promise((resolve) => setTimeout(resolve, EXCLUSION_SETTLE_MS));

        const state = await applicationState();
        expect(state.context_atoms.reader_attachment).toEqual({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
        });
        expect(state.application_state.reader_state).toMatchObject({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
        });
    }, TEST_TIMEOUT_MS);
});

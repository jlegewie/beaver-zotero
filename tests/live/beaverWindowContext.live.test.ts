/**
 * Live tests for the reader context Beaver reports while only the separate
 * Beaver window is open (main-window sidebar closed).
 *
 * Reader tracking is shared state, not a sidebar feature: with the window as
 * the only open surface, `application_state` must still carry the open reader
 * attachment, its page and content kind, plus the reader's library. These tests
 * drive that through two dev endpoints:
 *   - `/beaver/test/beaver-window` to open/close the separate window.
 *   - `/beaver/test/application-state` to read what a run would send.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - Logged in with the profile loaded (reader tracking is gated on library
 *     access being ready), and the main-window sidebar CLOSED.
 *   - A reader tab open and selected, from a library that is not excluded
 *     in Beaver Preferences (the tests skip when no reader tab is selected).
 *   - Toggles the separate Beaver window in the running Zotero.
 *
 * Run with: `npm run test:live -- beaverWindowContext`
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

interface Surfaces {
    sidebar_visible: boolean;
    window_open: boolean;
    beaver_ui_visible: boolean;
    is_library_tab: boolean;
}

interface ApplicationStateResponse {
    ok: boolean;
    application_state: {
        current_view: 'library' | 'file_reader' | 'note_editor';
        reader_state?: {
            library_id: number;
            zotero_key: string;
            current_page?: number | null;
            content_kind?: string;
        };
        current_library?: { library_id: number };
    };
    surfaces: Surfaces;
    context_atoms: {
        reader_attachment: { library_id: number; zotero_key: string } | null;
        reader_text_selection: unknown;
    };
}

const getApplicationState = () =>
    post('/beaver/test/application-state', {}) as Promise<ApplicationStateResponse>;

const getProfileState = () =>
    post('/beaver/test/excluded-libraries', {}) as Promise<{ has_profile: boolean }>;

const setWindow = (open: boolean) =>
    post('/beaver/test/beaver-window', { open }) as Promise<{
        ok: boolean;
        // The endpoint waits for the window atom AND the reader-context effects
        // it triggers, so assertions below do not race React.
        reader_context_settled: boolean;
        owner_is_main_window: boolean | null;
        surfaces: Surfaces;
    }>;

afterAll(async () => {
    if (!available) return;
    // Never leave the separate window open for the next suite / the user.
    await setWindow(false).catch(() => undefined);
});

/**
 * Skips unless the run can exercise the window-only path: a reader tab must be
 * selected, and the sidebar must be closed (a visible sidebar keeps reader
 * tracking alive on its own and would mask the regression these tests guard).
 */
async function skipUnlessWindowOnlyReader(ctx: any): Promise<ApplicationStateResponse> {
    // Reader tracking is gated on library access, which needs a loaded profile.
    const { has_profile: hasProfile } = await getProfileState();
    if (!hasProfile) {
        ctx.skip('Beaver profile is not loaded; log in to run the window-only reader tests');
    }
    const state = await getApplicationState();
    if (state.surfaces.sidebar_visible) {
        ctx.skip('Close the Beaver sidebar to run the window-only reader tests');
    }
    if (state.application_state.current_view !== 'file_reader') {
        ctx.skip('Open a reader tab to run the window-only reader tests');
    }
    return state;
}

describe('reader context with only the separate Beaver window open', () => {
    it('reports the open reader attachment, page and library', async (ctx) => {
        skipIfNoZotero(ctx, available);
        await setWindow(false);
        await skipUnlessWindowOnlyReader(ctx);

        const windowState = await setWindow(true);
        expect(windowState.surfaces.window_open).toBe(true);
        expect(windowState.surfaces.beaver_ui_visible).toBe(true);
        expect(windowState.reader_context_settled).toBe(true);
        // The window must know which bundle renders it, so the plugin can close
        // it when that main window unloads.
        expect(windowState.owner_is_main_window).toBe(true);

        const state = await getApplicationState();
        const attachment = state.context_atoms.reader_attachment;
        expect(attachment).not.toBeNull();
        const readerState = state.application_state.reader_state;
        expect(readerState).toMatchObject({
            library_id: attachment!.library_id,
            zotero_key: attachment!.zotero_key,
        });
        // Whichever reader kind is open, its content kind must be reported.
        expect(['pdf', 'epub', 'snapshot']).toContain(readerState?.content_kind);
        // Only PDFs have a page coordinate on every position; EPUB/snapshot
        // readers can legitimately report none.
        if (readerState?.content_kind === 'pdf') {
            expect(readerState.current_page).toBeGreaterThan(0);
        }
        expect(state.application_state.current_library?.library_id).toBe(attachment!.library_id);
    });

    it('clears reader context when the window closes', async (ctx) => {
        skipIfNoZotero(ctx, available);
        await setWindow(false);
        await skipUnlessWindowOnlyReader(ctx);
        await setWindow(true);

        const closed = await setWindow(false);
        expect(closed.surfaces.window_open).toBe(false);
        expect(closed.surfaces.beaver_ui_visible).toBe(false);
        expect(closed.reader_context_settled).toBe(true);

        const state = await getApplicationState();
        expect(state.context_atoms.reader_attachment).toBeNull();
        expect(state.context_atoms.reader_text_selection).toBeNull();
        expect(state.application_state.reader_state).toBeUndefined();
    });
});

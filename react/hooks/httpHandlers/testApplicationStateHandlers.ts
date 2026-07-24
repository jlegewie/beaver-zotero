/**
 * Dev-only HTTP handlers for inspecting the run context and toggling Beaver's
 * surfaces.
 *
 * `/beaver/test/application-state` reports the `application_state` an agent run
 * would send right now, together with the surfaces that are currently open. It
 * goes through the same provider the run path uses
 * (`getApplicationStateProvider()`), so it reflects the real reader/library
 * context — including whether reader tracking is active while only the separate
 * Beaver window is open.
 *
 * `/beaver/test/beaver-window` opens or closes that separate window, which has
 * no other headless entry point (it is normally opened by a keyboard shortcut
 * or the header button).
 *
 * `/beaver/test/beaver-sidebar` does the same for the main-window sidebar,
 * going through the `toggleChat` event the toolbar button dispatches.
 *
 * `/beaver/test/select-tab` selects the library tab or an attachment's reader
 * tab. All three surface/tab endpoints wait for reader tracking to catch up
 * before returning, so callers can read `/beaver/test/application-state`
 * immediately after without racing React.
 *
 * Wired to their paths in `useHttpEndpoints.ts`.
 */

import { BeaverUIFactory } from '../../../src/ui/ui';
import { eventManager } from '../../events/eventManager';
import { store } from '../../store';
import { getApplicationStateProvider } from '../../atoms/applicationState';
import {
    currentReaderAttachmentAtom,
    isReaderLibrarySearchable,
    readerTextSelectionAtom,
} from '../../atoms/messageComposition';
import { searchableLibraryIdsAtom } from '../../atoms/profile';
import { getCurrentReader } from '../../utils/readerUtils';
import { currentNoteItemAtom } from '../../atoms/zoteroContext';
import {
    isBeaverUIVisibleAtom,
    isBeaverWindowOpenAtom,
    isLibraryTabAtom,
    isSidebarVisibleAtom,
} from '../../atoms/ui';

/** Snapshot of which Beaver surfaces are currently open. */
function getSurfaces() {
    return {
        sidebar_visible: store.get(isSidebarVisibleAtom),
        window_open: store.get(isBeaverWindowOpenAtom),
        beaver_ui_visible: store.get(isBeaverUIVisibleAtom),
        is_library_tab: store.get(isLibraryTabAtom),
    };
}

const SETTLE_TIMEOUT_MS = 10000;
const SETTLE_POLL_MS = 100;
const SETTLE_HOLD_MS = 400;

/** Per-request override for how long to wait for a transition to settle. */
function settleTimeout(request: any): number {
    const timeout = Number(request?.timeout_ms);
    return Number.isFinite(timeout) && timeout > 0 ? timeout : SETTLE_TIMEOUT_MS;
}

/** Poll `condition` until it holds or the timeout expires. */
async function waitFor(condition: () => boolean, timeoutMs = SETTLE_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (condition()) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
    }
}

/** Whether `condition` keeps holding for the given duration. */
async function holdsFor(condition: () => boolean, durationMs: number): Promise<boolean> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
        if (!condition()) return false;
    }
    return true;
}

/**
 * The attachment reader tracking should end up holding, or `null` when nothing
 * should be tracked (no Beaver surface open, no reader tab, or a reader in a
 * library the user excluded from Beaver).
 */
function expectedReaderAttachment(): { libraryID: number; key: string } | null {
    if (!store.get(isBeaverUIVisibleAtom)) return null;
    const reader = getCurrentReader();
    if (!reader) return null;
    if (!isReaderLibrarySearchable(store.get(searchableLibraryIdsAtom), reader)) return null;
    const libraryAndKey = Zotero.Items.getLibraryAndKeyFromID(reader.itemID);
    return libraryAndKey ? { libraryID: libraryAndKey.libraryID, key: libraryAndKey.key } : null;
}

/**
 * Whether reader tracking has caught up with the surfaces that are open.
 *
 * The window root publishes `isBeaverWindowOpenAtom` from an effect; the global
 * reader hook then reacts in a second effect and resolves the attachment
 * asynchronously. Callers that assert on reader context must wait for that
 * whole chain, not just the window atom, or they race React.
 *
 * Comparing identities rather than null-ness is what makes this a real
 * post-condition: a stale attachment left over from a previous reader would
 * otherwise satisfy a "non-null" check immediately.
 */
function isReaderContextSettled(): boolean {
    const attachment = store.get(currentReaderAttachmentAtom);
    const expected = expectedReaderAttachment();
    if (!expected) return attachment === null;
    return attachment?.libraryID === expected.libraryID && attachment?.key === expected.key;
}

/**
 * Wait for reader tracking to reach — and stay at — the state the open surfaces
 * and selected tab imply.
 *
 * Requiring the state to HOLD, not just occur, is what makes this reliable: an
 * item lookup started before the transition could otherwise land right after a
 * single sample and change the answer under the caller.
 */
async function waitForReaderContext(timeoutMs: number): Promise<boolean> {
    return await waitFor(isReaderContextSettled, timeoutMs)
        && await holdsFor(isReaderContextSettled, SETTLE_HOLD_MS);
}

/**
 * Open or close the separate Beaver window, then wait for reader context to
 * catch up so callers can assert on `application_state` immediately after.
 */
export async function handleTestBeaverWindowHttpRequest(request: any): Promise<any> {
    const open = request?.open !== false;

    if (open) {
        BeaverUIFactory.openBeaverWindow();
    } else {
        BeaverUIFactory.closeBeaverWindow();
    }

    const timeoutMs = settleTimeout(request);
    const windowSettled = await waitFor(() => store.get(isBeaverWindowOpenAtom) === open, timeoutMs);
    const readerContextSettled = windowSettled && await waitForReaderContext(timeoutMs);

    // The window records the main window whose React bundle renders it; the
    // plugin closes it when that window unloads.
    const beaverWindow = BeaverUIFactory.findBeaverWindow();
    const ownerIsMainWindow = beaverWindow
        ? beaverWindow.__beaverOwnerWindowRef?.deref() === Zotero.getMainWindow()
        : null;

    return {
        ok: windowSettled,
        reader_context_settled: readerContextSettled,
        owner_is_main_window: ownerIsMainWindow,
        surfaces: getSurfaces(),
    };
}

/**
 * Show or hide the main-window sidebar, then wait for reader context to catch
 * up.
 *
 * Goes through the `toggleChat` event rather than writing the atom, so the real
 * open/close path runs (pane layout, staged-item reset). `skipAutoPopulate`
 * keeps the caller's draft message untouched.
 */
export async function handleTestBeaverSidebarHttpRequest(request: any): Promise<any> {
    const open = request?.open !== false;

    if (store.get(isSidebarVisibleAtom) !== open) {
        const location = store.get(isLibraryTabAtom) ? 'library' : 'reader';
        eventManager.dispatch('toggleChat', open
            ? { location, forceOpen: true, skipAutoPopulate: true }
            : { location });
    }

    const timeoutMs = settleTimeout(request);
    const sidebarSettled = await waitFor(() => store.get(isSidebarVisibleAtom) === open, timeoutMs);
    const readerContextSettled = sidebarSettled && await waitForReaderContext(timeoutMs);

    return {
        ok: sidebarSettled,
        reader_context_settled: readerContextSettled,
        surfaces: getSurfaces(),
    };
}

/**
 * Select the library tab (`{ tab: 'library' }`) or an attachment's reader tab
 * (`{ library_id, zotero_key }`), then wait for reader tracking to follow.
 *
 * Reader tracking reacts to Zotero's tab notifications, so this is the headless
 * equivalent of the user switching tabs — the only way to exercise reader →
 * reader and reader → library transitions from a test.
 *
 * `close_tabs` closes every open reader tab first, so the next selection is a
 * cold open. That is a slower and materially different path: the reader
 * instance does not exist when the tab-select notification fires, so tracking
 * has to poll for it. Pair it with a generous `timeout_ms`.
 */
export async function handleTestSelectTabHttpRequest(request: any): Promise<any> {
    const mainWindow = Zotero.getMainWindow();
    const tabs = (mainWindow as any).Zotero_Tabs;
    const { tab, library_id, zotero_key, close_tabs } = request || {};
    const timeoutMs = settleTimeout(request);

    if (close_tabs) {
        tabs.closeAll();
        // Closing lands on the library tab; let tracking observe that before
        // the selection below, so the transition under test starts from a
        // known state rather than from a half-finished teardown.
        await waitFor(() => store.get(isLibraryTabAtom) === true, timeoutMs);
        await waitForReaderContext(timeoutMs);
    }

    if (tab === 'library') {
        tabs.select('zotero-pane');
    } else if (library_id != null && zotero_key != null) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
        if (!item) return { ok: false, error: 'not_found' };
        if (!item.isAttachment()) return { ok: false, error: 'not_an_attachment' };
        // Opens the tab if needed and selects it either way.
        await Zotero.Reader.open(item.id);
    } else {
        return { ok: false, error: 'Provide tab:"library" or library_id + zotero_key' };
    }

    const wantsLibraryTab = tab === 'library';
    const tabSettled = await waitFor(() =>
        store.get(isLibraryTabAtom) === wantsLibraryTab
        && (wantsLibraryTab || getCurrentReader()?.itemID != null), timeoutMs);
    const readerContextSettled = tabSettled && await waitForReaderContext(timeoutMs);

    return {
        ok: tabSettled,
        reader_context_settled: readerContextSettled,
        selected_tab_type: tabs.selectedType ?? null,
        reader_item_id: getCurrentReader()?.itemID ?? null,
        surfaces: getSurfaces(),
    };
}

export async function handleTestApplicationStateHttpRequest(_request: any): Promise<any> {
    const applicationState = await getApplicationStateProvider()(store.get);

    const readerAttachment = store.get(currentReaderAttachmentAtom);
    const noteItem = store.get(currentNoteItemAtom);

    return {
        ok: true,
        application_state: applicationState,
        surfaces: getSurfaces(),
        context_atoms: {
            reader_attachment: readerAttachment
                ? { library_id: readerAttachment.libraryID, zotero_key: readerAttachment.key }
                : null,
            reader_text_selection: store.get(readerTextSelectionAtom),
            note_item: noteItem
                ? { library_id: noteItem.libraryID, zotero_key: noteItem.key }
                : null,
        },
    };
}

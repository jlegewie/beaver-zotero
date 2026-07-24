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
 * Wired to their paths in `useHttpEndpoints.ts`.
 */

import { BeaverUIFactory } from '../../../src/ui/ui';
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

    const windowSettled = await waitFor(() => store.get(isBeaverWindowOpenAtom) === open);
    // Require the settled state to HOLD, not just occur: an item lookup started
    // before the transition could otherwise land right after a single sample.
    const readerContextSettled = windowSettled && await waitFor(isReaderContextSettled)
        && await holdsFor(isReaderContextSettled, SETTLE_HOLD_MS);

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

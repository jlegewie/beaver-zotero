import { atom } from 'jotai';
import { PopupMessage, PopupMessageType } from '../types/popupMessage';
import { ExternalReference } from '@beaver/agent-core/types/externalReferences';
import { getPref } from '../../src/utils/prefs';
import { isUsingBeaverCreditsAtom } from './models';
import type { ActionCategoryFilter } from '@beaver/agent-core/types/actions';

const isSidebarVisibleBaseAtom = atom(false);

/**
 * Whether the main-window sidebar is visible. Hiding it (toolbar toggle,
 * keyboard shortcut, or item-pane collapse) also clears the thread list
 * item filter.
 */
export const isSidebarVisibleAtom = atom(
    (get) => get(isSidebarVisibleBaseAtom),
    (get, set, update: boolean | ((prev: boolean) => boolean)) => {
        const prev = get(isSidebarVisibleBaseAtom);
        const next = typeof update === 'function' ? update(prev) : update;
        set(isSidebarVisibleBaseAtom, next);
        if (prev && !next) set(threadListFilterAtom, null);
    }
);

/**
 * Whether the separate Beaver window is open. Maintained by the window's React
 * root (`useBeaverWindowContext`), which mounts when the window opens and
 * unmounts when it closes.
 */
export const isBeaverWindowOpenAtom = atom(false);

/**
 * Whether Beaver's chat UI is showing anywhere, either the main-window sidebar or the
 * separate window.
 *
 * Context tracking that feeds the chat (current reader attachment, reader text
 * selection) must key off this rather than `isSidebarVisibleAtom`: the separate
 * window shares the same store but has no sidebar, so gating on the sidebar
 * alone leaves those atoms empty for window-only users.
 */
export const isBeaverUIVisibleAtom = atom(
    (get) => get(isSidebarVisibleAtom) || get(isBeaverWindowOpenAtom),
);

export const isLibraryTabAtom = atom(false);
export const selectedZoteroTabIdAtom = atom<string | null>(null);
export const isWebSearchEnabledAtom = atom(false);
export type PreferencePageTab = 'general' | 'sync' | 'permissions' | 'billing' | 'models' | 'actions' | 'advanced' | 'account';
export const activePreferencePageTabAtom = atom<PreferencePageTab>('general');
export const isPreferencePageVisibleAtom = atom(false);

/**
 * A one-shot request to set the Actions preferences category filter. A null
 * filter explicitly clears category filtering. `requestId` makes every request
 * distinct so re-requesting the same category still re-triggers the consumer's
 * effect. `ActionsPreferenceSection` applies it once, then resets this to null.
 */
export interface ActionsCategoryFilterRequest {
    filter: ActionCategoryFilter | null;
    requestId: number;
}
export const pendingActionsCategoryFilterAtom = atom<ActionsCategoryFilterRequest | null>(null);

/**
 * A one-shot request to reveal a specific action in the Actions preferences
 * tab and open it in edit mode (e.g. after clicking an action pill in the
 * chat input). `requestId` makes every request distinct so re-requesting the
 * same action re-triggers the consumers' effects. `ActionsPreferenceSection`
 * clears any active filters; the matching ActionCard scrolls itself into
 * view, enters edit mode, and resets this to null.
 */
export interface PendingActionEditRequest {
    actionId: string;
    requestId: number;
}
export const pendingActionEditRequestAtom = atom<PendingActionEditRequest | null>(null);
export const mcpServerEnabledAtom = atom(getPref('mcpServerEnabled'));
export const mcpCreateNoteToolEnabledAtom = atom(getPref('mcpCreateNoteToolEnabled'));
export const dataProviderEnabledAtom = atom(getPref('dataProviderEnabled'));
export const requestPlusToolsAtom = atom(getPref('requestPlusTools'));
export const isWebSearchAllowedAtom = atom((get) => Boolean(get(isUsingBeaverCreditsAtom) || get(requestPlusToolsAtom)));
export const showFileStatusDetailsAtom = atom(false);

/**
 * Serializable descriptor of a Zotero item used to filter the thread list
 * view (`ThreadListView`) to chats related to that item.
 */
export interface ThreadItemFilter {
    libraryId: number;
    libraryRef?: string;   // libraryRefForLibraryID(item.libraryID)
    itemKey: string;       // identity for chip + active-row checkmark
    keys: string[];        // expanded keys sent to /by-item
    itemType: string;      // item.getItemTypeIconName() → CSSItemTypeIcon
    label: string;         // getDisplayNameFromItem(item)
}

/**
 * Active item filter for the thread list view, or null when unfiltered.
 * Set by ThreadFilterMenu selections and RecentChats "View All"; cleared
 * by the chip's remove control and whenever the thread list view closes.
 */
export const threadListFilterAtom = atom<ThreadItemFilter | null>(null);

/**
 * Whether the thread list shows chats from every Zotero account/profile
 * instead of only those created with the current one. Deliberately global and
 * not reset when the thread list view closes: a user who opted out of instance
 * scoping should stay opted out for the rest of the session rather than having
 * to re-enable it every time they reopen the list.
 */
export const showAllThreadInstancesAtom = atom(false);

const isThreadListViewBaseAtom = atom(false);

/**
 * Whether the thread list view is open. Closing it also clears the item
 * filter
 */
export const isThreadListViewAtom = atom(
    (get) => get(isThreadListViewBaseAtom),
    (get, set, value: boolean) => {
        set(isThreadListViewBaseAtom, value);
        if (!value) set(threadListFilterAtom, null);
    }
);

/**
 * HomeLauncher — selected category for the current UI session (`null` = collapsed)
 */
export type HomeLauncherCategoryId = 'research' | 'write' | 'organize' | 'annotate';
export const homeLauncherCategoryAtom = atom<HomeLauncherCategoryId | null>(null);

// Error Report Dialog
export const isErrorReportDialogVisibleAtom = atom(false);
export const errorReportTextAtom = atom('');
export const isErrorReportSendingAtom = atom(false);

// Skipped Files Dialog
export const isSkippedFilesDialogVisibleAtom = atom(false);

// External Reference Details Dialog
export const isExternalReferenceDetailsDialogVisibleAtom = atom(false);
export const selectedExternalReferenceAtom = atom<ExternalReference | null>(null);

// Active dialog
export type DialogType = 'errorReport' | 'skippedFiles' | 'externalReferenceDetails' | null;

export const activeDialogAtom = atom<DialogType>((get) => {
    if (get(isErrorReportDialogVisibleAtom)) {
        return 'errorReport';
    }
    if (get(isSkippedFilesDialogVisibleAtom)) {
        return 'skippedFiles';
    }
    if (get(isExternalReferenceDetailsDialogVisibleAtom)) {
        return 'externalReferenceDetails';
    }
    return null;
});

// Zotero server download error
export const zoteroServerDownloadErrorAtom = atom(false);
export const zoteroServerCredentialsErrorAtom = atom(false);

// UI behavior and elements
// Shared scroll state for library and reader sidebars
export const userScrolledAtom = atom(false);
// Independent scroll state for separate window
export const windowUserScrolledAtom = atom(false);

// Whether the thread is scrolled to (or within a threshold of) its bottom.
//
// Distinct from `userScrolledAtom`, which records the reader's *intent* to read
// back and is what decides whether auto-scroll follows the stream. This records
// a *measured* fact about the container, so it stays true to the view even when
// the distance changes without a scroll event — content streaming in, a card
// expanding, the pane being resized. Anything that answers "is there more
// below?" — the scroll-down button above all — belongs on this atom.
//
// Published only through `publishScrollPosition` (react/utils/scrollPosition.ts),
// so every writer measures the same way against the same threshold. Starts true:
// a thread with nothing in it yet is at its bottom.
export const isAtBottomAtom = atom(true);
// Independent measured scroll position for the separate window
export const windowIsAtBottomAtom = atom(true);

// Popup Messages
export const popupMessagesAtom = atom<PopupMessage[]>([]);

export const hasPopupMessagesAtom = atom(get => get(popupMessagesAtom).length > 0);

// Remove popup messages by type
export const removePopupMessagesByTypeAtom = atom(
    null,
    (get, set, types: PopupMessageType[]) => {
        set(popupMessagesAtom, (prevMessages) =>
            prevMessages.filter((msg) => !types.includes(msg.type))
        );   
    }
);

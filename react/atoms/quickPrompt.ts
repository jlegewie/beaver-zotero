/**
 * The quick prompt: a composer in the corner of the main window while the
 * sidebar is closed, for starting a new chat without opening Beaver. The run
 * it starts is reported by the run status popup in the same corner.
 *
 * The state atom itself lives in `./ui` with the other surface flags; this
 * module holds the actions on it.
 */
import { atom } from 'jotai';
import { isRunActive } from '@beaver/agent-core/agents/types';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { logger } from '@beaver/agent-core/platform/logger';
import { isWSChatPendingAtom } from './agentRunAtoms';
import { chatAccessGateAtom } from './chatAccess';
import { addItemsToCurrentMessageItemsAtom, currentReaderAttachmentAtom } from './messageComposition';
import { newThreadAtom } from './threads';
import {
    isQuickPromptOpenAtom,
    isSidebarVisibleAtom,
    isThreadListViewAtom,
    quickPromptStateAtom,
    type QuickPromptMode,
    type QuickPromptState,
} from './ui';
import { getCurrentReader } from '../utils/readerUtils';

export { isQuickPromptOpenAtom, quickPromptStateAtom };
export type { QuickPromptMode, QuickPromptState };

/** Whether the open thread has a run that a send right now would join or stop. */
export const hasActiveWorkAtom = atom(
    (get) => get(isWSChatPendingAtom) || isRunActive(get(activeRunAtom)),
);

/**
 * The annotations selected in the open reader, as message items. Only for a
 * reader whose file is the staged attachment: that atom is set by the same
 * new-thread step and only for a searchable library, so an excluded library's
 * annotations never get this far.
 */
async function selectedReaderAnnotations(attachment: Zotero.Item | null): Promise<Zotero.Item[]> {
    const reader = getCurrentReader();
    if (!reader || !attachment || reader.itemID !== attachment.id) return [];
    const keys: string[] = reader._internalReader?._state?.selectedAnnotationIDs ?? [];
    if (keys.length === 0) return [];
    const items: Zotero.Item[] = [];
    for (const key of keys) {
        const item = await Zotero.Items.getByLibraryAndKeyAsync(attachment.libraryID, key);
        if (item && item.isAnnotation()) items.push(item);
    }
    return items;
}

/**
 * An open in progress. A real keystroke can reach the shortcut twice in quick
 * succession; the second must not read the first's finished state as a popup
 * to close.
 */
let openInFlight: Promise<void> | null = null;

/**
 * Opens the quick prompt. When the account cannot start a chat, the popup says
 * why and offers to open Beaver, which shows the screen that resolves it — the
 * same gates the sidebar puts before its composer. With no run live, the open
 * thread is left the way "New chat" leaves it — cleared, with the current
 * selection or open file attached, plus the annotations selected in the
 * reader — but the draft is kept: Escape closes the popup without losing what
 * was typed, and reopening it goes through here again.
 */
export const openQuickPromptAtom = atom(null, async (get, set) => {
    if (openInFlight) return openInFlight;
    openInFlight = (async () => {
        const gate = get(chatAccessGateAtom);
        if (gate) {
            set(quickPromptStateAtom, { mode: 'blocked', reason: gate });
            return;
        }
        if (get(hasActiveWorkAtom)) {
            set(quickPromptStateAtom, { mode: 'busy' });
            return;
        }
        // The sidebar may have been left on the chat list; the send should land
        // in the thread view when Beaver is next opened.
        set(isThreadListViewAtom, false);
        // No confirmation: there is no live work to interrupt (checked above), and
        // a run that slips in meanwhile must not raise a modal from a hotkey.
        await set(newThreadAtom, { skipActiveRunConfirm: true, preserveDraft: true });
        try {
            const annotations = await selectedReaderAnnotations(get(currentReaderAttachmentAtom));
            if (annotations.length > 0) await set(addItemsToCurrentMessageItemsAtom, annotations);
        } catch (error) {
            logger(`openQuickPromptAtom: could not attach the selected annotations: ${error}`, 1);
        }
        set(quickPromptStateAtom, { mode: 'compose' });
    })().finally(() => { openInFlight = null; });
    return openInFlight;
});

export const closeQuickPromptAtom = atom(null, (_get, set) => {
    set(quickPromptStateAtom, null);
});

/** What the quick prompt shortcut did; the caller dispatches the UI events. */
export type QuickPromptToggleOutcome =
    /** The sidebar is open: the caller closes it and opens the popup in its place. */
    | 'replace-sidebar'
    | 'closed'
    /** The popup is up: the composer, or a notice saying why not. */
    | 'opened';

/**
 * The shortcut's action. The popup stands in for a closed sidebar, so with the
 * sidebar open the shortcut swaps the two: closing the sidebar is left to the
 * caller, which owns the UI event, and the popup opens in its corner.
 */
export const toggleQuickPromptAtom = atom(null, async (get, set): Promise<QuickPromptToggleOutcome> => {
    if (get(isSidebarVisibleAtom)) return 'replace-sidebar';
    if (openInFlight) {
        await openInFlight;
        return 'opened';
    }
    if (get(quickPromptStateAtom)) {
        set(closeQuickPromptAtom);
        return 'closed';
    }
    await set(openQuickPromptAtom);
    return 'opened';
});

/**
 * Leaving a chat whose response waits on a table fill.
 *
 * A fill does not outlive its response out of sight. When the window waiting
 * on it leaves the chat, or closes, a fill whose table is open (in a Beaver
 * tab, or its own window) goes on as the table's own; any other fill stops.
 * When the table is not open, leaving asks first, as for any response still
 * going, and says the fill stops too. Either way the window stops waiting,
 * and the next message closes the fill's call.
 */

import { atom, type Getter } from 'jotai';
import { logger } from '@beaver/agent-core/platform/logger';
import { currentThreadIdAtom } from '@beaver/agent-core/run-state/atoms';
import { chatFillsAtom } from '@beaver/agent-core/run-state/tableChatFills';
import type { TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { getHost } from '@beaver/agent-ui/host';
import { getTablesApi } from '../../src/services/artifacts/tablesApi';
import { store } from '../store';
import { jobWaitAtom, type JobWait } from './jobWait';

/** Whether the fill's table is open, outside `except` (a window about to close). */
function tableShown(fill: TableFillJobSnapshot, except?: Window | null): boolean {
    return getTablesApi()?.isShown(fill.table, except) ?? false;
}

/**
 * The fill a wait is on, while it runs on this device. A fill winding down
 * after Stop is left to report its stopped result.
 */
function runningFill(fills: ReadonlyMap<string, { snapshot: TableFillJobSnapshot }>, wait: JobWait): TableFillJobSnapshot | null {
    const snapshot = fills.get(wait.jobId)?.snapshot;
    return snapshot?.state === 'running' ? snapshot : null;
}

/** How the window leaves the chat, as the leave dialog names it. */
export type ChatLeave = 'new_chat' | 'switch_chat';

const LEAVE_COPY: Record<ChatLeave, { title: string; doing: string; confirmLabel: string }> = {
    new_chat: { title: 'Start new chat?', doing: 'Starting a new chat', confirmLabel: 'Start New Chat' },
    switch_chat: { title: 'Switch chat?', doing: 'Switching chats', confirmLabel: 'Switch Chat' },
};

/**
 * The fill that leaving the open chat would stop: the one this window waits
 * on, while it runs and its table is not open. Leaving then asks with
 * {@link confirmLeaveJobWaitAtom}, in place of the usual question about
 * stopping a response.
 */
export function fillLeaveStops(get: Getter): TableFillJobSnapshot | null {
    const wait = get(jobWaitAtom);
    if (!wait || wait.threadId !== get(currentThreadIdAtom)) return null;
    const fill = runningFill(get(chatFillsAtom), wait);
    return fill && !tableShown(fill) ? fill : null;
}

/**
 * Before the window leaves a chat whose response waits on a fill: unless the
 * fill's table is open, confirm leaving, as for any response still going,
 * and say that the fill stops too. Returns false when the user cancels, and
 * the window stays.
 */
export const confirmLeaveJobWaitAtom = atom(
    null,
    (get, _set, { leave, window }: { leave: ChatLeave; window?: Window | null }): boolean => {
        const fill = fillLeaveStops(get);
        if (!fill) return true;
        const copy = LEAVE_COPY[leave];
        const table = fill.table.title ? `the fill of “${fill.table.title}”` : 'its table fill';
        return getHost().dialogs?.confirm({
            title: copy.title,
            text: `Beaver is still working in this chat. ${copy.doing} will stop it, and ${table} (the answers so far stay in the table). To keep the fill going, open the table first.`,
            confirmLabel: copy.confirmLabel,
            window: window ?? undefined,
        }) ?? true;
    },
);

/**
 * The window is leaving the chat its fill wait is in, or is closing: end the
 * wait, leaving the fill to its table when the table is open (outside a
 * closing window), and stopping it otherwise. Called before the run that
 * waits live is stopped, so a fill left to its table survives that. Nothing
 * resumes the response.
 */
export function leaveJobWait(options: { closing?: Window | null } = {}): void {
    const wait = store.get(jobWaitAtom);
    if (!wait) return;
    store.set(jobWaitAtom, null);
    // A fill that ended, or is winding down after Stop, is left as it is.
    const fill = runningFill(store.get(chatFillsAtom), wait);
    if (!fill) return;
    const fills = Zotero.Beaver.tableFills;
    if (tableShown(fill, options.closing)) {
        logger(`jobLeave: leaving fill ${wait.jobId} to its open table`, 1);
        fills?.agent.release(wait.jobId);
    } else {
        logger(`jobLeave: stopping fill ${wait.jobId}`, 1);
        fills?.stop(wait.jobId);
    }
}

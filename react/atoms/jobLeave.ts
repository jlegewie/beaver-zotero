/**
 * Leaving a chat whose response waits on a table fill.
 *
 * A fill does not outlive its response out of sight. When the window waiting
 * on it leaves the chat, or closes, a fill whose table is open (in a Beaver
 * tab, or its own window) goes on as the table's own, and its call ends with
 * how far it had got; any other fill stops. When the table is not open,
 * leaving asks first, as for any response still going, and says the fill
 * stops too. Either way the response has ended, in every window.
 */

import { atom } from 'jotai';
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
 * Before the window leaves a chat whose response waits on a fill: unless the
 * fill's table is open, confirm leaving, as for any response still going,
 * and say that the fill stops too. Returns false when the user cancels, and
 * the window stays.
 */
export const confirmLeaveJobWaitAtom = atom(
    null,
    (get, _set, { leave, window }: { leave: ChatLeave; window?: Window | null }): boolean => {
        const wait = get(jobWaitAtom);
        if (!wait || wait.threadId !== get(currentThreadIdAtom)) return true;
        const fill = runningFill(get(chatFillsAtom), wait);
        if (!fill || tableShown(fill)) return true;
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
 * The window left the chat its fill wait is in, or is closing: end the wait,
 * handing the fill to its table when the table is open (outside a closing
 * window), and stopping it otherwise. Nothing resumes the response.
 */
export function leaveJobWait(options: { closing?: Window | null } = {}): void {
    const wait = store.get(jobWaitAtom);
    if (!wait) return;
    store.set(jobWaitAtom, null);
    // A fill that ended, or is winding down after Stop, stores its result as it is.
    const fill = runningFill(store.get(chatFillsAtom), wait);
    if (!fill) return;
    const how = tableShown(fill, options.closing) ? 'hand_off' : 'stop';
    logger(`jobLeave: ${how === 'hand_off' ? 'handing fill to its table' : 'stopping fill'} ${wait.jobId}`, 1);
    const jobCalls = Zotero.Beaver.jobCalls;
    if (jobCalls) void jobCalls.leave(wait.threadId, wait.toolCallId, 'table_fill', wait.jobId, how);
    else Zotero.Beaver.tableFills?.stop(wait.jobId);
}

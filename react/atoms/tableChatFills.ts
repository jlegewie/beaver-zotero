/**
 * Feeds this renderer's chat fills from the fill service's job snapshots.
 *
 * The plugin-realm fill service publishes every change of a job on the
 * instance runtime (`table-fill:changed`). The renderer records the fills a
 * chat run started; the progress panel and the `fill_table` tool call read
 * them. Subscribing hydrates from the jobs the service still keeps, so a
 * window opened mid-fill, or a sidebar opened after the fill ended, shows it.
 */

import { TABLE_FILL_CHANGED_EVENT, type TableFillJobSnapshot } from '@beaver/agent-core/protocol/tableFillProtocol';
import { activeRunAtom } from '@beaver/agent-core/run-state/atoms';
import { chatFillsAtom, recordChatFillAtom } from '@beaver/agent-core/run-state/tableChatFills';
import { logger } from '@beaver/agent-core/platform/logger';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import { openCreatedTable } from '../host/zotero/tables';
import { store } from '../store';
import { getHostWindow, tryGetWindowRuntime } from '../runtime/windowRuntime';
import { findToolCallName } from './agentRunAtoms';

let subscribed = false;

/**
 * Subscribe this renderer to job snapshots, once. The runtime revokes the
 * subscription when the window closes, together with the store it writes.
 */
export function watchChatFills(): void {
    if (subscribed) return;
    const runtime = tryGetWindowRuntime();
    if (!runtime) return;
    try {
        Zotero.Beaver.runtime.subscribeWindow(runtime, TABLE_FILL_CHANGED_EVENT, (snapshot: TableFillJobSnapshot) => {
            const seen = store.get(chatFillsAtom).has(snapshot?.job_id);
            store.set(recordChatFillAtom, snapshot);
            if (!seen) openTableForCreationFill(snapshot);
        });
        subscribed = true;
        for (const snapshot of Zotero.Beaver.tableFills?.listJobs() ?? []) store.set(recordChatFillAtom, snapshot);
    } catch (error) {
        logger(`tableChatFills: could not subscribe to fill jobs: ${String(error)}`, 1);
    }
}

/**
 * Create table with the fill ticked: switch to the new table as the fill starts.
 * Only the renderer whose run started the fill knows the tool call.
 */
function openTableForCreationFill(snapshot: TableFillJobSnapshot): void {
    const toolCall = snapshot?.origin?.run?.tool_call_id;
    if (!toolCall || snapshot.state === 'done') return;
    const run = store.get(activeRunAtom);
    if (!run || run.id !== snapshot.origin.run?.run_id || findToolCallName(run, toolCall) !== 'create_table') return;
    const ref = libraryRefForLibraryID(snapshot.table.libraryID);
    if (!ref) return;
    void openCreatedTable(`${ref}-${snapshot.table.key}`, getHostWindow(), run.id, toolCall);
}

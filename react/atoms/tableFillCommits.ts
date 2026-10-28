/**
 * Feeds a renderer's fill progress from the table store's `edit` commits.
 *
 * The store announces every commit of a fill on the instance runtime with what
 * it wrote (`TableUpdatedDetail.edit`), after the commit's render. The progress
 * panel counts rows from those announcements rather than from anything the
 * backend says, so it never runs ahead of the table.
 */

import { recordTableFillCommitAtom } from '@beaver/agent-core/run-state/tableFillProgress';
import { logger } from '@beaver/agent-core/platform/logger';
import { TABLE_UPDATED_EVENT, type TableUpdatedDetail } from '../../src/services/artifacts/tableStore';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import { store } from '../store';
import { tryGetWindowRuntime } from '../runtime/windowRuntime';

let subscribed = false;

/**
 * Subscribe this renderer to commit announcements, once. The runtime revokes
 * the subscription when the window closes, together with the store it writes.
 */
export function watchTableFillCommits(): void {
    if (subscribed) return;
    const runtime = tryGetWindowRuntime();
    if (!runtime) return;
    try {
        Zotero.Beaver.runtime.subscribeWindow(runtime, TABLE_UPDATED_EVENT, (detail: TableUpdatedDetail) => {
            if (!detail?.edit) return;
            const ref = libraryRefForLibraryID(detail.libraryID);
            if (!ref) return;
            store.set(recordTableFillCommitAtom, {
                table: `${ref}-${detail.key}`,
                run_id: detail.run_id,
                rows: detail.edit.rows,
                failed_rows: detail.edit.failed_rows,
            });
        });
        subscribed = true;
    } catch (error) {
        logger(`tableFillCommits: could not subscribe to table commits: ${String(error)}`, 1);
    }
}

import type {
    BatchOutcomeTally,
    BatchProgressEntry,
} from '@beaver/agent-core/run-state/batchProgress';
import { isBatchProgressStamp } from '@beaver/agent-core/run-state/batchProgress';
import { isToolResultView, isBatchOperationView } from '@beaver/agent-core/run-state/toolResultViews';
import type { ToolReturnPart, RetryPromptPart } from '@beaver/agent-core/agents/types';
import { resolveLibraryRef } from '../../src/utils/libraryIdentity';
import { logger } from '@beaver/agent-core/platform/logger';

/**
 * Fill in the collection names a `sort` batch's tallies are keyed by.
 *
 * `organize_items` files items by collection KEY, so the distribution the
 * backend records is keyed by key — and turning those into names needs this
 * user's library, which the backend cannot reach from the hook that stamps
 * progress after every tool call.
 *
 * So it is done here, at the boundary, on the way into run state: both the live
 * WebSocket path and the thread-load path call this before the part is stored,
 * and every surface downstream — the progress bar and the batch card in the
 * transcript — renders names without a Zotero lookup of its own. That is the
 * render-decoupling rule working as intended, and it is why the shared
 * components stay client-agnostic.
 *
 * A key that no longer resolves (a collection since deleted, a library this
 * device does not have) is left alone; the tally keeps its key and the UI shows
 * that rather than nothing. Never throws — a failure here costs a nicer label,
 * never a rendered result.
 */

/** Only `sort` tallies by collection key; every other operation labels by name. */
function needsResolution(entry: BatchProgressEntry): boolean {
    return entry.operation === 'sort';
}

function resolveRows(rows: BatchOutcomeTally[] | undefined, libraryID: number): void {
    if (!rows?.length) return;
    for (const row of rows) {
        // A row the backend already named (a collection this run created)
        // keeps that name: it was captured when the collection was made, which
        // is the name the user was shown at the time.
        if (row.display || !row.label) continue;
        try {
            const collection = Zotero.Collections.getByLibraryAndKey(libraryID, row.label);
            const name = collection ? (collection as { name?: unknown }).name : null;
            if (typeof name === 'string' && name) row.display = name;
        } catch (error) {
            logger(`batchProgressNames: could not resolve collection ${row.label}: ${error}`, 1);
        }
    }
}

/** Resolve one entry's tallies in place. */
export function resolveBatchProgressEntry(entry: BatchProgressEntry | null | undefined): void {
    if (!entry || !needsResolution(entry)) return;
    const libraryID = resolveLibraryRef({
        library_ref: entry.library_ref,
        library_id: entry.library_id,
    });
    if (libraryID == null) return;
    resolveRows(entry.tallies, libraryID);
    resolveRows(entry.removals, libraryID);
}

/**
 * Resolve every batch label a tool return carries, in place.
 *
 * Covers both places a batch entry rides: the run-level `batch_progress` stamp
 * (which the bar reads) and the `batch_start` card's own copy of it (which the
 * transcript reads). They are resolved together so the two can never show one
 * batch under two different names.
 */
export function resolveBatchProgressNames(part: ToolReturnPart | RetryPromptPart): void {
    if (part.part_kind !== 'tool-return') return;
    try {
        const metadata = part.metadata as
            | { batch_progress?: unknown; view?: unknown }
            | undefined;
        if (!metadata) return;

        const stamp = metadata.batch_progress;
        if (isBatchProgressStamp(stamp)) {
            for (const entry of stamp.batches) resolveBatchProgressEntry(entry);
        }

        const view = metadata.view;
        if (isToolResultView(view) && isBatchOperationView(view)) {
            resolveBatchProgressEntry(view.progress);
        }
    } catch (error) {
        logger(`batchProgressNames: failed to resolve batch labels: ${error}`, 1);
    }
}

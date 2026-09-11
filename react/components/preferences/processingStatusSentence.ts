import type { BackgroundProcessingStatus } from '../../atoms/backgroundProcessing';

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

export type StatusTone = 'idle' | 'busy' | 'waiting' | 'error';

export interface StatusSentence {
    tone: StatusTone;
    headline: string;
    caption: string;
    /**
     * Files with queued or running work, while a lane is busy. The row turns
     * this into progress through the current run by tracking how it moves
     * between polls.
     */
    outstanding?: number;
    /** Show Start now: queued work can start without waiting for idle. */
    processNow: boolean;
    /** Offer rebuilding missing cached text only after pending work is settled. */
    rebuildCache?: boolean;
    /** Disable Start now: a dispatcher blocker, not the idle gate. */
    processNowBlocked?: boolean;
    /** Show Stop: a Start now drain is active and can be cancelled. */
    stopDrain: boolean;
}

export interface StatusSentenceOptions {
    /** Missing cached text can be restored within the available cache space. */
    canRestoreCache?: boolean;
}

/**
 * Caption per dispatcher blocker (`BackgroundExtractor.getDispatchBlocker`).
 * The reasons differ by orders of magnitude in how long they last — a startup
 * pause clears in seconds, an unresolved library scope waits for a sign-in —
 * so each says what is actually being waited on. Unlisted reasons fall back to
 * the generic sentence below.
 */
const BLOCKER_CAPTION: Record<string, string> = {
    startup_delay: 'Beaver just started. Processing begins shortly.',
    sync_in_progress: 'Zotero is syncing.',
    hot_busy: 'Beaver is reading a file you asked for.',
    library_scope_unknown: 'Waiting for your Beaver account to load.',
    no_window: 'Waiting for the Zotero window.',
};

function blockerCaption(blocker: string): string {
    return BLOCKER_CAPTION[blocker] ?? 'Waiting for Zotero to be ready.';
}

/**
 * Reduce the status snapshot to the one sentence the status row shows.
 *
 * Four states: working (with a queue depth), waiting (with the reason), settled,
 * and unreadable. Order matters: an unreadable status wins, then running
 * work, then work queued behind the idle gate or a blocker, then unfinished
 * ledger work, then the settled summary. Files that could not be read never
 * turn the headline red; the problems list carries them, so a settled
 * headline does not imply every file succeeded.
 *
 * The dispatcher's own gate verdict (`backlogGateOpen`) decides whether queued
 * work counts as running or as waiting; no preference is read here.
 */
export function describeStatus(
    status: BackgroundProcessingStatus,
    options: StatusSentenceOptions = {},
): StatusSentence {
    if (status.updatedAt === null && !status.worker && !status.error) return {
        tone: 'waiting', headline: 'Checking status…',
        caption: 'Reading background activity.', processNow: false, stopDrain: false,
    };
    if (status.error) {
        return {
            tone: 'error',
            headline: 'Status unavailable',
            caption: 'Beaver will try again in a few seconds.',
            processNow: false,
            stopDrain: false,
        };
    }
    const inFlight = status.worker?.inFlight ?? 0;
    const blocker = status.worker?.dispatchBlocker;
    const gateOpen = !blocker && (status.worker?.backlogGateOpen ?? false);
    const runnable = status.worker?.available ?? 0;
    const draining = status.worker?.drainNow === true;
    const { total, readable, unreadable, awaitingOcr, oldestPendingAt } = status.ledger;
    const done = readable + unreadable;
    const remaining = Math.max(0, total - done);
    // Queue depth in files. The ledger counts files with no final outcome yet;
    // the queue also holds re-reads of settled files (a cache restore, a
    // changed file), which the ledger does not see, so take the larger.
    // Running jobs are still queue rows, so they are not added on top. Jobs
    // are the fallback for a snapshot without the per-file count.
    const deferred = status.worker?.deferred ?? 0;
    const queued = status.worker?.queuedFiles ?? (runnable + deferred);
    const outstanding = Math.max(remaining, queued);
    // Stop cancels the drain but never the job already running, so until that
    // job finishes the lane is busy while the gate is shut. Say so, or the
    // click looks ignored for as long as a large PDF takes to read.
    if (inFlight > 0 && !gateOpen && !draining) {
        const waitingAfter = Math.max(0, outstanding - inFlight);
        return {
            tone: 'busy',
            headline: 'Finishing current file…',
            caption: (waitingAfter > 0 ? `${plural(waitingAfter, 'file')} waiting. ` : '')
                + 'Processing continues when Zotero is idle.',
            outstanding,
            processNow: false,
            stopDrain: false,
        };
    }
    if (inFlight > 0 || (runnable > 0 && gateOpen)) {
        return {
            tone: 'busy',
            headline: 'Processing files…',
            // A job can finish between the lane read and the queue read, which
            // leaves a running lane with nothing left to count.
            caption: inFlight === 0
                ? 'Starting…'
                : outstanding > 0
                    ? `${plural(outstanding, 'file')} remaining.`
                    : 'Reading text from your files.',
            outstanding,
            processNow: false,
            stopDrain: draining,
        };
    }
    const waiting = outstanding > 0 ? `${plural(outstanding, 'file')} waiting. ` : '';
    if (runnable > 0) {
        return {
            tone: 'waiting',
            headline: 'Waiting to start',
            caption: waiting + (blocker
                ? blockerCaption(blocker)
                : 'Starts after about 30 seconds without activity in Zotero.'),
            processNow: !draining,
            processNowBlocked: Boolean(blocker),
            stopDrain: draining,
        };
    }
    const restore = options.canRestoreCache === true;
    if (deferred > 0) {
        return {
            tone: 'waiting',
            headline: 'Waiting to start',
            caption: waiting + 'Some files are processing remotely or waiting to retry.',
            processNow: false,
            stopDrain: draining,
        };
    }
    // A reconcile pass may not have queued every unfinished ledger stage yet.
    if (remaining > 0 || awaitingOcr > 0 || oldestPendingAt !== null) {
        return {
            tone: 'waiting',
            headline: 'Waiting to start',
            caption: waiting + 'Beaver picks up unfinished files automatically.',
            processNow: !draining,
            processNowBlocked: Boolean(blocker),
            stopDrain: draining,
        };
    }
    if (total === 0) {
        return {
            tone: 'idle',
            headline: 'Up to date',
            caption: 'No files to process yet. Beaver checks your libraries for new files automatically.',
            processNow: false,
            stopDrain: false,
        };
    }
    if (restore) {
        return {
            tone: 'idle',
            headline: 'Up to date',
            caption: 'Prepare previously processed files again for faster responses. Uses available cache space.',
            processNow: false,
            rebuildCache: !draining,
            stopDrain: draining,
        };
    }
    return {
        tone: 'idle',
        headline: 'Up to date',
        caption: status.issues.length > 0
            ? 'Some files need attention. See the problems below.'
            : 'Beaver processes new and changed files automatically.',
        processNow: false,
        stopDrain: false,
    };
}

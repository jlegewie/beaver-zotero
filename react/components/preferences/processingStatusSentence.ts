import type { BackgroundProcessingStatus } from '../../atoms/backgroundProcessing';

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

export type StatusTone = 'idle' | 'busy' | 'waiting' | 'error';

export interface StatusSentence {
    tone: StatusTone;
    headline: string;
    caption: string;
    /** Distinct attachments with unfinished work, including subsequent stages. */
    outstanding?: number;
    /** Show Start now: queued work can start without waiting for idle. */
    processNow: boolean;
    /** Disable Start now: a dispatcher blocker, not the idle gate. */
    processNowBlocked?: boolean;
    /** Show Stop: a Start now drain is active and can be cancelled. */
    stopDrain: boolean;
}

export interface StatusSentenceOptions {
    /**
     * The server search index answered and holds every file read so far, so a
     * settled status can promise search is current rather than just finished.
     */
    searchIndexUpToDate?: boolean;
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
};

function blockerCaption(blocker: string): string {
    return BLOCKER_CAPTION[blocker] ?? 'Waiting for Zotero to be ready.';
}

/**
 * Reduce the status snapshot to a short headline and an explanatory caption.
 *
 * Four states: working (with a queue depth), waiting (with the reason), settled,
 * and unreadable. Order matters: an unreadable status wins, then running
 * work, then work queued behind the idle gate or a blocker, then unfinished
 * ledger work, then the settled summary. Files that could not be read or indexed never
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
    const remoteWaiting = status.worker?.remoteWaiting ?? 0;
    const blocker = status.worker?.dispatchBlocker;
    const gateOpen = !blocker && (status.worker?.backlogGateOpen ?? false);
    const runnable = status.worker?.available ?? 0;
    const draining = status.worker?.drainNow === true;
    const { total, readable, unreadable, awaitingOcr, oldestPendingAt } = status.ledger;
    const done = readable + unreadable;
    const remaining = Math.max(0, total - done);
    // The service's pending set includes every required stage and queued reread.
    // Older diagnostic snapshots can lack run progress and use queue depth.
    const deferred = status.worker?.deferred ?? 0;
    const queued = status.worker?.queuedFiles ?? (runnable + deferred);
    const outstanding = status.progress?.pending ?? Math.max(remaining, queued);
    // Stop cancels the drain but never the job already running, so until that
    // job finishes the lane is busy while the gate is shut. Say so, or the
    // click looks ignored for as long as a large PDF takes to read.
    if (inFlight > 0 && !gateOpen && !draining) {
        const waitingAfter = Math.max(0, outstanding - (status.worker?.inFlightFiles ?? inFlight));
        return {
            tone: 'busy',
            headline: 'Finishing current file…',
            caption: (waitingAfter > 0 ? `${plural(waitingAfter, 'file')} waiting. ` : '')
                + 'Processing continues when your computer is idle.',
            outstanding,
            processNow: false,
            stopDrain: false,
        };
    }
    if (inFlight === 0 && remoteWaiting > 0) return {
        tone: 'waiting', headline: 'Waiting for OCR…',
        caption: `${plural(remoteWaiting, 'file')} processing remotely.`,
        outstanding, processNow: runnable > 0 && !gateOpen && !draining,
        processNowBlocked: Boolean(blocker), stopDrain: draining,
    };
    if (inFlight > 0 || (runnable > 0 && gateOpen)) {
        return {
            tone: 'busy',
            headline: 'Processing files…',
            // A job can finish between the lane read and the queue read, which
            // leaves a running lane with nothing left to count.
            caption: inFlight === 0
                ? 'Starting…'
                : outstanding > 0
                    ? `${plural(outstanding, 'file')} remaining`
                    : 'Reading text from your files.',
            outstanding,
            processNow: false,
            stopDrain: draining,
        };
    }
    if (status.progress?.discovering) return {
        tone: 'busy', headline: 'Checking for additional files…',
        caption: 'Beaver is checking your libraries for files to process.',
        processNow: false, stopDrain: draining,
    };
    const waiting = outstanding > 0 ? `${plural(outstanding, 'file')} waiting` : 'Waiting to start';
    if (runnable > 0) {
        return {
            tone: 'waiting',
            headline: waiting,
            caption: blocker
                ? blockerCaption(blocker)
                : 'Starts after about 30 seconds without keyboard or mouse activity on your computer.',
            processNow: !draining,
            processNowBlocked: Boolean(blocker),
            stopDrain: draining,
        };
    }
    const settled = options.searchIndexUpToDate === true ? 'Full-text search is up to date' : 'Processing finished';
    if (deferred > 0) {
        return {
            tone: 'waiting',
            headline: waiting,
            caption: 'Some files are processing remotely or waiting to retry.',
            processNow: false,
            stopDrain: draining,
        };
    }
    // A reconcile pass may not have queued every unfinished ledger stage yet.
    if (status.progress ? outstanding > 0 : remaining > 0 || awaitingOcr > 0 || oldestPendingAt !== null) {
        return {
            tone: 'waiting',
            headline: waiting,
            caption: 'Beaver picks up unfinished files automatically.',
            processNow: !draining,
            processNowBlocked: Boolean(blocker),
            stopDrain: draining,
        };
    }
    if (total === 0) {
        return {
            tone: 'idle',
            headline: settled,
            caption: 'No files to process yet. Beaver checks your libraries for new files automatically.',
            processNow: false,
            stopDrain: false,
        };
    }
    return {
        tone: 'idle',
        headline: settled,
        caption: 'Beaver processes new and changed files automatically.',
        processNow: false,
        stopDrain: false,
    };
}

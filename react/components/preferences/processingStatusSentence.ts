import type { BackgroundProcessingStatus } from '../../atoms/backgroundProcessing';

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

export type StatusTone = 'idle' | 'busy' | 'waiting' | 'error';

export interface StatusProgress {
    /** Attachments that reached a terminal state (readable or not). */
    done: number;
    /** Attachments the ledger tracks in the processed libraries. */
    total: number;
}

export interface StatusSentence {
    tone: StatusTone;
    headline: string;
    caption: string;
    /** Progress toward a settled ledger while files are being processed. */
    progress?: StatusProgress;
    /** Show Process now: queued work can start without waiting for idle. */
    processNow: boolean;
    /** Disable Process now: a dispatcher blocker, not the idle gate. */
    processNowBlocked?: boolean;
    /** Show Stop: a Process now drain is active and can be cancelled. */
    stopDrain: boolean;
}

export interface StatusSentenceOptions {
    /**
     * Offer Process now when processed files have lost their cached text and
     * the cache has room to restore it, even while nothing is queued yet: the
     * restore has no other entry point.
     */
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
 * Four states: working (with progress), waiting (with the reason), settled,
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
    if (inFlight > 0 || (runnable > 0 && gateOpen)) {
        return {
            tone: 'busy',
            headline: 'Processing files…',
            caption: inFlight === 0
                ? 'Starting…'
                : remaining > 0
                    ? `${plural(remaining, 'file')} remaining.`
                    : 'Reading text from your files.',
            progress: total > 0 && remaining > 0 ? { done, total } : undefined,
            processNow: false,
            stopDrain: draining,
        };
    }
    if (runnable > 0) {
        return {
            tone: 'waiting',
            headline: 'Waiting to start',
            caption: blocker
                ? blockerCaption(blocker)
                : 'Starts after about 30 seconds without activity in Zotero.',
            processNow: !draining,
            processNowBlocked: Boolean(blocker),
            stopDrain: draining,
        };
    }
    const restore = options.canRestoreCache === true;
    const deferred = status.worker?.deferred ?? 0;
    if (deferred > 0) {
        return {
            tone: 'waiting',
            headline: 'Waiting to start',
            caption: 'Some files are processing remotely or waiting to retry.',
            processNow: restore && !draining,
            stopDrain: draining,
        };
    }
    // A reconcile pass may not have queued every unfinished ledger stage yet.
    if (remaining > 0 || awaitingOcr > 0 || oldestPendingAt !== null) {
        return {
            tone: 'waiting',
            headline: 'Waiting to start',
            caption: 'Beaver picks up unfinished files automatically.',
            processNow: restore && !draining,
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
            caption: 'Cached text for some files was removed to save space. Process now restores it.',
            processNow: true,
            stopDrain: false,
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

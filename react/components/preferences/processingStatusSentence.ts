import type { BackgroundProcessingStatus } from '../../atoms/backgroundProcessing';

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

export type StatusTone = 'idle' | 'busy' | 'waiting' | 'error';

interface StatusSentence {
    tone: StatusTone;
    headline: string;
    caption: string;
    /** Show Process now: queued work can start without waiting for idle. */
    processNow: boolean;
    /** Disable Process now: a dispatcher blocker, not the idle gate. */
    processNowBlocked?: boolean;
    /** Show Stop: a Process now drain is active and can be cancelled. */
    stopDrain: boolean;
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
 * Order matters: an unreadable status wins, then running work, then work
 * queued behind the idle gate, then the settled summary. Reading and indexing
 * problems have their own sections; idle does not imply every file succeeded.
 */
export function describeStatus(
    status: BackgroundProcessingStatus,
    continuous: boolean,
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
    // The dispatcher's own verdict; the continuous pref is the fallback for a
    // snapshot taken before the worker reported.
    const blocker = status.worker?.dispatchBlocker;
    const gateOpen = !blocker && (status.worker?.backlogGateOpen ?? continuous);
    const runnable = status.worker?.available ?? 0;
    // Process now is the idle-gate bypass. Continuous already keeps that gate
    // open, so neither the bypass nor its Stop control belongs there.
    const draining = !continuous && status.worker?.drainNow === true;
    if (inFlight > 0 || (runnable > 0 && gateOpen)) {
        return {
            tone: 'busy',
            headline: 'Processing files…',
            caption: inFlight > 0
                ? 'Reading text from your files.'
                : 'Starting…',
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
            processNow: !continuous && !draining,
            processNowBlocked: Boolean(blocker),
            stopDrain: draining,
        };
    }
    const deferred = status.worker?.deferred ?? 0;
    if (deferred > 0) {
        return {
            tone: 'waiting',
            headline: 'Finishing in the background',
            caption: 'Some files are processing remotely or waiting to retry.',
            processNow: false,
            stopDrain: draining,
        };
    }
    const { total, readable, unreadable, awaitingOcr, oldestPendingAt } = status.ledger;
    // A reconcile pass may not have queued every unfinished ledger stage yet.
    if (total > readable + unreadable || awaitingOcr > 0 || oldestPendingAt !== null) {
        return {
            tone: 'waiting',
            headline: 'Files waiting to be processed',
            caption: 'Beaver picks up unfinished work automatically.',
            processNow: false,
            stopDrain: false,
        };
    }
    if (status.ledger.total === 0) {
        return {
            tone: 'idle',
            headline: 'Nothing to process yet',
            caption: 'Beaver checks your libraries for new files automatically.',
            processNow: false,
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

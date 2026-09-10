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
        tone: 'waiting', headline: 'Checking background activity…',
        caption: 'Reading the current processing status.', processNow: false, stopDrain: false,
    };
    if (status.error) {
        return {
            tone: 'error',
            headline: 'Could not read the processing status',
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
                ? 'Preparing document text and updating enabled services.'
                : 'Starting…',
            processNow: false,
            stopDrain: draining,
        };
    }
    if (runnable > 0) {
        return {
            tone: 'waiting',
            headline: 'Background processing is waiting',
            caption: blocker
                ? 'Processing is waiting for Zotero to be ready.'
                : 'Processing starts once Zotero has been idle for a moment.',
            processNow: !continuous && !draining,
            processNowBlocked: Boolean(blocker),
            stopDrain: draining,
        };
    }
    const deferred = status.worker?.deferred ?? 0;
    if (deferred > 0) {
        return {
            tone: 'waiting',
            headline: 'Waiting for processing to finish',
            caption: 'Waiting for remote processing or a scheduled retry.',
            processNow: false,
            stopDrain: draining,
        };
    }
    const { total, readable, unreadable, awaitingOcr, oldestPendingAt } = status.ledger;
    // A reconcile pass may not have queued every unfinished ledger stage yet.
    if (total > readable + unreadable || awaitingOcr > 0 || oldestPendingAt !== null) {
        return {
            tone: 'waiting',
            headline: 'Files are waiting to be processed',
            caption: 'Beaver checks for unfinished work automatically.',
            processNow: false,
            stopDrain: false,
        };
    }
    if (status.ledger.total === 0) {
        return {
            tone: 'idle',
            headline: 'No attachments to process yet',
            caption: 'Beaver checks your libraries for new files automatically.',
            processNow: false,
            stopDrain: false,
        };
    }
    return {
        tone: 'idle',
        headline: 'Background processing is idle',
        caption: status.issues.length > 0
            ? 'Some attachments need attention. See the problems below.'
            : 'Beaver checks for new and changed files automatically.',
        processNow: false,
        stopDrain: false,
    };
}

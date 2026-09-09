import type { BackgroundProcessingStatus } from '../../atoms/backgroundProcessing';

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

export type StatusTone = 'idle' | 'busy' | 'waiting' | 'error';

interface StatusSentence {
    tone: StatusTone;
    headline: string;
    /** Second line; `processNow` appends the reconciliation and immediate-drain action. */
    caption: string;
    processNow: boolean;
}

/**
 * Reduce the status snapshot to the one sentence the status row shows.
 *
 * Order matters: an unreadable status wins, then running work, then work
 * queued behind the idle gate, then the settled summary. Unavailable files
 * retain a manual recheck once queued work has finished.
 */
export function describeStatus(
    status: BackgroundProcessingStatus,
    continuous: boolean,
): StatusSentence {
    const attachments = plural(status.ledger.total, 'attachment');
    if (status.error) {
        return {
            tone: 'error',
            headline: 'Could not read the processing status',
            caption: 'Beaver will try again in a few seconds.',
            processNow: false,
        };
    }
    const inFlight = status.worker?.inFlight ?? 0;
    // The dispatcher's own verdict; the continuous pref is the fallback for a
    // snapshot taken before the worker reported.
    const blocker = status.worker?.dispatchBlocker;
    const gateOpen = !blocker && (status.worker?.backlogGateOpen ?? continuous);
    const runnable = status.worker?.available ?? 0;
    if (inFlight > 0 || (runnable > 0 && gateOpen)) {
        const remaining = Math.max(inFlight + runnable, 1);
        return {
            tone: 'busy',
            headline: `Processing ${plural(remaining, 'file')}…`,
            caption: inFlight > 0
                ? `${plural(inFlight, 'file')} running · ${plural(runnable, 'file')} queued`
                : 'Starting…',
            processNow: false,
        };
    }
    if (runnable > 0) {
        return {
            tone: 'waiting',
            headline: `${plural(runnable, 'file')} waiting`,
            caption: blocker
                ? 'Processing is waiting for Zotero to be ready.'
                : 'Processing starts once Zotero has been idle for a moment.',
            processNow: !blocker,
        };
    }
    const deferred = status.worker?.deferred ?? 0;
    if (deferred > 0) {
        return {
            tone: 'waiting',
            headline: `${plural(deferred, 'file')} waiting to finish`,
            caption: 'Waiting for remote processing or a scheduled retry.',
            processNow: false,
        };
    }
    const { total, readable, unreadable, awaitingOcr, oldestPendingAt } = status.ledger;
    if (unreadable > 0 || status.issues.some((group) => group.count > 0)) {
        const hasUnavailableFiles = status.issues.some((group) => group.reason === 'file_unavailable' && group.count > 0);
        return {
            tone: 'error',
            headline: 'Some files could not be processed',
            caption: hasUnavailableFiles
                ? 'After restoring access to unavailable files, process now to check them again.'
                : 'Some attachments need attention before processing can finish.',
            processNow: hasUnavailableFiles && !blocker,
        };
    }
    // A reconcile pass may not have queued every unfinished ledger stage yet.
    if (total > readable + unreadable || awaitingOcr > 0 || oldestPendingAt !== null) {
        return {
            tone: 'waiting',
            headline: 'Files are waiting to be processed',
            caption: 'Beaver checks for unfinished work automatically.',
            processNow: false,
        };
    }
    if (status.ledger.total === 0) {
        return {
            tone: 'idle',
            headline: 'No attachments to process yet',
            caption: 'Beaver checks your libraries for new files automatically.',
            processNow: false,
        };
    }
    return {
        tone: 'idle',
        headline: 'All files are processed',
        caption: attachments,
        processNow: false,
    };
}

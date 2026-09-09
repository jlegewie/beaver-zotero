import type { BackgroundProcessingStatus } from '../../atoms/backgroundProcessing';

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

export type StatusTone = 'idle' | 'busy' | 'waiting' | 'error';

interface StatusSentence {
    tone: StatusTone;
    headline: string;
    /** Second line; `processNow` appends the one-off idle-bypass link. */
    caption: string;
    processNow: boolean;
}

/**
 * Reduce the status snapshot to the one sentence the status row shows.
 *
 * Order matters: an unreadable status wins, then running work, then work
 * queued behind the idle gate (the only state that offers "process now"),
 * then the settled summary.
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
    const gateOpen = status.worker?.backlogGateOpen ?? continuous;
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
            caption: 'Processing starts once Zotero has been idle for a moment.',
            processNow: true,
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

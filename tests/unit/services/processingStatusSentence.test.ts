import { describe, expect, it } from 'vitest';
import { backgroundProcessingStatusAtom } from '../../../react/atoms/backgroundProcessing';
import { describeStatus } from '../../../react/components/preferences/processingStatusSentence';

function status(deferred: number, total = 1) {
    return {
        ...backgroundProcessingStatusAtom.init,
        ledger: { ...backgroundProcessingStatusAtom.init.ledger, total, readable: total },
        worker: { available: 0, deferred, inFlight: 0, backlogGateOpen: true, drainNow: false, dispatchBlocker: null as string | null },
    };
}

describe('processing status sentence', () => {
    it.each([false, true])('settles without a red headline or Process now when only unavailable files remain (continuous %s)', (continuous) => {
        const snapshot = status(0);
        snapshot.ledger.readable = 0;
        snapshot.ledger.unreadable = 1;
        snapshot.issues = [{ reason: 'file_unavailable', count: 1 }];
        expect(describeStatus(snapshot, continuous)).toMatchObject({
            tone: 'idle', headline: 'Up to date', processNow: false,
        });
    });

    it('shows dispatcher-blocked work as waiting with Process now disabled', () => {
        const snapshot = status(0);
        snapshot.worker.available = 4;
        snapshot.worker.dispatchBlocker = 'sync_in_progress';
        expect(describeStatus(snapshot, false)).toMatchObject({
            tone: 'waiting', processNow: true, processNowBlocked: true, stopDrain: false,
        });
    });

    it('hides Process now and Stop while continuous processing is on', () => {
        const snapshot = status(0);
        snapshot.worker.available = 4;
        snapshot.worker.dispatchBlocker = 'sync_in_progress';
        snapshot.worker.drainNow = true;
        expect(describeStatus(snapshot, true)).toMatchObject({
            tone: 'waiting', processNow: false, stopDrain: false,
        });
        snapshot.worker.dispatchBlocker = null;
        snapshot.worker.inFlight = 1;
        snapshot.worker.backlogGateOpen = true;
        expect(describeStatus(snapshot, true)).toMatchObject({
            tone: 'busy', processNow: false, stopDrain: false,
        });
    });

    it('offers Stop during a Process now drain and not Process now', () => {
        const snapshot = status(0);
        snapshot.worker.available = 3;
        snapshot.worker.inFlight = 1;
        snapshot.worker.drainNow = true;
        snapshot.worker.backlogGateOpen = true;
        expect(describeStatus(snapshot, false)).toMatchObject({
            tone: 'busy', processNow: false, stopDrain: true,
        });
    });
    it.each(['failed', 'skipped'] as const)('treats a terminal %s extraction as settled, leaving it to the legend and issue list', (outcome) => {
        const snapshot = status(0);
        snapshot.ledger.readable = 0;
        snapshot.ledger.unreadable = 1;
        snapshot.ledger[outcome] = 1;
        expect(describeStatus(snapshot, false)).toMatchObject({
            tone: 'idle', headline: 'Up to date', processNow: false,
        });
    });

    it('keeps the settled headline for readable files with unresolved index issues', () => {
        const snapshot = status(0);
        snapshot.issues = [{ reason: 'index_failed', count: 1 }];
        expect(describeStatus(snapshot, false)).toMatchObject({ tone: 'idle', headline: 'Up to date' });
    });

    it.each(['extraction', 'ocr', 'index'])('reports unfinished %s ledger work without a queued job as waiting', (stage) => {
        const snapshot = status(0);
        if (stage === 'index') snapshot.ledger.oldestPendingAt = '2026-09-09 00:00:00';
        else snapshot.ledger.readable = 0;
        if (stage === 'ocr') snapshot.ledger.awaitingOcr = 1;
        expect(describeStatus(snapshot, true)).toMatchObject({
            tone: 'waiting', headline: 'Files waiting to be processed', processNow: false,
        });
    });

    it('preserves the empty-library state when there are no issues or pending stages', () => {
        expect(describeStatus(status(0, 0), false).headline).toBe('Nothing to process yet');
    });

    it.each([false, true])('shows parked work as waiting with immediate drain %s', (drainNow) => {
        const snapshot = status(3);
        snapshot.worker.drainNow = drainNow;
        expect(describeStatus(snapshot, false)).toMatchObject({
            tone: 'waiting', headline: 'Finishing in the background', processNow: false, stopDrain: drainNow,
        });
    });

    it('shows delayed retries as waiting even before a ledger row exists', () => {
        expect(describeStatus(status(1, 0), true)).toMatchObject({
            tone: 'waiting', headline: 'Finishing in the background', processNow: false,
        });
    });

    it('reports completion only after deferred work finishes', () => {
        expect(describeStatus(status(0), false)).toMatchObject({
            tone: 'idle', headline: 'Up to date',
        });
    });

    it.each([
        ['startup_delay', 'Beaver just started. Processing begins shortly.'],
        ['sync_in_progress', 'Zotero is syncing.'],
        ['library_scope_unknown', 'Waiting for your Beaver account to load.'],
        ['not_a_known_reason', 'Waiting for Zotero to be ready.'],
    ])('names the %s blocker in the caption', (blocker, caption) => {
        const snapshot = status(0);
        snapshot.worker.available = 2;
        snapshot.worker.dispatchBlocker = blocker;
        expect(describeStatus(snapshot, false)).toMatchObject({ headline: 'Waiting to start', caption });
    });

    it('explains the idle gate rather than a blocker when nothing blocks dispatch', () => {
        const snapshot = status(0);
        snapshot.worker.available = 2;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot, false)).toMatchObject({
            headline: 'Waiting to start',
            caption: 'Starts after about 30 seconds without activity in Zotero.',
            processNowBlocked: false,
        });
    });

    it('keeps running work ahead of deferred work', () => {
        const snapshot = status(3);
        snapshot.worker.inFlight = 1;
        expect(describeStatus(snapshot, false).tone).toBe('busy');
    });
});

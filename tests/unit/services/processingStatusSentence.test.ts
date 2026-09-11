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
    it('settles without a red headline or Process now when only unavailable files remain', () => {
        const snapshot = status(0);
        snapshot.ledger.readable = 0;
        snapshot.ledger.unreadable = 1;
        snapshot.issues = [{ reason: 'file_unavailable', count: 1 }];
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'idle', headline: 'Up to date', processNow: false,
        });
    });

    it('shows dispatcher-blocked work as waiting with Process now disabled', () => {
        const snapshot = status(0);
        snapshot.worker.available = 4;
        snapshot.worker.dispatchBlocker = 'sync_in_progress';
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'waiting', processNow: true, processNowBlocked: true, stopDrain: false,
        });
    });

    it('offers neither Process now nor Stop while the dispatcher keeps the gate open on its own', () => {
        const snapshot = status(0);
        snapshot.worker.available = 4;
        snapshot.worker.inFlight = 1;
        snapshot.worker.backlogGateOpen = true;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'busy', processNow: false, stopDrain: false,
        });
    });

    it('offers Stop during a Process now drain and not Process now', () => {
        const snapshot = status(0);
        snapshot.worker.available = 3;
        snapshot.worker.inFlight = 1;
        snapshot.worker.drainNow = true;
        snapshot.worker.backlogGateOpen = true;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'busy', processNow: false, stopDrain: true,
        });
    });

    it('reports remaining files and progress while working through a tracked backlog', () => {
        const snapshot = status(0, 10);
        snapshot.ledger.readable = 6;
        snapshot.ledger.unreadable = 1;
        snapshot.worker.inFlight = 1;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'busy', headline: 'Processing files…', caption: '3 files remaining.',
            progress: { done: 7, total: 10 },
        });
    });

    it('omits progress when the running work is not tracked by the ledger', () => {
        const snapshot = status(0, 0);
        snapshot.worker.inFlight = 1;
        const sentence = describeStatus(snapshot);
        expect(sentence).toMatchObject({ tone: 'busy', caption: 'Reading text from your files.' });
        expect(sentence.progress).toBeUndefined();
    });

    it.each(['failed', 'skipped'] as const)('treats a terminal %s extraction as settled, leaving it to the issue list', (outcome) => {
        const snapshot = status(0);
        snapshot.ledger.readable = 0;
        snapshot.ledger.unreadable = 1;
        snapshot.ledger[outcome] = 1;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'idle', headline: 'Up to date', processNow: false,
        });
    });

    it('keeps the settled headline for readable files with unresolved index issues', () => {
        const snapshot = status(0);
        snapshot.issues = [{ reason: 'index_failed', count: 1 }];
        expect(describeStatus(snapshot)).toMatchObject({ tone: 'idle', headline: 'Up to date' });
    });

    it.each(['extraction', 'ocr', 'index'])('reports unfinished %s ledger work without a queued job as waiting', (stage) => {
        const snapshot = status(0);
        if (stage === 'index') snapshot.ledger.oldestPendingAt = '2026-09-09 00:00:00';
        else snapshot.ledger.readable = 0;
        if (stage === 'ocr') snapshot.ledger.awaitingOcr = 1;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'waiting', headline: 'Waiting to start', processNow: false,
        });
    });

    it('folds the empty-library state into the settled caption', () => {
        expect(describeStatus(status(0, 0))).toMatchObject({
            tone: 'idle', headline: 'Up to date', caption: 'No files to process yet. Beaver checks your libraries for new files automatically.',
        });
    });

    it.each([false, true])('shows parked work as waiting with immediate drain %s', (drainNow) => {
        const snapshot = status(3);
        snapshot.worker.drainNow = drainNow;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'waiting', headline: 'Waiting to start', processNow: false, stopDrain: drainNow,
        });
    });

    it('shows delayed retries as waiting even before a ledger row exists', () => {
        expect(describeStatus(status(1, 0))).toMatchObject({
            tone: 'waiting', headline: 'Waiting to start', processNow: false,
        });
    });

    it('reports completion only after deferred work finishes', () => {
        expect(describeStatus(status(0))).toMatchObject({
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
        expect(describeStatus(snapshot)).toMatchObject({ headline: 'Waiting to start', caption });
    });

    it('explains the idle gate rather than a blocker when nothing blocks dispatch', () => {
        const snapshot = status(0);
        snapshot.worker.available = 2;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot)).toMatchObject({
            headline: 'Waiting to start',
            caption: 'Starts after about 30 seconds without activity in Zotero.',
            processNowBlocked: false,
        });
    });

    it('keeps running work ahead of deferred work', () => {
        const snapshot = status(3);
        snapshot.worker.inFlight = 1;
        expect(describeStatus(snapshot).tone).toBe('busy');
    });

    it('offers Process now on a settled status only to restore evicted cached text', () => {
        const snapshot = status(0);
        const sentence = describeStatus(snapshot, { canRestoreCache: true });
        expect(sentence).toMatchObject({ tone: 'idle', headline: 'Up to date', processNow: true });
        expect(sentence.processNowBlocked).toBeFalsy();
        expect(describeStatus(snapshot, { canRestoreCache: false }).processNow).toBe(false);
    });

    it('keeps a cache restoration reachable while work is deferred or not yet queued', () => {
        const deferred = status(2);
        expect(describeStatus(deferred).processNow).toBe(false);
        expect(describeStatus(deferred, { canRestoreCache: true })).toMatchObject({ headline: 'Waiting to start', processNow: true });
        deferred.worker.drainNow = true;
        expect(describeStatus(deferred, { canRestoreCache: true })).toMatchObject({ processNow: false, stopDrain: true });
        const unfinished = status(0);
        unfinished.ledger.oldestPendingAt = '2026-09-09 00:00:00';
        expect(describeStatus(unfinished).processNow).toBe(false);
        expect(describeStatus(unfinished, { canRestoreCache: true })).toMatchObject({ headline: 'Waiting to start', processNow: true });
        unfinished.worker.drainNow = true;
        expect(describeStatus(unfinished, { canRestoreCache: true })).toMatchObject({ processNow: false, stopDrain: true });
    });

    it('does not let cache restoration outrank queued or running work', () => {
        const snapshot = status(0);
        snapshot.worker.available = 2;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot, { canRestoreCache: true })).toMatchObject({
            headline: 'Waiting to start', processNow: true,
        });
        snapshot.worker.inFlight = 1;
        expect(describeStatus(snapshot, { canRestoreCache: true })).toMatchObject({
            tone: 'busy', processNow: false, stopDrain: false,
        });
        snapshot.worker.drainNow = true;
        expect(describeStatus(snapshot, { canRestoreCache: true })).toMatchObject({
            tone: 'busy', processNow: false, stopDrain: true,
        });
    });
});

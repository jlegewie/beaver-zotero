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
    it('settles without a red headline or Start now when only unavailable files remain', () => {
        const snapshot = status(0);
        snapshot.ledger.readable = 0;
        snapshot.ledger.unreadable = 1;
        snapshot.issues = [{ reason: 'file_unavailable', count: 1 }];
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'idle', headline: 'Up to date', processNow: false,
        });
    });

    it('shows dispatcher-blocked work as waiting with Start now disabled', () => {
        const snapshot = status(0);
        snapshot.worker.available = 4;
        snapshot.worker.dispatchBlocker = 'sync_in_progress';
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'waiting', processNow: true, processNowBlocked: true, stopDrain: false,
        });
    });

    it('offers neither Start now nor Stop while the dispatcher keeps the gate open on its own', () => {
        const snapshot = status(0);
        snapshot.worker.available = 4;
        snapshot.worker.inFlight = 1;
        snapshot.worker.backlogGateOpen = true;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'busy', processNow: false, stopDrain: false,
        });
    });

    it('reports the running file as finishing once the gate is shut, immediately after Stop', () => {
        const snapshot = status(0, 10);
        snapshot.ledger.readable = 4;
        snapshot.worker.inFlight = 1;
        snapshot.worker.available = 5;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'busy',
            headline: 'Finishing current file…',
            caption: '5 files waiting. Processing continues when Zotero is idle.',
            outstanding: 6,
            processNow: false,
            stopDrain: false,
        });
        // While the drain is still on, the same lane state is ordinary processing with Stop.
        snapshot.worker.drainNow = true;
        snapshot.worker.backlogGateOpen = true;
        expect(describeStatus(snapshot)).toMatchObject({ headline: 'Processing files…', stopDrain: true });
    });

    it('offers Stop during a Start now drain and not Start now', () => {
        const snapshot = status(0);
        snapshot.worker.available = 3;
        snapshot.worker.inFlight = 1;
        snapshot.worker.drainNow = true;
        snapshot.worker.backlogGateOpen = true;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'busy', processNow: false, stopDrain: true,
        });
    });

    it('reports remaining files while working through a tracked backlog', () => {
        const snapshot = status(0, 10);
        snapshot.ledger.readable = 6;
        snapshot.ledger.unreadable = 1;
        snapshot.worker.inFlight = 1;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'busy', headline: 'Processing files…', caption: '3 files remaining.', outstanding: 3,
        });
    });

    it('counts queued re-reads of settled files, running ones included once', () => {
        // A claimed job is still a queue row (deferred until its visibility
        // timeout), so inFlight is not added on top of the queue depth.
        const snapshot = status(1, 0);
        snapshot.worker.inFlight = 1;
        snapshot.worker.available = 4;
        expect(describeStatus(snapshot)).toMatchObject({ tone: 'busy', caption: '5 files remaining.', outstanding: 5 });
    });

    it('exposes no queue depth outside the busy states', () => {
        expect(describeStatus(status(0)).outstanding).toBeUndefined();
        const waiting = status(0);
        waiting.worker.available = 2;
        waiting.worker.backlogGateOpen = false;
        expect(describeStatus(waiting).outstanding).toBeUndefined();
    });

    it('never reports zero files remaining while a lane is still running', () => {
        const snapshot = status(0, 0);
        snapshot.worker.inFlight = 1;
        snapshot.worker.queuedFiles = 0;
        expect(describeStatus(snapshot)).toMatchObject({ tone: 'busy', caption: 'Reading text from your files.' });
    });

    it('prefers the per-file queue depth over job counts when the snapshot carries it', () => {
        // An upsert parked behind the extraction that refills its cache: two jobs, one file.
        const snapshot = status(1, 0);
        snapshot.worker.inFlight = 1;
        snapshot.worker.available = 1;
        snapshot.worker.queuedFiles = 1;
        expect(describeStatus(snapshot).caption).toBe('1 file remaining.');
        snapshot.worker.inFlight = 0;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot).caption).toBe('1 file waiting. Starts after about 30 seconds without activity in Zotero.');
    });

    it('counts every file with queued work, read or not', () => {
        // Search-entitled accounts queue an index upload for each file as soon
        // as it is read, so read files routinely outnumber settled ones.
        const snapshot = status(0, 10);
        snapshot.ledger.readable = 6;
        snapshot.worker.inFlight = 1;
        snapshot.worker.available = 7;
        snapshot.worker.queuedFiles = 8;
        expect(describeStatus(snapshot)).toMatchObject({ tone: 'busy', caption: '8 files remaining.', outstanding: 8 });
        // An index backfill of already-read files counts the same way.
        snapshot.ledger.readable = 10;
        expect(describeStatus(snapshot)).toMatchObject({ caption: '8 files remaining.', outstanding: 8 });
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
            tone: 'waiting', headline: 'Waiting to start', processNow: true,
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
        expect(describeStatus(snapshot)).toMatchObject({ headline: 'Waiting to start', caption: `2 files waiting. ${caption}` });
    });

    it('explains the idle gate rather than a blocker when nothing blocks dispatch', () => {
        const snapshot = status(0);
        snapshot.worker.available = 2;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot)).toMatchObject({
            headline: 'Waiting to start',
            caption: '2 files waiting. Starts after about 30 seconds without activity in Zotero.',
            processNowBlocked: false,
        });
    });

    it('names how many files are waiting in every waiting caption', () => {
        const gated = status(0, 5);
        gated.ledger.readable = 2;
        gated.worker.available = 3;
        gated.worker.backlogGateOpen = false;
        expect(describeStatus(gated).caption).toBe('3 files waiting. Starts after about 30 seconds without activity in Zotero.');
        gated.worker.dispatchBlocker = 'sync_in_progress';
        expect(describeStatus(gated).caption).toBe('3 files waiting. Zotero is syncing.');
        // Two deferred jobs outnumber the one ledger file still open, so the queue wins.
        const deferred = status(2, 4);
        deferred.ledger.readable = 3;
        expect(describeStatus(deferred).caption).toBe('2 files waiting. Some files are processing remotely or waiting to retry.');
        deferred.worker.deferred = 1;
        expect(describeStatus(deferred).caption).toBe('1 file waiting. Some files are processing remotely or waiting to retry.');
        const unfinished = status(0, 2);
        unfinished.ledger.readable = 0;
        expect(describeStatus(unfinished).caption).toBe('2 files waiting. Beaver picks up unfinished files automatically.');
        // Re-reads of settled files are queued jobs the ledger does not count.
        const untracked = status(0);
        untracked.worker.available = 279;
        untracked.worker.backlogGateOpen = false;
        expect(describeStatus(untracked).caption).toBe('279 files waiting. Starts after about 30 seconds without activity in Zotero.');
    });

    it('keeps running work ahead of deferred work', () => {
        const snapshot = status(3);
        snapshot.worker.inFlight = 1;
        expect(describeStatus(snapshot).tone).toBe('busy');
    });

    it('offers Rebuild cache only on a settled status with missing cached text', () => {
        const snapshot = status(0);
        const sentence = describeStatus(snapshot, { canRestoreCache: true });
        expect(sentence).toMatchObject({ tone: 'idle', headline: 'Up to date', processNow: false, rebuildCache: true });
        expect(sentence.processNowBlocked).toBeFalsy();
        expect(describeStatus(snapshot, { canRestoreCache: false }).processNow).toBe(false);
    });

    it('keeps cache rebuilding unavailable while work is deferred or not yet queued', () => {
        const deferred = status(2);
        expect(describeStatus(deferred).processNow).toBe(false);
        expect(describeStatus(deferred, { canRestoreCache: true })).toMatchObject({ headline: 'Waiting to start', processNow: false });
        expect(describeStatus(deferred, { canRestoreCache: true }).rebuildCache).toBeFalsy();
        deferred.worker.drainNow = true;
        expect(describeStatus(deferred, { canRestoreCache: true })).toMatchObject({ processNow: false, stopDrain: true });
        const unfinished = status(0);
        unfinished.ledger.oldestPendingAt = '2026-09-09 00:00:00';
        expect(describeStatus(unfinished).processNow).toBe(true);
        expect(describeStatus(unfinished, { canRestoreCache: true }).rebuildCache).toBeFalsy();
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
            tone: 'busy', headline: 'Finishing current file…', processNow: false, stopDrain: false,
        });
        snapshot.worker.drainNow = true;
        snapshot.worker.backlogGateOpen = true;
        expect(describeStatus(snapshot, { canRestoreCache: true })).toMatchObject({
            tone: 'busy', headline: 'Processing files…', processNow: false, stopDrain: true,
        });
    });
});

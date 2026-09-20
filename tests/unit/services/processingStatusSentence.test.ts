import { describe, expect, it } from 'vitest';
import { backgroundProcessingStatusAtom, type BackgroundProcessingStatus } from '../../../react/atoms/backgroundProcessing';
import { describeStatus } from '../../../react/components/preferences/processingStatusSentence';

function status(deferred: number, total = 1): BackgroundProcessingStatus & { worker: NonNullable<BackgroundProcessingStatus['worker']> } {
    return {
        ...backgroundProcessingStatusAtom.init,
        ledger: { ...backgroundProcessingStatusAtom.init.ledger, total, readable: total },
        worker: { available: 0, deferred, inFlight: 0, backlogGateOpen: true, drainNow: false, dispatchBlocker: null as string | null },
    };
}

describe('processing status sentence', () => {
    it('keeps settled activity neutral even with indexing failures, and active retries waiting', () => {
        const snapshot = status(0);
        snapshot.issues = [{ reason: 'index_failed', count: 1 }];
        expect(describeStatus(snapshot)).toMatchObject({ headline: 'Processing finished', tone: 'idle', processNow: false });
        snapshot.worker.deferred = 1;
        expect(describeStatus(snapshot).tone).toBe('waiting');
        snapshot.worker.deferred = 0;
        snapshot.issues = [];
        expect(describeStatus(snapshot).headline).toBe('Processing finished');
    });

    it('reports remote OCR while local occupancy is zero, even with runnable work', () => {
        const snapshot = status(3);
        snapshot.worker.available = 2;
        snapshot.worker.remoteWaiting = 3;
        expect(describeStatus(snapshot)).toMatchObject({ headline: 'Waiting for OCR…',
            caption: '3 files processing remotely.', processNow: false });
        snapshot.worker.inFlight = 1;
        expect(describeStatus(snapshot).headline).toBe('Processing files…');
        snapshot.worker.inFlight = 0;
        snapshot.worker.remoteWaiting = 0;
        expect(describeStatus(snapshot).caption).toBe('Starting…');
    });
    it('keeps queued local work actionable during remote OCR', () => {
        const snapshot = status(3);
        snapshot.worker.remoteWaiting = 3;
        snapshot.worker.available = 2;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot)).toMatchObject({ processNow: true, processNowBlocked: false });
        snapshot.worker.dispatchBlocker = 'sync';
        expect(describeStatus(snapshot)).toMatchObject({ processNow: true, processNowBlocked: true });
        snapshot.worker.drainNow = true;
        expect(describeStatus(snapshot)).toMatchObject({ processNow: false, stopDrain: true });
        snapshot.worker.drainNow = false;
        snapshot.worker.available = 0;
        expect(describeStatus(snapshot).processNow).toBe(false);
    });
    it('uses authoritative pending attachments across ledger/queue overlap and index-stage gaps', () => {
        const snapshot = status(0, 3);
        snapshot.progress = { runId: 1, startedAt: 1, finishedAt: null, total: 5, pending: 4,
            succeeded: 1, problems: 0, removed: 0, discovering: false, discovered: 0 };
        snapshot.worker.available = 1;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot).headline).toBe('4 files waiting');
        snapshot.worker.available = 0;
        expect(describeStatus(snapshot)).toMatchObject({ headline: '4 files waiting', processNow: true });
        expect(describeStatus(snapshot).headline).toBe('4 files waiting');
    });

    it('subtracts distinct running attachments instead of overlapping stage jobs', () => {
        const snapshot = status(0, 4);
        snapshot.progress = { runId: 1, startedAt: 1, finishedAt: null, total: 4, pending: 4,
            succeeded: 0, problems: 0, removed: 0, discovering: false, discovered: 0 };
        snapshot.worker.inFlight = 2;
        snapshot.worker.inFlightFiles = 1;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot).caption).toContain('3 files waiting');
    });

    it('settles without a red headline or Start now when only unavailable files remain', () => {
        const snapshot = status(0);
        snapshot.ledger.readable = 0;
        snapshot.ledger.unreadable = 1;
        snapshot.issues = [{ reason: 'file_unavailable', count: 1 }];
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'idle', headline: 'Processing finished', processNow: false,
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
            caption: '5 files waiting. Processing continues when your computer is idle.',
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
            tone: 'busy', headline: 'Processing files…', caption: '3 files remaining', outstanding: 3,
        });
    });

    it('counts queued re-reads of settled files, running ones included once', () => {
        // A claimed job is still a queue row (deferred until its visibility
        // timeout), so inFlight is not added on top of the queue depth.
        const snapshot = status(1, 0);
        snapshot.worker.inFlight = 1;
        snapshot.worker.available = 4;
        expect(describeStatus(snapshot)).toMatchObject({ tone: 'busy', caption: '5 files remaining', outstanding: 5 });
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
        expect(describeStatus(snapshot).caption).toBe('1 file remaining');
        snapshot.worker.inFlight = 0;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot).caption).toBe('Starts after about 30 seconds without keyboard or mouse activity on your computer.');
    });

    it('counts every file with queued work, read or not', () => {
        // Search-entitled accounts queue an index upload for each file as soon
        // as it is read, so read files routinely outnumber settled ones.
        const snapshot = status(0, 10);
        snapshot.ledger.readable = 6;
        snapshot.worker.inFlight = 1;
        snapshot.worker.available = 7;
        snapshot.worker.queuedFiles = 8;
        expect(describeStatus(snapshot)).toMatchObject({ tone: 'busy', caption: '8 files remaining', outstanding: 8 });
        // An index backfill of already-read files counts the same way.
        snapshot.ledger.readable = 10;
        expect(describeStatus(snapshot)).toMatchObject({ caption: '8 files remaining', outstanding: 8 });
    });

    it.each(['failed', 'skipped'] as const)('treats a terminal %s extraction as settled, leaving it to the issue list', (outcome) => {
        const snapshot = status(0);
        snapshot.ledger.readable = 0;
        snapshot.ledger.unreadable = 1;
        snapshot.ledger[outcome] = 1;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'idle', headline: 'Processing finished', processNow: false,
        });
    });


    it.each(['extraction', 'ocr', 'index'])('reports unfinished %s ledger work without a queued job as waiting', (stage) => {
        const snapshot = status(0);
        if (stage === 'index') snapshot.ledger.oldestPendingAt = '2026-09-09 00:00:00';
        else snapshot.ledger.readable = 0;
        if (stage === 'ocr') snapshot.ledger.awaitingOcr = 1;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'waiting', headline: stage === 'index' ? 'Waiting to start' : '1 file waiting', processNow: true,
        });
    });

    it('folds the empty-library state into the settled caption', () => {
        expect(describeStatus(status(0, 0))).toMatchObject({
            tone: 'idle', headline: 'Processing finished', caption: 'No files to process yet. Beaver checks your libraries for new files automatically.',
        });
    });

    it.each([false, true])('shows parked work as waiting with immediate drain %s', (drainNow) => {
        const snapshot = status(3);
        snapshot.worker.drainNow = drainNow;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'waiting', headline: '3 files waiting', processNow: false, stopDrain: drainNow,
        });
    });

    it('shows delayed retries as waiting even before a ledger row exists', () => {
        expect(describeStatus(status(1, 0))).toMatchObject({
            tone: 'waiting', headline: '1 file waiting', processNow: false,
        });
    });

    it('reports completion only after deferred work finishes', () => {
        expect(describeStatus(status(0))).toMatchObject({
            tone: 'idle', headline: 'Processing finished',
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
        expect(describeStatus(snapshot)).toMatchObject({ headline: '2 files waiting', caption });
    });

    it('explains the idle gate rather than a blocker when nothing blocks dispatch', () => {
        const snapshot = status(0);
        snapshot.worker.available = 2;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot)).toMatchObject({
            headline: '2 files waiting',
            caption: 'Starts after about 30 seconds without keyboard or mouse activity on your computer.',
            processNowBlocked: false,
        });
    });

    it('separates waiting counts from idle, sync, retry and unfinished-stage explanations', () => {
        const gated = status(0, 5);
        gated.ledger.readable = 2;
        gated.worker.available = 3;
        gated.worker.backlogGateOpen = false;
        expect(describeStatus(gated).headline).toBe('3 files waiting');
        expect(describeStatus(gated).caption).toBe('Starts after about 30 seconds without keyboard or mouse activity on your computer.');
        gated.worker.dispatchBlocker = 'sync_in_progress';
        expect(describeStatus(gated).headline).toBe('3 files waiting');
        expect(describeStatus(gated).caption).toBe('Zotero is syncing.');
        // Two deferred jobs outnumber the one ledger file still open, so the queue wins.
        const deferred = status(2, 4);
        deferred.ledger.readable = 3;
        expect(describeStatus(deferred).headline).toBe('2 files waiting');
        expect(describeStatus(deferred).caption).toBe('Some files are processing remotely or waiting to retry.');
        deferred.worker.deferred = 1;
        expect(describeStatus(deferred).headline).toBe('1 file waiting');
        expect(describeStatus(deferred).caption).toBe('Some files are processing remotely or waiting to retry.');
        const unfinished = status(0, 2);
        unfinished.ledger.readable = 0;
        expect(describeStatus(unfinished).headline).toBe('2 files waiting');
        expect(describeStatus(unfinished).caption).toBe('Beaver picks up unfinished files automatically.');
        // Re-reads of settled files are queued jobs the ledger does not count.
        const untracked = status(0);
        untracked.worker.available = 279;
        untracked.worker.backlogGateOpen = false;
        expect(describeStatus(untracked).headline).toBe('279 files waiting');
        expect(describeStatus(untracked).caption).toBe('Starts after about 30 seconds without keyboard or mouse activity on your computer.');
    });

    it('keeps running work ahead of deferred work', () => {
        const snapshot = status(3);
        snapshot.worker.inFlight = 1;
        expect(describeStatus(snapshot).tone).toBe('busy');
    });

    it('promises up-to-date search only on settled statuses, and only when asked to', () => {
        const snapshot = status(0);
        expect(describeStatus(snapshot, { searchIndexUpToDate: true }).headline).toBe('Full-text search is up to date');
        expect(describeStatus(status(0, 0), { searchIndexUpToDate: true }).headline).toBe('Full-text search is up to date');
        expect(describeStatus(snapshot, { searchIndexUpToDate: false }).headline).toBe('Processing finished');
        snapshot.worker.available = 1;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot, { searchIndexUpToDate: true }).headline).toBe('1 file waiting');
    });

    it('settles with the plain processing sentence and no Start now', () => {
        const snapshot = status(0);
        const sentence = describeStatus(snapshot);
        expect(sentence).toMatchObject({
            tone: 'idle', headline: 'Processing finished', processNow: false, stopDrain: false,
            caption: 'Beaver processes new and changed files automatically.',
        });
        expect(sentence.processNowBlocked).toBeFalsy();
    });

    it('keeps deferred and not-yet-queued work waiting, with Stop only while draining', () => {
        const deferred = status(2);
        expect(describeStatus(deferred)).toMatchObject({ headline: '2 files waiting', processNow: false });
        deferred.worker.drainNow = true;
        expect(describeStatus(deferred)).toMatchObject({ processNow: false, stopDrain: true });
        const unfinished = status(0);
        unfinished.ledger.oldestPendingAt = '2026-09-09 00:00:00';
        expect(describeStatus(unfinished)).toMatchObject({ headline: 'Waiting to start', processNow: true });
        unfinished.worker.drainNow = true;
        expect(describeStatus(unfinished)).toMatchObject({ processNow: false, stopDrain: true });
    });

    it('ranks running work ahead of queued work', () => {
        const snapshot = status(0);
        snapshot.worker.available = 2;
        snapshot.worker.backlogGateOpen = false;
        expect(describeStatus(snapshot)).toMatchObject({ headline: '2 files waiting', processNow: true });
        snapshot.worker.inFlight = 1;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'busy', headline: 'Finishing current file…', processNow: false, stopDrain: false,
        });
        snapshot.worker.drainNow = true;
        snapshot.worker.backlogGateOpen = true;
        expect(describeStatus(snapshot)).toMatchObject({
            tone: 'busy', headline: 'Processing files…', processNow: false, stopDrain: true,
        });
    });
});

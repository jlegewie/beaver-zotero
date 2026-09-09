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
    it.each([false, true])('offers a manual recheck after unavailable files drain with continuous mode %s', (continuous) => {
        const snapshot = status(0);
        snapshot.ledger.readable = 0;
        snapshot.ledger.unreadable = 1;
        snapshot.issues = [{ reason: 'file_unavailable', count: 1 }];
        expect(describeStatus(snapshot, continuous)).toMatchObject({ tone: 'error', processNow: true });
        snapshot.worker.dispatchBlocker = 'sync_in_progress';
        expect(describeStatus(snapshot, continuous).processNow).toBe(false);
    });

    it('shows dispatcher-blocked work as waiting without offering an idle bypass', () => {
        const snapshot = status(0);
        snapshot.worker.available = 4;
        snapshot.worker.dispatchBlocker = 'sync_in_progress';
        expect(describeStatus(snapshot, true)).toMatchObject({ tone: 'waiting', processNow: false });
    });
    it.each(['failed', 'skipped'] as const)('does not declare completion after terminal extraction is %s', (outcome) => {
        const snapshot = status(0);
        snapshot.ledger.readable = 0;
        snapshot.ledger.unreadable = 1;
        snapshot.ledger[outcome] = 1;
        expect(describeStatus(snapshot, false)).toMatchObject({
            tone: 'error', headline: 'Some files could not be processed', processNow: false,
        });
    });

    it('does not declare completion for readable files with unresolved index issues', () => {
        const snapshot = status(0);
        snapshot.issues = [{ reason: 'index_failed', count: 1 }];
        expect(describeStatus(snapshot, false).headline).toBe('Some files could not be processed');
    });

    it.each(['extraction', 'ocr', 'index'])('reports unfinished %s ledger work without a queued job as waiting', (stage) => {
        const snapshot = status(0);
        if (stage === 'index') snapshot.ledger.oldestPendingAt = '2026-09-09 00:00:00';
        else snapshot.ledger.readable = 0;
        if (stage === 'ocr') snapshot.ledger.awaitingOcr = 1;
        expect(describeStatus(snapshot, true)).toMatchObject({
            tone: 'waiting', headline: 'Files are waiting to be processed', processNow: false,
        });
    });

    it('preserves the empty-library state when there are no issues or pending stages', () => {
        expect(describeStatus(status(0, 0), false).headline).toBe('No attachments to process yet');
    });

    it.each([false, true])('shows parked work as waiting with immediate drain %s', (drainNow) => {
        const snapshot = status(3);
        snapshot.worker.drainNow = drainNow;
        expect(describeStatus(snapshot, false)).toMatchObject({
            tone: 'waiting', headline: '3 files waiting to finish', processNow: false,
        });
    });

    it('shows delayed retries as waiting even before a ledger row exists', () => {
        expect(describeStatus(status(1, 0), true)).toMatchObject({
            tone: 'waiting', headline: '1 file waiting to finish', processNow: false,
        });
    });

    it('reports completion only after deferred work finishes', () => {
        expect(describeStatus(status(0), false)).toMatchObject({
            tone: 'idle', headline: 'All files are processed',
        });
    });

    it('keeps running work ahead of deferred work', () => {
        const snapshot = status(3);
        snapshot.worker.inFlight = 1;
        expect(describeStatus(snapshot, false).tone).toBe('busy');
    });
});

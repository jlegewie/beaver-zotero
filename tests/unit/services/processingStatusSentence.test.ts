import { describe, expect, it } from 'vitest';
import { backgroundProcessingStatusAtom } from '../../../react/atoms/backgroundProcessing';
import { describeStatus } from '../../../react/components/preferences/processingStatusSentence';

function status(deferred: number, total = 1) {
    return {
        ...backgroundProcessingStatusAtom.init,
        ledger: { ...backgroundProcessingStatusAtom.init.ledger, total },
        worker: { available: 0, deferred, inFlight: 0, backlogGateOpen: true, drainNow: false },
    };
}

describe('processing status sentence', () => {
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

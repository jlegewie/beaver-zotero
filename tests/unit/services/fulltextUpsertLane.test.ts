import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/services/backgroundProcessing/remoteRefsReconcile', () => ({
    reconcileRemoteRefs: vi.fn(async () => undefined),
}));

import { indexLaneCapacity, startFulltextUpsertLane } from '../../../src/services/backgroundProcessing/fulltextUpsertLane';

describe('indexLaneCapacity', () => {
    it('uses four slots, all of them while the user is active, until the backend advertises a limit', () => {
        expect(indexLaneCapacity()).toEqual({ maxInFlight: 4, activeMaxInFlight: 4 });
        expect(indexLaneCapacity(null)).toEqual({ maxInFlight: 4, activeMaxInFlight: 4 });
    });

    it('follows the advertised limit and keeps at most four slots while the user is active', () => {
        expect(indexLaneCapacity(8)).toEqual({ maxInFlight: 8, activeMaxInFlight: 4 });
        expect(indexLaneCapacity(2)).toEqual({ maxInFlight: 2, activeMaxInFlight: 2 });
    });

    it('caps the advertised limit at the client ceiling', () => {
        expect(indexLaneCapacity(32)).toEqual({ maxInFlight: 8, activeMaxInFlight: 4 });
    });

    it('ignores advertised limits that are not usable slot counts', () => {
        for (const advertised of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(indexLaneCapacity(advertised)).toEqual({ maxInFlight: 4, activeMaxInFlight: 4 });
        }
        expect(indexLaneCapacity(6.7)).toEqual({ maxInFlight: 6, activeMaxInFlight: 4 });
    });
});

describe('startFulltextUpsertLane', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('drains cleanup several requests at a time, fewer while the user is active', async () => {
        vi.useFakeTimers();
        const registerExecutor = vi.fn();
        (globalThis as any).Zotero.Beaver = {
            backgroundExtractor: { registerExecutor, unregisterExecutor: vi.fn(), setLaneCapacity: vi.fn(), notify: vi.fn() },
        };
        const stop = startFulltextUpsertLane([1], false);

        expect(registerExecutor).toHaveBeenCalledTimes(1);
        expect(registerExecutor).toHaveBeenCalledWith(expect.objectContaining({ jobType: 'fulltext_untag' }),
            { maxInFlight: 8, activeMaxInFlight: 4, survivesLibraryExclusion: true });
        await stop();
    });
});

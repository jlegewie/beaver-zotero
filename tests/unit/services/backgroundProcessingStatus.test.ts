import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectProcessingStatus } from '../../../src/services/backgroundProcessing/statusSnapshot';

vi.mock('../../../src/utils/zoteroUtils', () => ({ getZoteroUserIdentifier: vi.fn() }));
vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({ searchIndexApiClient: {} }));

afterEach(() => vi.unstubAllGlobals());

describe('processing status runnable lanes', () => {
    it('polls only issue counts, never the complete inventory or attachment pages', async () => {
        const inventory = vi.fn(() => { throw new Error('unbounded inventory read'); });
        const page = vi.fn();
        const counts = vi.fn(async () => [{ reason: 'scanned', count: 50_000 }]);
        vi.stubGlobal('Zotero', { Beaver: { db: {
            getBackgroundQueueStats: vi.fn(async () => ({ available: 0, deferred: 0 })),
            getAttachmentProcessingAggregates: vi.fn(async () => ({})),
            getBackgroundProcessingFailures: vi.fn(async () => []),
            getAttachmentProcessingIssueRows: inventory,
            getBackgroundDeadLetters: inventory,
            getProcessingIssuePage: page,
            getProcessingIssueCounts: counts,
        } } });
        const result = await collectProcessingStatus(
            { hasOcrAccess: false, hasSearchIndexAccess: false }, { includeFailures: true },
        );
        expect(result.issues).toEqual([{ reason: 'scanned', count: 50_000 }]);
        expect(counts).toHaveBeenCalledTimes(1);
        expect(inventory).not.toHaveBeenCalled();
        expect(page).not.toHaveBeenCalled();
    });
    it.each([
        [false, { document_extract: { inFlight: 0 } }, ['document_extract']],
        [false, { fulltext_upsert: { inFlight: 0 } }, []],
        [true, {}, []],
        [true, { fulltext_upsert: { inFlight: 0 } }, ['fulltext_upsert']],
    ])('filters registered lanes with search access %s', async (hasSearchIndexAccess, lanes, expected) => {
        const getBackgroundQueueStats = vi.fn(async (_now: number, types?: string[]) => ({
            pending: 4, available: types?.includes('fulltext_upsert') || types === undefined ? 4 : 0,
            deferred: 0, dead: 0, byJobType: { fulltext_upsert: 4 },
        }));
        vi.stubGlobal('Zotero', { Beaver: {
            db: { getBackgroundQueueStats, getAttachmentProcessingAggregates: vi.fn(async () => ({})) },
            backgroundExtractor: {
                getLaneStatus: () => lanes,
                isBacklogGateOpen: () => true,
            },
        } });
        const result = await collectProcessingStatus({ hasOcrAccess: false, hasSearchIndexAccess });
        expect(getBackgroundQueueStats).toHaveBeenLastCalledWith(expect.any(Number), expected);
        expect(result.worker.available).toBe(expected.includes('fulltext_upsert') ? 4 : 0);
        expect(result.queue.available).toBe(4);
    });
});

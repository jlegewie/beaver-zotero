import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectProcessingStatus } from '../../../src/services/backgroundProcessing/statusSnapshot';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

vi.mock('../../../src/utils/zoteroUtils', () => ({ getZoteroUserIdentifier: vi.fn() }));
vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({ searchIndexApiClient: {} }));

afterEach(() => vi.unstubAllGlobals());

describe('processing status runnable lanes', () => {
    it.each([
        [false, false], [false, true], [true, false], [true, true],
    ])('uses OCR entitlement independently of search access (%s, %s)', async (hasOcrAccess, hasSearchIndexAccess) => {
        const connection = new MockDBConnection();
        const db = new BeaverDB(connection);
        try {
            await db.initDatabase('0.99.0');
            await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'SCANNED0', contentKind: 'pdf' });
            await connection.queryAsync("UPDATE attachment_processing_state SET extract_status = 'done', ocr_status = 'needed'");
            await db.enqueueBackgroundJob({
                jobType: 'document_ocr', libraryId: 1, zoteroKey: 'SCANNED0',
                contentKind: 'pdf', payloadKind: 'structured', now: 0,
            });
            vi.stubGlobal('Zotero', { Beaver: {
                db,
                backgroundExtractor: { getLaneStatus: () => ({ document_ocr: { inFlight: 0 } }) },
            } });
            const snapshot = await collectProcessingStatus(
                { hasOcrAccess, hasSearchIndexAccess }, { includeFailures: true },
            );
            expect(snapshot.ledger).toMatchObject({
                total: 1, readable: 0, unreadable: hasOcrAccess ? 0 : 1,
                awaitingOcr: hasOcrAccess ? 1 : 0,
            });
            expect(snapshot.worker.available).toBe(hasOcrAccess ? 1 : 0);
            expect(snapshot.issues).toEqual(hasOcrAccess ? [] : [{ reason: 'scanned', count: 1 }]);
            if (!hasOcrAccess) expect(snapshot.ledger.oldestPendingAt).toBeNull();
        } finally {
            await connection.closeDatabase();
        }
    });

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
    it('takes the per-file queue depth and running count from the file lanes only, never from untagging', async () => {
        const getBackgroundQueueStats = vi.fn(async (_now: number, types?: string[]) => types === undefined
            ? { pending: 9, available: 9, deferred: 0, dead: 0, byJobType: {}, attachments: 8 }
            : { pending: 2, available: 2, deferred: 0, dead: 0, byJobType: {}, attachments: 1 });
        vi.stubGlobal('Zotero', { Beaver: {
            db: { getBackgroundQueueStats, getAttachmentProcessingAggregates: vi.fn(async () => ({})) },
            backgroundExtractor: {
                getLaneStatus: () => ({ document_extract: { inFlight: 1 }, fulltext_untag: { inFlight: 2 } }),
                isBacklogGateOpen: () => true,
            },
        } });
        const result = await collectProcessingStatus({ hasOcrAccess: false, hasSearchIndexAccess: true });
        expect(getBackgroundQueueStats).toHaveBeenLastCalledWith(expect.any(Number), ['document_extract']);
        expect(result.worker).toMatchObject({ available: 2, queuedFiles: 1, inFlight: 1 });
        expect(result.queue.attachments).toBe(8);
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

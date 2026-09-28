import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

const mocks = vi.hoisted(() => ({
    backgroundEnabled: true,
    enqueueOcrJob: vi.fn(),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => key === 'backgroundProcessingEnabled' && mocks.backgroundEnabled,
}));
vi.mock('../../../src/utils/zoteroItemUtils', () => ({ safeIsInTrash: (item: any) => item.deleted === true }));
vi.mock('../../../src/services/ocr/enqueueOcr', () => ({
    maybeEnqueueOcrJob: vi.fn(),
    enqueueOcrJob: mocks.enqueueOcrJob,
}));

import { ReconcilerService } from '../../../src/services/backgroundProcessing/reconciler';
import { OCR_PRIORITY_BACKFILL, OCR_SERVICE_UNAVAILABLE } from '../../../src/services/ocr/constants';

describe('ReconcilerService OCR admission recovery', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;
    let reconciler: ReconcilerService;
    const items = new Map<string, { id: number; libraryID: number; key: string; deleted?: boolean }>();
    const notify = vi.fn();

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        mocks.backgroundEnabled = true;
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        items.clear();
        // The OCR ticket is the queue row the real enqueue would insert.
        mocks.enqueueOcrJob.mockImplementation(async (args: { libraryId: number; zoteroKey: string; itemId: number }) => {
            await db.enqueueBackgroundJobs([{
                jobType: 'document_ocr', libraryId: args.libraryId, itemId: args.itemId,
                zoteroKey: args.zoteroKey, contentKind: 'pdf', payloadKind: 'structured',
                priority: OCR_PRIORITY_BACKFILL, payload: null, now: Date.now(),
            }]);
        });
        vi.stubGlobal('Zotero', { ...Zotero,
            __beaverShuttingDown: false,
            Items: {
                getAsync: vi.fn(async () => null),
                getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) =>
                    items.get(`${libraryID}-${key}`) ?? false),
            },
            Libraries: { getAll: () => [
                { libraryID: 1, libraryType: 'user' },
                { libraryID: 9, libraryType: 'group' },
            ] },
            Beaver: {
                db,
                libraryScopeInitialized: true,
                searchableLibraryIds: [1],
                hasOcrAccess: true,
                hasSearchIndexAccess: true,
                backgroundExtractor: { notify },
            },
        });
        reconciler = new ReconcilerService();
        // Library enumeration is covered elsewhere; these tests exercise only the recovery.
        vi.spyOn(reconciler as any, 'reconcileLibrary').mockResolvedValue(undefined);
        reconciler.start();
    });

    afterEach(async () => {
        reconciler.stop();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        await connection.closeDatabase();
    });

    async function parked(libraryId: number, key: string, parkedAt: string, error: string | null = OCR_SERVICE_UNAVAILABLE) {
        const id = 100 + items.size;
        items.set(`${libraryId}-${key}`, { id, libraryID: libraryId, key });
        await db.ensureAttachmentProcessingState({ libraryId, zoteroKey: key, itemId: id, contentKind: 'pdf' });
        await connection.queryAsync(`UPDATE attachment_processing_state SET
            extract_status = 'done', ocr_status = 'needed', file_hash = 'hash-' || zotero_key,
            last_error = ?, updated_at = ? WHERE library_id = ? AND zotero_key = ?`,
        [error, parkedAt, libraryId, key]);
    }

    /** The executor's `disabled` path: retire the ticket and park the row again. */
    async function refuse(key: string, parkedAt: string) {
        await connection.queryAsync(`DELETE FROM background_jobs WHERE zotero_key = ?`, [key]);
        await connection.queryAsync(`UPDATE attachment_processing_state SET updated_at = ? WHERE zotero_key = ?`,
            [parkedAt, key]);
    }

    const ticketedKeys = () => mocks.enqueueOcrJob.mock.calls.map(([args]) => args.zoteroKey);
    const pass = () => (reconciler as any).run(false);

    it('probes admission with one request per pass, starting with the longest-waiting attachment', async () => {
        await parked(1, 'SCAN0002', '2026-09-28 03:01:12');
        await parked(1, 'SCAN0001', '2026-09-28 03:01:11');
        await parked(1, 'SCAN0003', '2026-09-28 03:01:13');
        await parked(1, 'PENDING1', '2026-09-28 03:00:00', null);
        await parked(9, 'EXCLUDED', '2026-09-28 03:00:00');

        await pass();
        expect(ticketedKeys()).toEqual(['SCAN0001']);
        expect(mocks.enqueueOcrJob).toHaveBeenCalledWith(expect.objectContaining({
            libraryId: 1, zoteroKey: 'SCAN0001', priority: OCR_PRIORITY_BACKFILL, requestContext: 'backfill',
        }));
        expect(notify).toHaveBeenCalled();

        // The probe is still in flight: nothing else is requested.
        await pass();
        expect(ticketedKeys()).toEqual(['SCAN0001']);

        // Admission was still closed; the next probe moves on to the next-oldest row.
        await refuse('SCAN0001', '2026-09-28 03:06:00');
        await pass();
        expect(ticketedKeys()).toEqual(['SCAN0001', 'SCAN0002']);
    });

    it('tickets every remaining parked attachment once a request is admitted again', async () => {
        await parked(1, 'SCAN0001', '2026-09-28 03:01:11');
        await parked(1, 'SCAN0002', '2026-09-28 03:01:12');
        await parked(1, 'SCAN0003', '2026-09-28 03:01:13');
        await parked(1, 'TRASHED1', '2026-09-28 03:01:14');
        items.get('1-TRASHED1')!.deleted = true;
        await parked(9, 'EXCLUDED', '2026-09-28 03:00:00');
        await pass();
        expect(ticketedKeys()).toEqual(['SCAN0001']);

        // The executor clears the admitted row's marker and reports the reopening.
        await connection.queryAsync(`UPDATE attachment_processing_state SET last_error = NULL WHERE zotero_key = 'SCAN0001'`);
        reconciler.notifyOcrAdmissionReopened();
        await pass();
        expect(ticketedKeys()).toEqual(['SCAN0001', 'SCAN0002', 'SCAN0003']);

        // Every parked row is ticketed; later admissions and passes add nothing.
        reconciler.notifyOcrAdmissionReopened();
        await pass();
        await pass();
        expect(ticketedKeys()).toEqual(['SCAN0001', 'SCAN0002', 'SCAN0003']);
    });

    it.each([
        ['OCR access is withdrawn', () => { (Zotero.Beaver as any).hasOcrAccess = false; }],
        ['background processing is off', () => { mocks.backgroundEnabled = false; }],
    ])('requests nothing while %s', async (_label, disable) => {
        await parked(1, 'SCAN0001', '2026-09-28 03:01:11');
        disable();
        reconciler.notifyOcrAdmissionReopened();
        await pass();
        expect(mocks.enqueueOcrJob).not.toHaveBeenCalled();
    });
});

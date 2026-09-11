import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { getUncachedCandidates, prepareUncachedFiles } from '../../../src/services/backgroundProcessing/cachePreparation';
import type { DocumentCacheStats } from '../../../src/services/documentCache';

const prefs = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: (key: string) => key === 'backgroundProcessingEnabled' ? prefs.enabled : undefined }));
vi.mock('../../../src/utils/zoteroItemUtils', () => ({ safeIsInTrash: (item: any) => item.deleted === true }));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({ getReadableContentKind: () => 'pdf' }));

describe('explicit cache preparation', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;
    const drain = vi.fn();
    const stats = { payload_budget_bytes: 1000, payload_total_bytes: 100 } as DocumentCacheStats;
    beforeEach(async () => {
        vi.clearAllMocks();
        prefs.enabled = true;
        conn = new MockDBConnection();
        db = new BeaverDB(conn);
        await db.initDatabase('0.99.0');
        (Zotero as any).Beaver = {
            db, libraryScopeInitialized: true, searchableLibraryIds: [1], hasOcrAccess: false,
            documentCache: { getStats: async () => stats, runMaintenance: (work: () => Promise<void>) => work() },
            backgroundExtractor: { requestImmediateDrain: drain },
        };
        (Zotero as any).Items = {
            getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) => ({ id: 1, libraryID, key })),
        };
    });
    afterEach(async () => {
        await conn.closeDatabase();
        delete (Zotero as any).Beaver;
    });
    async function seed(key: string, date: string, libraryId = 1, ocr = 'na') {
        await db.ensureAttachmentProcessingState({ libraryId, zoteroKey: key, contentKind: 'pdf' });
        await conn.queryAsync(`UPDATE attachment_processing_state SET extract_status = 'done', ocr_status = ?,
            upsert_status = 'done', upsert_index_version = '2', structured_document_hash = 'keep-index'
            WHERE library_id = ? AND zotero_key = ?`, [ocr, libraryId, key]);
        await conn.queryAsync(`UPDATE attachment_processing_state SET created_at = ? WHERE library_id = ? AND zotero_key = ?`, [date, libraryId, key]);
    }
    it('queues all eligible missing files newest first without resetting history', async () => {
        await seed('OLDER001', '2025-01-01');
        await seed('NEWER001', '2026-01-01');
        await seed('SMALL001', '2024-01-01');
        const before = await db.getAttachmentProcessingState(1, 'NEWER001');
        expect(await prepareUncachedFiles()).toBe(3);
        expect(drain).toHaveBeenCalledOnce();
        const job = await db.claimNextBackgroundJob(Date.now() + 100, 60_000);
        expect(job).toMatchObject({ zoteroKey: 'NEWER001', priority: 110, payload: { prepare_cache: true } });
        expect(await db.getAttachmentProcessingState(1, 'NEWER001')).toEqual(before);
        expect(await getUncachedCandidates(stats)).toEqual([]);
        expect(await prepareUncachedFiles()).toBe(0);
    });
    it('filters excluded libraries and unavailable OCR access before looking up items', async () => {
        await seed('EXCLUDED', '2026-01-01', 2);
        await seed('SCANNED1', '2026-01-01', 1, 'done');
        expect(await prepareUncachedFiles()).toBe(0);
        expect(Zotero.Items.getByLibraryAndKeyAsync).not.toHaveBeenCalled();
        expect(drain).not.toHaveBeenCalled();
        (Zotero.Beaver as any).hasOcrAccess = true;
        expect(await prepareUncachedFiles()).toBe(1);
    });
    it('does not restore when disabled, scope is unknown, or the cache is full', async () => {
        await seed('TARGET01', '2026-01-01');
        expect(await getUncachedCandidates({ ...stats, payload_total_bytes: 1000 })).toEqual([]);
        prefs.enabled = false;
        expect(await prepareUncachedFiles()).toBe(0);
        prefs.enabled = true;
        (Zotero.Beaver as any).libraryScopeInitialized = false;
        expect(await prepareUncachedFiles()).toBe(0);
        expect(drain).not.toHaveBeenCalled();
    });
    it('leaves missing files eligible if enqueue fails', async () => {
        await seed('TARGET01', '2026-01-01');
        vi.spyOn(db as any, 'enqueueBackgroundJobInTransaction').mockRejectedValueOnce(new Error('write failed'));
        await expect(prepareUncachedFiles()).rejects.toThrow('write failed');
        expect(await getUncachedCandidates(stats)).toHaveLength(1);
        expect(drain).not.toHaveBeenCalled();
    });
});

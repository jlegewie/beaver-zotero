import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { expectedExtractionSchemaVersion } from '../../../src/services/documentExtraction/shared/extractionSchemaVersions';

const mocks = vi.hoisted(() => ({
    backgroundEnabled: true,
    resolveAttachmentFileSource: vi.fn(),
    maybeEnqueueOcrJob: vi.fn(),
    enqueueOcrJob: vi.fn(async () => undefined),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: (key: string) => key === 'backgroundProcessingEnabled' && mocks.backgroundEnabled,
}));
vi.mock('../../../src/utils/idleService', () => ({ getSystemIdleTimeMs: () => 0 }));
vi.mock('../../../src/utils/zoteroItemUtils', () => ({ safeIsInTrash: () => false }));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: () => 'pdf',
}));
vi.mock('../../../src/services/documentExtraction/attachmentSource', () => ({
    resolveAttachmentFileSource: mocks.resolveAttachmentFileSource,
}));
vi.mock('../../../src/services/documentFileIdentity', () => ({
    getFileSignature: vi.fn(),
    isRemoteFilePath: () => false,
}));
vi.mock('../../../src/services/ocr/enqueueOcr', () => ({
    maybeEnqueueOcrJob: mocks.maybeEnqueueOcrJob,
    enqueueOcrJob: mocks.enqueueOcrJob,
}));

vi.mock('../../../src/utils/zoteroUtils', async importOriginal => ({
    ...await importOriginal<typeof import('../../../src/utils/zoteroUtils')>(),
    getIndexScopeRef: (id: number) => id === 1 ? 'lLOCAL123' : `g${id}`,
    getZoteroUserIdentifier: () => ({ localUserKey: 'LOCAL123' }),
}));
import { SearchReadiness } from '../../../src/services/backgroundProcessing/searchReadiness';
import { NewItemWatcher } from '../../../src/services/backgroundProcessing/newItemWatcher';
import { ReconcilerService } from '../../../src/services/backgroundProcessing/reconciler';
import { OCR_ENGINE_VERSION, OCR_PRIORITY_ON_DEMAND } from '../../../src/services/ocr/constants';

const ENTITLED = { hasOcrAccess: true, hasSearchIndexAccess: true };

describe('ReconcilerService.retryAttachments', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;
    let reconciler: ReconcilerService;
    const items = new Map<string, { id: number; libraryID: number; key: string }>();
    const requestImmediateDrain = vi.fn();
    const notify = vi.fn();
    const invalidate = vi.fn(async () => undefined);
    const getMetadata = vi.fn(async () => ({ pageCount: 5 }));

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.backgroundEnabled = true;
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        reconciler = new ReconcilerService();
        items.clear();
        items.set('1-MISSING1', { id: 11, libraryID: 1, key: 'MISSING1' });
        items.set('1-CRASHED1', { id: 12, libraryID: 1, key: 'CRASHED1' });
        items.set('1-INDEXED1', { id: 13, libraryID: 1, key: 'INDEXED1' });
        items.set('9-EXCLUDED', { id: 14, libraryID: 9, key: 'EXCLUDED' });
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKeyAsync: vi.fn(async (libraryID: number, key: string) =>
                items.get(`${libraryID}-${key}`) ?? false),
        };
        (globalThis as any).Zotero.Beaver = {
            db,
            libraryScopeInitialized: true,
            searchableLibraryIds: [1],
            hasOcrAccess: true,
            hasSearchIndexAccess: true,
            backgroundExtractor: { requestImmediateDrain, notify },
            documentCache: { invalidate, getMetadata },
        };
        mocks.resolveAttachmentFileSource.mockResolvedValue({
            kind: 'ok', source: { kind: 'local', filePath: '/tmp/a.pdf', isRemoteOnly: false },
        });
    });

    afterEach(async () => {
        reconciler.stop();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        await connection.closeDatabase();
        delete (globalThis as any).Zotero.Beaver;
    });

    async function failedExtraction(key: string, error: string, status: 'failed' | 'skipped' = 'failed') {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: key, itemId: items.get(`1-${key}`)?.id, contentKind: 'pdf' });
        await db.markAttachmentExtractFailure({ attemptedAt: Date.now(), libraryId: 1, zoteroKey: key, status, error });
    }

    it.each([true, false])('heals missed deletions and trashed parents with background processing enabled=%s', async (enabled) => {
        mocks.backgroundEnabled = enabled;
        await connection.queryAsync('CREATE TABLE items (itemID INTEGER PRIMARY KEY, libraryID INTEGER, key TEXT)');
        await connection.queryAsync('CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, contentType TEXT, parentItemID INTEGER)');
        await connection.queryAsync('CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY)');
        await connection.queryAsync("INSERT INTO items VALUES (10, 1, 'LIVEPARN'), (11, 1, 'TRASHPAR')");
        await connection.queryAsync('INSERT INTO deletedItems VALUES (11)');
        for (const [id, key, contentKind, deleted, parentItemID] of [
            [1, 'LIVEPDF1', 'pdf', false, 10],
            [2, 'LIVETEXT', 'text', false, null],
            [3, 'TRASHED1', 'text', true, null],
            [4, 'DELETED1', 'pdf', false, null],
            [5, 'CHILDPDF', 'pdf', false, 11],
            [6, 'CHILDTXT', 'text', false, 11],
        ] as const) {
            await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: key,
                contentKind, errorCode: 'file_missing', attemptedAt: 100 });
            if (key === 'DELETED1') continue;
            await connection.queryAsync('INSERT INTO items VALUES (?, 1, ?)', [id, key]);
            await connection.queryAsync('INSERT INTO itemAttachments VALUES (?, ?, ?)', [id, contentKind === 'text' ? 'text/plain' : 'application/pdf', parentItemID]);
            if (deleted) await connection.queryAsync('INSERT INTO deletedItems VALUES (?)', [id]);
        }
        await db.recordAttachmentReadingOutcome({ libraryId: 9, zoteroKey: 'EXCLUDED',
            contentKind: 'pdf', errorCode: 'file_missing', attemptedAt: 100 });
        for (const key of ['DELETED1', 'CHILDPDF']) {
            await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: key, contentKind: 'pdf' });
            await connection.queryAsync(`UPDATE attachment_processing_state
                SET extract_status = 'failed', last_error = 'file_missing'
                WHERE zotero_key = ?`, [key]);
        }
        await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: 'DELETED1',
            contentKind: 'pdf', errorCode: null, attemptedAt: 200 });
        await connection.queryAsync(`UPDATE attachment_processing_state
            SET upsert_status = 'done', upsert_remote_identity='{"index_account_id":"account-a","index_scope_ref":"lLOCAL123","index_local_id":"LOCAL123"}', structured_document_hash = ? WHERE zotero_key = 'CHILDPDF'`, ['a'.repeat(64)]);
        vi.stubGlobal('Zotero', { ...Zotero,
            DB: { queryAsync: connection.queryAsync.bind(connection) },
            Libraries: { getAll: () => [{ libraryID: 1, libraryType: 'user' }, { libraryID: 9, libraryType: 'group' }] },
        });
        // An unchanged index cursor must not hide deletions outside the index inventory.
        vi.spyOn(reconciler as any, 'readLibraryCursor').mockResolvedValue({ maxClientDateModified: null, attachmentCount: 0 });
        await db.upsertProcessingIndexState({ libraryId: 1, maxClientDateModified: null,
            attachmentCount: 0, ledgerRowCount: 0, lastScanTimestamp: Date.now() });
        reconciler.start();
        await (reconciler as any).run(false);

        expect((await db.getAttachmentReadingKeysByLibrary(1)).sort()).toEqual(['LIVEPDF1', 'LIVETEXT']);
        expect(await db.getAttachmentReadingKeysByLibrary(9)).toEqual(['EXCLUDED']);
        expect(await db.getProcessingIssueRefs(ENTITLED, 'file_unavailable')).toEqual([
            { libraryId: 1, zoteroKey: 'LIVEPDF1' }, { libraryId: 1, zoteroKey: 'LIVETEXT' },
            { libraryId: 9, zoteroKey: 'EXCLUDED' },
        ]);
        expect(await db.getAttachmentProcessingStatesByLibrary(1)).toEqual([]);
        expect(await db.peekBackgroundJobs()).toEqual([
            expect.objectContaining({ jobType: 'fulltext_untag', zoteroKey: 'CHILDPDF',
                payload: expect.objectContaining({ doc_hash: 'a'.repeat(64) }) }),
        ]);
        expect(invalidate).toHaveBeenCalledWith(1, 'DELETED1');
        expect(invalidate).toHaveBeenCalledWith(1, 'CHILDPDF');
    });

    it('excludes trashed parents from enumeration and cursor counts even when item trash checks cannot load parents', async () => {
        await connection.queryAsync('CREATE TABLE items (itemID INTEGER PRIMARY KEY, libraryID INTEGER, key TEXT, clientDateModified TEXT)');
        await connection.queryAsync('CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INTEGER, linkMode INTEGER, contentType TEXT)');
        await connection.queryAsync('CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY)');
        await connection.queryAsync("INSERT INTO items VALUES (10,1,'PARENT01','2026'), (11,1,'CHILD001','2026'), (12,1,'LIVE0001','2026')");
        await connection.queryAsync("INSERT INTO itemAttachments VALUES (11,10,0,'application/pdf'), (12,NULL,0,'application/pdf')");
        await connection.queryAsync('INSERT INTO deletedItems VALUES (10)');
        const getAsync = vi.fn(async (ids: number[]) => ids.map(id => ({ id, isInTrash() { throw new Error('parent unloaded'); } })));
        vi.stubGlobal('Zotero', { ...Zotero, DB: { queryAsync: connection.queryAsync.bind(connection) },
            Attachments: { LINK_MODE_LINKED_URL: 3 }, Items: { getAsync } });
        expect(await (reconciler as any).readLibraryCursor(1)).toMatchObject({ attachmentCount: 1 });
        expect(await (reconciler as any).listProcessableAttachments(1)).toHaveLength(1);
        expect(getAsync).toHaveBeenCalledWith([12]);
        getAsync.mockResolvedValueOnce([false] as any);
        await expect((reconciler as any).listProcessableAttachments(1)).resolves.toEqual([]);
        getAsync.mockResolvedValueOnce([]);
        await expect((reconciler as any).listProcessableAttachments(1)).resolves.toEqual([]);
    });

    it('targets children after parent edits without re-enumerating the library', async () => {
        await connection.queryAsync('CREATE TABLE items (itemID INTEGER PRIMARY KEY, libraryID INTEGER, key TEXT, clientDateModified TEXT)');
        await connection.queryAsync('CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INTEGER, linkMode INTEGER, contentType TEXT)');
        await connection.queryAsync('CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY)');
        await connection.queryAsync("INSERT INTO items VALUES (10,1,'PARENT01','2026'), (11,1,'CHILD001','2025')");
        await connection.queryAsync("INSERT INTO itemAttachments VALUES (11,10,0,'application/pdf')");
        const parent = { id: 10, libraryID: 1, key: 'PARENT01', isAttachment: () => false };
        const child = { id: 11, libraryID: 1, key: 'CHILD001', parentID: 10, isAttachment: () => true };
        vi.stubGlobal('Zotero', { ...Zotero, DB: { queryAsync: connection.queryAsync.bind(connection) },
            Attachments: { LINK_MODE_LINKED_URL: 3 }, Items: { getAsync: vi.fn(async id => id === 10 ? parent : child) } });
        const readiness = { beginChanges: vi.fn(() => 1), completeChanges: vi.fn(), updateAttachment: vi.fn(), invalidateLibrary: vi.fn() };
        (Zotero.Beaver as any).background = { searchReadiness: readiness, beginProcessingDiscovery: vi.fn() };
        const check = vi.spyOn(reconciler as any, 'reconcileAttachment').mockResolvedValue(undefined);
        const scan = vi.spyOn(reconciler as any, 'listProcessableAttachments');
        reconciler.start();
        reconciler.notifyAttachments([{ id: 10, event: 'modify' }]);
        await (reconciler as any).reconcileNotifiedAttachments(db, (reconciler as any).generation);
        expect(check).toHaveBeenCalledTimes(1);
        expect(check.mock.calls[0][1]).toBe(child);
        expect(readiness.invalidateLibrary).not.toHaveBeenCalled();
        expect(scan).not.toHaveBeenCalled();
        expect((await (reconciler as any).readLibraryCursor(1)).maxClientDateModified).toBe('2025');
    });

    it('immediately retries inventory rejected after a scope invalidation', async () => {
        vi.spyOn(reconciler as any, 'reconcileReadingState').mockResolvedValue(undefined);
        vi.spyOn(reconciler as any, 'readLibraryCursor').mockResolvedValue({ maxClientDateModified: '', attachmentCount: 0 });
        vi.spyOn(reconciler as any, 'listProcessableAttachments').mockResolvedValue([]);
        const readiness = { membershipFence: () => 1, hasInventory: () => false, discoveryFence: () => 1, invalidateLibrary: vi.fn(),
            publishInventory: vi.fn(() => false), completeChanges: vi.fn(), invalidateInventory: vi.fn() };
        (Zotero.Beaver as any).background = { searchReadiness: readiness, beginProcessingDiscovery: vi.fn() };
        vi.stubGlobal('Zotero', { ...Zotero, Libraries: { getAll: () => [{ libraryID: 1, libraryType: 'user' }] } });
        reconciler.start();
        const schedule = vi.spyOn(reconciler as any, 'schedule');
        await (reconciler as any).run(false);
        expect(readiness.publishInventory).toHaveBeenCalled();
        expect(schedule).toHaveBeenLastCalledWith(0, false);
        expect((reconciler as any).nextScanAt).toBe(0);
    });

    it('handles parent and child deletes without invalidating the library', async () => {
        const readiness = { beginChanges: vi.fn(() => 1), completeChanges: vi.fn(), updateAttachment: vi.fn(), invalidateLibrary: vi.fn() };
        (Zotero.Beaver as any).background = { searchReadiness: readiness };
        const remove = vi.spyOn(reconciler as any, 'removeAttachment').mockResolvedValue(undefined);
        reconciler.start();
        (reconciler as any).nextScanAt = Date.now() + 300000;
        const deadline = (reconciler as any).nextScanAt;
        reconciler.notifyAttachments([
            { id: 10, event: 'delete', extra: { libraryID: 1, key: 'PARENT01' } },
            { id: 11, event: 'delete', extra: { libraryID: 1, key: 'CHILD001' } },
        ]);
        await (reconciler as any).reconcileNotifiedAttachments(db, (reconciler as any).generation);
        expect(remove).toHaveBeenCalledWith(db, 1, 'CHILD001');
        expect(readiness.updateAttachment).toHaveBeenCalledWith(1, 'CHILD001', false);
        expect(readiness.invalidateLibrary).not.toHaveBeenCalled();
        expect((reconciler as any).nextScanAt).toBe(deadline);
    });

    function installReadiness(libraryIds = [1]) {
        const readiness = new SearchReadiness();
        Object.assign(Zotero.Beaver, {
            account: { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'account' } } }) },
            searchableLibraryIds: libraryIds,
            background: { searchReadiness: readiness, beginProcessingDiscovery: vi.fn() },
            processingReconciler: reconciler,
        });
        readiness.setRequirements({ index_version: 3, index_validity: 'current', index_incarnation: 'epoch',
            extract_schema_versions: { pdf: ['4'], epub: ['1'], snapshot: ['1'] } });
        for (const id of libraryIds) readiness.publishInventory(id, [], readiness.discoveryFence());
        return readiness;
    }

    it.each([false, true])('releases a suspended watcher hold after the full pass, but preserves a newer hold=%s', async newer => {
        vi.useFakeTimers();
        const readiness = installReadiness();
        const watcher = new NewItemWatcher();
        let observer: any;
        vi.stubGlobal('Zotero', { ...Zotero,
            Libraries: { getAll: () => [{ libraryID: 1, libraryType: 'user' }] },
            Notifier: { registerObserver: vi.fn(value => { observer = value; return 'maintenance-watcher'; }), unregisterObserver: vi.fn() },
        });
        vi.spyOn(reconciler as any, 'reconcileReadingState').mockResolvedValue(undefined);
        vi.spyOn(reconciler as any, 'readLibraryCursor').mockResolvedValue({ maxClientDateModified: '', attachmentCount: 0 });
        vi.spyOn(reconciler as any, 'listProcessableAttachments').mockImplementation(async () => {
            if (newer) readiness.beginChanges();
            return [];
        });
        try {
            reconciler.start();
            watcher.start();
            const resume = await reconciler.suspendForMaintenance();
            observer.notify('modify', 'item', [13], { 13: { libraryID: 1, key: 'INDEXED1' } });
            await vi.advanceTimersByTimeAsync(500);
            expect((reconciler as any).pendingAttachments.size).toBe(0);
            expect(readiness.getSummary()).toBeNull();
            const held = readiness.membershipFence();
            expect(readiness.membershipFence()).toBe(held);
            resume();
            await (reconciler as any).run(false);
            await readiness.refresh();
            if (newer) expect(readiness.getSummary()).toBeNull();
            else expect(readiness.getSummary()?.libraries[0].discovery_complete).toBe(true);
        } finally {
            watcher.stop(); reconciler.stop(); readiness.dispose(); vi.useRealTimers();
        }
    });

    it('does not release a batch discarded by suspension before a successful full pass', async () => {
        vi.useFakeTimers();
        const readiness = installReadiness();
        vi.stubGlobal('Zotero', { ...Zotero,
            Libraries: { getAll: () => [{ libraryID: 1, libraryType: 'user' }] },
        });
        vi.spyOn(reconciler as any, 'reconcileReadingState').mockRejectedValueOnce(new Error('temporary read failure'));
        try {
            reconciler.start();
            reconciler.notifyAttachments([{ id: 13, event: 'modify', extra: { libraryID: 1, key: 'INDEXED1' } }]);
            const resume = await reconciler.suspendForMaintenance();
            resume();
            await (reconciler as any).run(false);
            expect(readiness.getSummary()).toBeNull();
        } finally { reconciler.stop(); readiness.dispose(); vi.useRealTimers(); }
    });

    it.each(['attachment', 'library'])('preserves unrelated inventories after a %s failure', async path => {
        vi.useFakeTimers();
        const readiness = installReadiness([1, 2]);
        vi.stubGlobal('Zotero', { ...Zotero,
            Libraries: { getAll: () => [1, 2].map(libraryID => ({ libraryID, libraryType: 'user' })) },
        });
        try {
            reconciler.start();
            if (path === 'attachment') {
                vi.spyOn(reconciler as any, 'removeAttachment').mockRejectedValueOnce(new Error('temporary write failure'));
                reconciler.notifyAttachments([{ id: 13, event: 'delete', extra: { libraryID: 1, key: 'INDEXED1' } }]);
                await (reconciler as any).reconcileNotifiedAttachments(db, (reconciler as any).generation);
            } else {
                vi.spyOn(reconciler as any, 'reconcileReadingState').mockRejectedValueOnce(new Error('temporary read failure'));
                await (reconciler as any).run(false);
            }
            expect(readiness.hasInventory(1)).toBe(path === 'attachment');
            expect(readiness.hasInventory(2)).toBe(true);
        } finally { reconciler.stop(); readiness.dispose(); vi.useRealTimers(); }
    });

    it('retries a transient deletion with backoff without resurrecting the key or enumerating', async () => {
        vi.useFakeTimers();
        const readiness = installReadiness();
        readiness.publishInventory(1, ['INDEXED1'], readiness.discoveryFence());
        const remove = vi.spyOn(reconciler as any, 'removeAttachment').mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined);
        const enumerate = vi.spyOn(reconciler as any, 'reconcileLibrary');
        try {
            reconciler.start();
            (reconciler as any).nextScanAt = Date.now() + 300000;
            reconciler.notifyAttachments([{ id: 13, event: 'delete', extra: { libraryID: 1, key: 'INDEXED1' } }]);
            await vi.advanceTimersByTimeAsync(1);
            expect(remove).toHaveBeenCalledTimes(1);
            expect(readiness.hasInventory(1)).toBe(true);
            expect(readiness.getSummary()?.libraries[0]).toMatchObject({ indexed: 0, pending: 0, unavailable: 0 });
            await vi.advanceTimersByTimeAsync(998);
            expect(remove).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(2);
            expect(remove).toHaveBeenCalledTimes(2);
            expect(readiness.getSummary()?.libraries[0]).toMatchObject({ indexed: 0, pending: 0, unavailable: 0 });
            expect(enumerate).not.toHaveBeenCalled();
        } finally { reconciler.stop(); readiness.dispose(); vi.useRealTimers(); }
    });

    it('retains an added attachment when its initial lookups fail', async () => {
        vi.useFakeTimers();
        const readiness = installReadiness();
        vi.stubGlobal('Zotero', { ...Zotero,
            Items: { getAsync: vi.fn().mockRejectedValue(new Error('temporarily unavailable')) },
            DB: { queryAsync: vi.fn(async (_sql, _params, options) => options.onRow({ getResultByIndex: (i: number) => i === 0 ? 1 : 'INDEXED1' })) },
        });
        try {
            reconciler.start();
            reconciler.notifyAttachments([{ id: 13, event: 'add', extra: { libraryID: 1, key: 'INDEXED1' } }]);
            await (reconciler as any).reconcileNotifiedAttachments(db, (reconciler as any).generation);
            expect((reconciler as any).pendingAttachments.get(13)?.event).toBe('add');
            expect(readiness.hasInventory(1)).toBe(true);
            expect(readiness.getSummary()).toBeNull();
        } finally { reconciler.stop(); readiness.dispose(); vi.useRealTimers(); }
    });

    it('falls back to only the affected inventory after bounded targeted retries exhaust', async () => {
        vi.useFakeTimers();
        const readiness = installReadiness([1, 2]);
        vi.spyOn(reconciler as any, 'removeAttachment').mockRejectedValue(new Error('busy'));
        try {
            reconciler.start();
            reconciler.notifyAttachments([{ id: 13, event: 'delete', extra: { libraryID: 1, key: 'INDEXED1' } }]);
            for (let i = 0; i < 4; i++) await (reconciler as any).reconcileNotifiedAttachments(db, (reconciler as any).generation);
            expect((reconciler as any).pendingAttachments.size).toBe(0);
            expect(readiness.hasInventory(1)).toBe(false);
            expect(readiness.hasInventory(2)).toBe(true);
        } finally { reconciler.stop(); readiness.dispose(); vi.useRealTimers(); }
    });

    it('revisits unchanged libraries once when OCR access changes without replaying native successes', async () => {
        const scan = items.get('1-MISSING1')!;
        const native = items.get('1-INDEXED1')!;
        for (const item of [scan, native]) {
            await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: item.key, itemId: item.id, contentKind: 'pdf' });
        }
        await connection.queryAsync("UPDATE attachment_processing_state SET extract_status='done', extract_schema_version=?, ocr_status='na'", [expectedExtractionSchemaVersion('pdf')]);
        await connection.queryAsync("UPDATE attachment_processing_state SET ocr_status='needed' WHERE zotero_key='MISSING1'");
        vi.spyOn(reconciler as any, 'reconcileReadingState').mockResolvedValue(undefined);
        vi.spyOn(reconciler as any, 'readLibraryCursor').mockResolvedValue({ maxClientDateModified: 'same', attachmentCount: 2 });
        vi.spyOn(reconciler as any, 'listProcessableAttachments').mockResolvedValue([scan, native]);
        Zotero.Beaver.hasOcrAccess = false;
        reconciler.start();
        const run = () => (reconciler as any).reconcileLibrary(db, 1, false, (reconciler as any).generation);
        await run();
        expect(mocks.maybeEnqueueOcrJob).not.toHaveBeenCalled();
        Zotero.Beaver.hasOcrAccess = true;
        await run();
        await run();
        expect(mocks.maybeEnqueueOcrJob).toHaveBeenCalledTimes(1);
        expect(mocks.maybeEnqueueOcrJob).toHaveBeenCalledWith(expect.objectContaining({ zoteroKey: scan.key }));
        expect(await db.peekBackgroundJobs()).toEqual([]);
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('retains both records when persisting deletion cleanup fails while paused', async () => {
        mocks.backgroundEnabled = false;
        await failedExtraction('INDEXED1', 'file_missing');
        await connection.queryAsync(`UPDATE attachment_processing_state
            SET upsert_status = 'done', upsert_remote_identity='{"index_account_id":"account-a","index_scope_ref":"lLOCAL123","index_local_id":"LOCAL123"}', structured_document_hash = ?`, ['a'.repeat(64)]);
        vi.stubGlobal('Zotero', { ...Zotero, DB: { queryAsync: vi.fn(async () => undefined) } });
        vi.spyOn(db, 'enqueueBackgroundJob').mockRejectedValueOnce(new Error('disk full'));

        reconciler.start();
        await expect((reconciler as any).reconcileReadingState(db, 1, (reconciler as any).generation))
            .rejects.toThrow('disk full');
        expect(await db.getAttachmentReadingError(1, 'INDEXED1')).toBe('file_missing');
        expect(await db.getAttachmentProcessingState(1, 'INDEXED1')).not.toBeNull();
        expect(invalidate).not.toHaveBeenCalled();
    });

    it('retries an on-demand-only failure with background processing off, without enabling a library sweep', async () => {
        mocks.backgroundEnabled = false;
        await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: 'MISSING1',
            contentKind: 'pdf', errorCode: 'file_missing', attemptedAt: 1 });
        expect(await db.getAttachmentProcessingState(1, 'MISSING1')).toBeNull();
        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'MISSING1' }])).toBe(1);
        const job = await db.claimNextBackgroundJob(Date.now(), 60_000);
        expect(job).toMatchObject({ zoteroKey: 'MISSING1', jobType: 'document_extract', priority: OCR_PRIORITY_ON_DEMAND });
        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([{ reason: 'file_unavailable', count: 1 }]);
        expect(mocks.backgroundEnabled).toBe(false);
    });

    it('retains an on-demand reading problem if queuing its retry fails', async () => {
        mocks.backgroundEnabled = false;
        await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: 'MISSING1',
            contentKind: 'pdf', errorCode: 'file_missing', attemptedAt: 1 });
        vi.spyOn(db, 'enqueueBackgroundJobs').mockRejectedValueOnce(new Error('queue unavailable'));
        await expect(reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'MISSING1' }])).rejects.toThrow('queue unavailable');
        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([{ reason: 'file_unavailable', count: 1 }]);
    });

    it('requeues a failed extraction, clears its dead letter and drains immediately', async () => {
        await failedExtraction('CRASHED1', 'worker_crashed');
        await connection.queryAsync(`INSERT INTO background_jobs_dead
            (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count)
            VALUES ('document_extract', 1, 'CRASHED1', 'pdf', 'structured', 0, 1, 3)`);
        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([{ reason: 'extract_failed', count: 1 }]);

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'CRASHED1' }])).toBe(1);

        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([{ reason: 'extract_failed', count: 1 }]);
        expect(await db.getBackgroundDeadLetters()).toEqual([]);
        // The cache remembers terminal verdicts; a retry must not re-read one.
        expect(invalidate).toHaveBeenCalledWith(1, 'CRASHED1');
        const row = await db.getAttachmentProcessingState(1, 'CRASHED1');
        expect(row).toMatchObject({ extractStatus: null, lastError: 'user_retry' });
        expect((await db.getBackgroundQueueStats(Date.now())).byJobType.document_extract ?? 0).toBe(1);
        expect(requestImmediateDrain).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledOnce();
    });

    it('re-fails a still-missing file on the spot so it stays listed as unavailable', async () => {
        await failedExtraction('MISSING1', 'file_missing', 'skipped');
        mocks.resolveAttachmentFileSource.mockResolvedValue({ kind: 'error', code: 'file_missing', message: 'gone' });

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'MISSING1' }])).toBe(1);

        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([{ reason: 'file_unavailable', count: 1 }]);
        expect((await db.getBackgroundQueueStats(Date.now())).pending).toBe(0);
    });

    it('tickets OCR directly for a failed OCR stage instead of re-running extraction', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'INDEXED1', itemId: 13, contentKind: 'pdf' });
        await connection.queryAsync(
            `UPDATE attachment_processing_state
             SET extract_status = 'done', extract_schema_version = ?, ocr_status = 'failed',
                 ocr_engine_version = ?, file_hash = ?, last_error = 'ocr_unexpected: boom'
             WHERE zotero_key = 'INDEXED1'`,
            [expectedExtractionSchemaVersion('pdf'), OCR_ENGINE_VERSION, 'f'.repeat(32)],
        );
        await db.recordDocumentProcessingFailure({
            fileHash: 'f'.repeat(32), task: 'ocr', engineVersion: OCR_ENGINE_VERSION, error: 'boom', terminalCode: 'boom',
        });
        await connection.queryAsync(`INSERT INTO background_jobs_dead
            (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count)
            VALUES ('document_ocr', 1, 'INDEXED1', 'pdf', 'structured', 0, 1, 3)`);
        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([{ reason: 'ocr_failed', count: 1 }]);

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'INDEXED1' }])).toBe(1);

        expect(await db.getAttachmentProcessingState(1, 'INDEXED1')).toMatchObject({
            extractStatus: 'done', ocrStatus: 'needed', lastError: 'user_retry',
        });
        expect(await db.getDocumentProcessingFailure('f'.repeat(32), 'ocr', OCR_ENGINE_VERSION)).toBeNull();
        expect(await db.getBackgroundDeadLetters()).toEqual([]);
        expect(mocks.enqueueOcrJob).toHaveBeenCalledWith(expect.objectContaining({
            libraryId: 1, zoteroKey: 'INDEXED1', priority: OCR_PRIORITY_ON_DEMAND,
        }));
        // The shortcut is only valid while the OCR executor can read a page count.
        expect(getMetadata).toHaveBeenCalledWith({ libraryId: 1, zoteroKey: 'INDEXED1' }, '/tmp/a.pdf');
        expect(invalidate).not.toHaveBeenCalled();
        expect((await db.getBackgroundQueueStats(Date.now())).byJobType.document_extract ?? 0).toBe(0);
        expect(requestImmediateDrain).toHaveBeenCalledOnce();
        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([]);
    });

    it.each([
        ['is missing', null],
        ['has no page count', { pageCount: null }],
    ])('restarts extraction for a failed OCR stage when the cached detection metadata %s', async (_label, meta) => {
        getMetadata.mockResolvedValueOnce(meta as any);
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'INDEXED1', itemId: 13, contentKind: 'pdf' });
        await connection.queryAsync(
            `UPDATE attachment_processing_state
             SET extract_status = 'done', extract_schema_version = ?, ocr_status = 'failed',
                 file_hash = ?, last_error = 'ocr_unexpected: boom'
             WHERE zotero_key = 'INDEXED1'`,
            [expectedExtractionSchemaVersion('pdf'), 'f'.repeat(32)],
        );

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'INDEXED1' }])).toBe(1);

        expect(await db.getAttachmentProcessingState(1, 'INDEXED1')).toMatchObject({
            extractStatus: null, ocrStatus: null, lastError: 'user_retry',
        });
        expect(invalidate).toHaveBeenCalledWith(1, 'INDEXED1');
        expect(mocks.enqueueOcrJob).not.toHaveBeenCalled();
        expect((await db.getBackgroundQueueStats(Date.now())).byJobType.document_extract ?? 0).toBe(1);
        expect(requestImmediateDrain).toHaveBeenCalledOnce();
    });

    it('restarts extraction when OCR failed because the file was unreachable', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'INDEXED1', itemId: 13, contentKind: 'pdf' });
        await connection.queryAsync(
            `UPDATE attachment_processing_state
             SET extract_status = 'done', extract_schema_version = ?, ocr_status = 'failed',
                 last_error = 'ocr_remote_download_failed: download_failed'
             WHERE zotero_key = 'INDEXED1'`,
            [expectedExtractionSchemaVersion('pdf')],
        );

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'INDEXED1' }])).toBe(1);

        expect(await db.getAttachmentProcessingState(1, 'INDEXED1')).toMatchObject({ extractStatus: null, ocrStatus: null });
        expect(invalidate).toHaveBeenCalledWith(1, 'INDEXED1');
        expect(mocks.enqueueOcrJob).not.toHaveBeenCalled();
        expect((await db.getBackgroundQueueStats(Date.now())).byJobType.document_extract ?? 0).toBe(1);
    });

    it.each(['na', 'done'] as const)('requeues only the index stage after upload failure with OCR status %s', async (ocrStatus) => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'INDEXED1', itemId: 13, contentKind: 'pdf' });
        await connection.queryAsync(
            `UPDATE attachment_processing_state
             SET extract_status = 'done', extract_schema_version = ?, ocr_status = ?, ocr_engine_version = ?,
                 upsert_status = 'failed', structured_document_hash = ?, last_error = 'index_unreachable'
             WHERE zotero_key = 'INDEXED1'`,
            [expectedExtractionSchemaVersion('pdf'), ocrStatus, OCR_ENGINE_VERSION, 'c'.repeat(64)],
        );
        if (ocrStatus === 'done') {
            await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: 'INDEXED1',
                contentKind: 'pdf', errorCode: 'ocr_required', attemptedAt: 1 });
        }
        await db.recordDocumentProcessingFailure({ fileHash: 'c'.repeat(64), task: 'fulltext_upsert', error: 'index_unreachable' });
        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([{ reason: 'index_failed', count: 1 }]);

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'INDEXED1' }])).toBe(1);

        expect(await db.getAttachmentProcessingState(1, 'INDEXED1')).toMatchObject({
            extractStatus: 'done', ocrStatus, upsertStatus: null, lastError: 'user_retry',
            structuredDocumentHash: 'c'.repeat(64),
        });
        expect(await db.getAttachmentReadingError(1, 'INDEXED1')).toBe(ocrStatus === 'done' ? 'ocr_required' : null);
        expect(await db.getProcessingIssueCounts(ENTITLED)).toEqual([]);
        expect(await db.getDocumentProcessingFailure('c'.repeat(64), 'fulltext_upsert')).toBeNull();
        expect(invalidate).not.toHaveBeenCalled();
        const stats = await db.getBackgroundQueueStats(Date.now());
        expect(stats.byJobType.fulltext_upsert ?? 0).toBe(1);
        expect(stats.byJobType.document_extract ?? 0).toBe(0);
        expect(mocks.enqueueOcrJob).not.toHaveBeenCalled();
        expect(mocks.maybeEnqueueOcrJob).not.toHaveBeenCalled();
    });

    it('still restarts extraction for a new reading failure after completed OCR', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'INDEXED1', itemId: 13, contentKind: 'pdf' });
        await connection.queryAsync(
            `UPDATE attachment_processing_state SET extract_status='done', extract_schema_version=?,
                ocr_status='done', ocr_engine_version=?, upsert_status='failed'
             WHERE zotero_key='INDEXED1'`,
            [expectedExtractionSchemaVersion('pdf'), OCR_ENGINE_VERSION],
        );
        await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: 'INDEXED1',
            contentKind: 'pdf', errorCode: 'invalid_pdf', attemptedAt: 1 });

        expect(await reconciler.retryAttachments([{ libraryId: 1, zoteroKey: 'INDEXED1' }])).toBe(1);

        expect(invalidate).toHaveBeenCalledWith(1, 'INDEXED1');
        expect(await db.getAttachmentReadingError(1, 'INDEXED1')).toBe('invalid_pdf');
        const stats = await db.getBackgroundQueueStats(Date.now());
        expect(stats.byJobType.document_extract ?? 0).toBe(1);
        expect(stats.byJobType.fulltext_upsert ?? 0).toBe(0);
    });

    it('skips excluded libraries, missing items and unknown ledger rows without draining', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 9, zoteroKey: 'EXCLUDED', itemId: 14, contentKind: 'pdf' });
        await db.markAttachmentExtractFailure({ attemptedAt: Date.now(), libraryId: 9, zoteroKey: 'EXCLUDED', status: 'failed', error: 'boom' });

        expect(await reconciler.retryAttachments([
            { libraryId: 9, zoteroKey: 'EXCLUDED' },
            { libraryId: 1, zoteroKey: 'NOSUCHIT' },
            { libraryId: 1, zoteroKey: 'CRASHED1' },
        ])).toBe(0);

        expect(await db.getAttachmentProcessingState(9, 'EXCLUDED')).toMatchObject({ extractStatus: 'failed' });
        expect((await db.getBackgroundQueueStats(Date.now())).pending).toBe(0);
        expect(requestImmediateDrain).not.toHaveBeenCalled();
    });
});

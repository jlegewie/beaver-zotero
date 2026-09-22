import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { classifySearchPreparation, getSearchIndexState, type SearchPreparationRow } from '../../../src/services/searchIndexState';
import { expectedExtractionSchemaVersion } from '../../../src/services/documentExtraction/shared/extractionSchemaVersions';
import { EXPECTED_SEARCH_INDEX_VERSION } from '../../../src/services/backgroundProcessing/constants';

const identity = { accountId: 'account', localId: 'LOCAL123', scopeRef: 'lLOCAL123' };
const row = (extra: Partial<SearchPreparationRow> = {}): SearchPreparationRow => ({
    libraryId: 1, key: 'ABCDEFGH', contentKind: 'pdf', extractStatus: 'done',
    extractSchemaVersion: expectedExtractionSchemaVersion('pdf'), ocrStatus: 'na',
    upsertStatus: 'done', upsertIndexVersion: String(EXPECTED_SEARCH_INDEX_VERSION),
    remoteIdentity: JSON.stringify({ index_account_id: 'account', index_scope_ref: 'lLOCAL123', index_local_id: 'LOCAL123' }),
    error: null, readingSucceeded: false, ...extra,
});

describe('search preparation classification', () => {
    it('uses acknowledged membership even when local reading is unavailable', () => {
        expect(classifySearchPreparation(row({ error: 'file_missing' }), identity)).toBe('indexed');
    });
    it.each([
        { upsertStatus: null }, { remoteIdentity: '{}' }, { remoteIdentity: 'invalid' },
        { extractSchemaVersion: 'old' }, { upsertIndexVersion: '0' }, { extractStatus: null },
    ])('keeps incomplete or incompatible evidence pending: %j', extra => {
        expect(classifySearchPreparation(row(extra), identity)).toBe('pending');
    });
    it.each(['encrypted', 'file_missing', 'invalid_pdf', 'too_many_pages', 'wrapper: encrypted', 'ocr_remote_download_failed: file_missing', 'ocr_no_text: no usable text', 'OCR produced no usable text layer'])('excludes settled %s limitations', error => {
        expect(classifySearchPreparation(row({ extractStatus: 'failed', error }), identity)).toBe('unavailable');
    });
    it.each(['download_failed', 'read_failed', 'extraction_failed', 'ocr_required', 'unsupported_schema_version', 'wrapper: encrypted_extra', 'ocr_backend_failed: download_failed'])('does not shrink the denominator for %s', error => {
        expect(classifySearchPreparation(row({ extractStatus: 'failed', error }), identity)).toBe('pending');
    });
    it('excludes settled EPUB limitations without changing PDF retry semantics', () => {
        expect(classifySearchPreparation(row({
            contentKind: 'epub', extractStatus: 'failed', error: 'no_text_layer',
        }), identity)).toBe('unavailable');
        expect(classifySearchPreparation(row({
            contentKind: 'snapshot', extractStatus: 'failed', error: 'no_text_layer',
        }), identity)).toBe('unavailable');
        expect(classifySearchPreparation(row({
            contentKind: 'epub', extractStatus: 'failed', error: 'permanent_epub:extraction_failed',
        }), identity)).toBe('unavailable');
        expect(classifySearchPreparation(row({
            contentKind: 'epub', extractStatus: 'failed', error: 'extraction_failed',
        }), identity)).toBe('pending');
        expect(classifySearchPreparation(row({
            contentKind: 'pdf', extractStatus: 'failed', error: 'no_text_layer',
        }), identity)).toBe('pending');
    });
    it('keeps retries and superseded reading failures pending', () => {
        expect(classifySearchPreparation(row({ extractStatus: null, error: 'encrypted' }), identity)).toBe('pending');
        expect(classifySearchPreparation(row({ extractStatus: 'failed', error: 'encrypted', readingSucceeded: true }), identity)).toBe('pending');
    });
    it('counts recoverable OCR admission closure as unavailable while preserving stronger evidence', () => {
        const unavailable = row({
            ocrStatus: 'needed', upsertStatus: null, error: 'ocr_service_unavailable',
        });
        expect(classifySearchPreparation(unavailable, identity)).toBe('unavailable');
        expect(classifySearchPreparation({ ...unavailable, readingSucceeded: true }, identity)).toBe('pending');
        expect(classifySearchPreparation(row({ error: 'ocr_service_unavailable' }), identity)).toBe('indexed');
    });
});

describe('send-time search snapshot', () => {
    let ledger: MockDBConnection;
    let inventory: MockDBConnection;
    let db: BeaverDB;
    beforeEach(async () => {
        ledger = new MockDBConnection(); inventory = new MockDBConnection();
        db = new BeaverDB(ledger); await db.initDatabase('0.99.0');
        await inventory.queryAsync('CREATE TABLE items (itemID INTEGER PRIMARY KEY, libraryID INTEGER, key TEXT)');
        await inventory.queryAsync('CREATE TABLE itemAttachments (itemID INTEGER PRIMARY KEY, parentItemID INTEGER, linkMode INTEGER, contentType TEXT)');
        await inventory.queryAsync('CREATE TABLE deletedItems (itemID INTEGER PRIMARY KEY)');
        Object.assign(Zotero, {
            DB: inventory,
            Users: { getLocalUserKey: () => 'LOCAL123', getCurrentUserID: () => null },
            Libraries: { userLibraryID: 1, get: () => ({ libraryType: 'user' }) },
            Attachments: { LINK_MODE_LINKED_URL: 3 },
            Beaver: { data: { env: 'production' }, db, hasSearchIndexAccess: true, libraryScopeInitialized: true, searchableLibraryIds: [1],
                account: { getGeneration: () => 1, getSnapshot: () => ({ session: { user: { id: 'account' } } }) } },
        });
    });
    afterEach(async () => { await ledger.closeDatabase(); await inventory.closeDatabase(); vi.restoreAllMocks(); });
    async function add(id: number, options: { mode?: number; mime?: string; parent?: number } = {}) {
        const key = String(id).padStart(8, '0');
        await inventory.queryAsync('INSERT INTO items VALUES (?, ?, ?)', [id, 1, key]);
        await inventory.queryAsync('INSERT INTO itemAttachments VALUES (?, ?, ?, ?)', [id, options.parent ?? 0, options.mode ?? 0, options.mime ?? 'application/pdf']);
        return key;
    }
    it('counts undiscovered attachments and ignores stale successes, URLs, trash and unsupported files', async () => {
        await add(1); await add(2, { mode: 3 }); await add(3, { mime: 'text/plain' }); await add(4); await add(5, { parent: 9 });
        await inventory.queryAsync('INSERT INTO deletedItems VALUES (4), (9)');
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'STALEKEY', contentKind: 'pdf' });
        expect(await getSearchIndexState()).toEqual({ version: 1, libraries: [{ library_ref: 'u', total: 1, indexed: 0, unavailable: 0 }] });
        await add(6);
        expect((await getSearchIndexState())?.libraries[0].total).toBe(2);
    });
    it('joins reading success and does not reuse unavailable outcomes after reset', async () => {
        const key = await add(1);
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: key, contentKind: 'pdf' });
        await db.markAttachmentExtractFailure({ libraryId: 1, zoteroKey: key, status: 'failed', error: 'encrypted', attemptedAt: 1 });
        expect((await getSearchIndexState())?.libraries[0].unavailable).toBe(1);
        await db.resetAttachmentExtraction(1, key);
        expect((await getSearchIndexState())?.libraries[0].unavailable).toBe(0);
    });
    it('omits without eligibility and on scope/account changes or read errors', async () => {
        const read = vi.spyOn(db, 'getSearchPreparationRows');
        Zotero.Beaver!.hasSearchIndexAccess = false;
        expect(await getSearchIndexState()).toBeUndefined(); expect(read).not.toHaveBeenCalled();
        Zotero.Beaver!.hasSearchIndexAccess = true;
        read.mockImplementation(async () => { Zotero.Beaver!.searchableLibraryIds = []; return []; });
        expect(await getSearchIndexState()).toBeUndefined();
        read.mockRejectedValue(new Error('db unavailable'));
        expect(await getSearchIndexState()).toBeUndefined();
    });
    it.each(['getGeneration', 'getSnapshot'] as const)('omits if %s fails before a database read', async method => {
        vi.spyOn(Zotero.Beaver!.account!, method).mockImplementation(() => { throw new Error('account unavailable'); });
        expect(await getSearchIndexState()).toBeUndefined();
    });
    it('drops a snapshot if account generation changes while reading', async () => {
        let generation = 1;
        vi.spyOn(Zotero.Beaver!.account!, 'getGeneration').mockImplementation(() => generation);
        vi.spyOn(db, 'getSearchPreparationRows').mockImplementation(async () => { generation++; return []; });
        expect(await getSearchIndexState()).toBeUndefined();
    });
    it('reads a 20,000-attachment inventory without per-attachment queries', async () => {
        await inventory.queryAsync(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20000)
            INSERT INTO items SELECT x, 1, printf('%08d', x) FROM n`);
        await inventory.queryAsync("INSERT INTO itemAttachments SELECT itemID, 0, 0, 'application/pdf' FROM items");
        await ledger.queryAsync(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<20000)
            INSERT INTO attachment_processing_state (library_id, zotero_key, content_kind, extract_status,
                extract_schema_version, upsert_status, upsert_index_version, upsert_remote_identity)
            SELECT 1, printf('%08d', x), 'pdf', 'done', ?, 'done', ?, ? FROM n`,
            [expectedExtractionSchemaVersion('pdf'), String(EXPECTED_SEARCH_INDEX_VERSION), row().remoteIdentity]);
        const inventoryRead = vi.spyOn(inventory, 'queryAsync');
        const ledgerRead = vi.spyOn(ledger, 'queryAsync');
        const start = performance.now();
        expect((await getSearchIndexState())?.libraries[0]).toMatchObject({ total: 20000, indexed: 20000, unavailable: 0 });
        console.info(`20k snapshot (SQLite test adapter): ${(performance.now() - start).toFixed(1)}ms`);
        expect(inventoryRead).toHaveBeenCalledTimes(1); expect(ledgerRead).toHaveBeenCalledTimes(1);
    });
});

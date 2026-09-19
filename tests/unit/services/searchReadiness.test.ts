import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewItemWatcher } from '../../../src/services/backgroundProcessing/newItemWatcher';
import { SearchReadiness, classifyPreparation } from '../../../src/services/backgroundProcessing/searchReadiness';
import { reconcileRemoteRefs } from '../../../src/services/backgroundProcessing/remoteRefsReconcile';
import { BeaverDB, type AttachmentProcessingStateRecord } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import type { IndexRequirements } from '../../../src/services/searchIndex/searchIndexApiClient';

const mocks = vi.hoisted(() => ({ requirements: vi.fn(), verify: vi.fn() }));
vi.mock('../../../src/services/searchIndex/searchIndexApiClient', () => ({ searchIndexApiClient: mocks }));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getIndexScopeRef: (id: number) => id === 1 ? 'lLOCAL123' : `g${id}`,
    getZoteroUserIdentifier: () => ({ localUserKey: 'LOCAL123' }),
}));
vi.mock('../../../src/services/backgroundProcessing/utils', () => ({
    backgroundProcessingEnabled: () => true,
    isBackgroundProcessingLibraryEnabled: () => true,
    buildIndexJobPayload: (_kind: string, data: any) => ({ doc_hash: data.docHash }),
}));
vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

const requirements: IndexRequirements = { index_version: 3, index_validity: 'current', index_incarnation: 'epoch',
    extract_schema_versions: { pdf: ['4'], epub: ['1'], snapshot: ['1'] } };
const indexed = { libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf',
    extractStatus: 'done', structuredDocumentHash: 'hash', extractSchemaVersion: '4',
    upsertStatus: 'done', upsertIndexVersion: '3',
    upsertRemoteIdentity: { index_account_id: 'account', index_scope_ref: 'lLOCAL123', index_local_id: 'LOCAL123', index_incarnation: 'epoch' },
} as AttachmentProcessingStateRecord;
let service: SearchReadiness;
let owner: any;
let rows: AttachmentProcessingStateRecord[];
let account: string;
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    account = 'account';
    rows = [structuredClone(indexed)];
    owner = { libraryScopeInitialized: true, searchableLibraryIds: [1], hasSearchIndexAccess: true,
        account: { getSnapshot: () => ({ session: { user: { id: account } } }), getGeneration: () => account },
        db: { getAttachmentProcessingStatesByLibrary: vi.fn(async () => rows),
            getAttachmentReadingErrorsByLibrary: vi.fn(async () => new Map()),
            getAttachmentIndexRecoveryCandidates: vi.fn(async (_lib, _identity, limit) => rows.slice(0, limit)), enqueueBackgroundJobs: vi.fn() },
        backgroundExtractor: { notify: vi.fn() },
    };
    (Zotero as any).Beaver = owner;
    service = new SearchReadiness();
    owner.background = { searchReadiness: service };
    mocks.requirements.mockResolvedValue(requirements);
    service.setRequirements(requirements);
});
afterEach(() => { service.dispose(); vi.useRealTimers(); });

it.each(['network_error', 'not_entitled', 'retry_exhausted', 'unsupported_schema_version', 'extraction_failed', 'download_failed', 'ocr_geometry_mismatch', 'page_count_mismatch', 'unknown_ocr_error'])('keeps %s pending', code => {
    const row = { ...indexed, extractStatus: 'failed' as const, lastError: code };
    expect(classifyPreparation(row, code, requirements, 'account', 'lLOCAL123', 'LOCAL123')).toBe('pending');
});
it.each(['encrypted', 'invalid_pdf', 'file_missing'])('classifies structured document reason %s, not prose', code => {
    const row = { ...indexed, extractStatus: 'failed' as const };
    expect(classifyPreparation(row, code, requirements, 'account', 'lLOCAL123', 'LOCAL123')).toEqual({ unavailable: code });
    expect(classifyPreparation(row, `${code}: message`, requirements, 'account', 'lLOCAL123', 'LOCAL123')).toBe('pending');
});
it('requires completed discovery and counts unknown inventory rows as pending', async () => {
    await service.refresh();
    expect(service.getSummary()?.libraries[0].discovery_complete).toBe(false);
    service.publishInventory(1, ['KEY00001', 'MISSING1'], service.discoveryFence());
    await service.refresh();
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 1, pending: 1, discovery_complete: true });
});
it('invalidates acknowledgements after reset but preserves rows during an outage', async () => {
    service.publishInventory(1, ['KEY00001'], service.discoveryFence());
    await service.refresh();
    service.setRequirements({ ...requirements, index_validity: 'unknown', index_incarnation: null });
    await service.refresh();
    expect(service.getSummary()).toBeNull();
    expect(rows[0].upsertStatus).toBe('done');
    service.setRequirements({ ...requirements, index_incarnation: 'new' });
    await service.refresh();
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 0, pending: 1 });
});
it('fences scopes but replays additions without rejecting discovery', async () => {
    const fence = service.discoveryFence();
    account = 'other';
    service.publishInventory(1, ['KEY00001'], fence);
    service.setRequirements(requirements);
    await service.refresh();
    expect(service.getSummary()?.libraries[0].discovery_complete).toBe(false);
    const beforeChange = service.discoveryFence();
    const change = service.beginChanges();
    expect(service.publishInventory(1, ['KEY00001'], beforeChange)).toBe(true);
    expect(service.getSummary()).toBeNull();
    service.updateAttachment(1, 'ADDED001', true);
    service.completeChanges(change);
    await service.refresh();
    expect(service.getSummary()?.libraries[0]).toMatchObject({ discovery_complete: true, pending: 2 });
    owner.searchableLibraryIds.push(42);
    expect(service.getSummary()).toBeNull();
});
it('updates small additions without another inventory and preserves successful state on idle reads', async () => {
    service.publishInventory(1, ['KEY00001'], service.discoveryFence());
    const fence = service.beginChanges();
    service.updateAttachment(1, 'NEW00001', true);
    expect(service.getSummary()).toBeNull();
    service.completeChanges(fence);
    await service.refresh();
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 1, pending: 1, discovery_complete: true });
    const calls = owner.db.getAttachmentProcessingStatesByLibrary.mock.calls.length;
    for (let i = 0; i < 100; i++) service.getSummary();
    expect(owner.db.getAttachmentProcessingStatesByLibrary).toHaveBeenCalledTimes(calls);
});
it('re-establishes inventory after restart and accepts zero-chunk acknowledgements', async () => {
    expect(classifyPreparation(indexed, undefined, requirements, 'account', 'lLOCAL123', 'LOCAL123')).toBe('indexed');
    service.publishInventory(1, ['KEY00001'], service.discoveryFence());
    await service.refresh();
    service.dispose();
    service = new SearchReadiness();
    service.setRequirements(requirements);
    await service.refresh();
    expect(service.getSummary()?.libraries[0].discovery_complete).toBe(false);
});
it('limits recovery to fifty jobs and never verifies settled attachments', async () => {
    rows = Array.from({ length: 10000 }, (_, n) => ({ ...indexed, zoteroKey: String(n).padStart(8, '0'),
        upsertRemoteIdentity: { ...indexed.upsertRemoteIdentity!, index_incarnation: null } }));
    await reconcileRemoteRefs([1], () => false);
    expect(owner.db.enqueueBackgroundJobs.mock.calls[0][0]).toHaveLength(50);
    expect(mocks.verify).not.toHaveBeenCalled();
    mocks.requirements.mockResolvedValue({ ...requirements, index_validity: 'unknown', index_incarnation: null });
    owner.db.enqueueBackgroundJobs.mockClear();
    await reconcileRemoteRefs([1], () => false);
    expect(owner.db.enqueueBackgroundJobs).not.toHaveBeenCalled();
});
it('uses the current content-hash OCR failure code without parsing its message', async () => {
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    await db.initDatabase('0.99.0');
    const { OCR_ENGINE_VERSION } = await import('../../../src/services/ocr/constants');
    try {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf' });
        await connection.queryAsync("UPDATE attachment_processing_state SET extract_status = 'done', ocr_status = 'failed', file_hash = 'bytes'");
        await db.recordDocumentProcessingFailure({ fileHash: 'bytes', task: 'ocr', engineVersion: OCR_ENGINE_VERSION,
            error: 'A human explanation', terminalCode: 'encrypted_pdf' });
        const errors = await db.getAttachmentReadingErrorsByLibrary(1);
        expect(await db.getAttachmentReadingError(1, 'KEY00001')).toBe('encrypted_pdf');
        expect(errors.get('KEY00001')).toBe('encrypted_pdf');
        const row = await db.getAttachmentProcessingState(1, 'KEY00001');
        expect(classifyPreparation(row!, errors.get('KEY00001'), requirements, 'account', 'lLOCAL123', 'LOCAL123'))
            .toEqual({ unavailable: 'encrypted' });
        await connection.queryAsync("UPDATE attachment_processing_state SET file_hash = 'replacement'");
        expect((await db.getAttachmentReadingErrorsByLibrary(1)).has('KEY00001')).toBe(false);
    } finally { await connection.closeDatabase(); }
});
it('selects bounded recovery from SQLite while excluding queued and failed work', async () => {
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    await db.initDatabase('0.99.0');
    try {
        await connection.queryAsync(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<100)
            INSERT INTO attachment_processing_state (library_id,zotero_key,content_kind,structured_document_hash,
            extract_status,extract_schema_version,upsert_status,upsert_index_version,upsert_remote_identity)
            SELECT 1, printf('%08d',x), 'pdf', 'hash', 'done', '4', 'done', '3', ? FROM n`,
            [JSON.stringify({ ...indexed.upsertRemoteIdentity, index_incarnation: 'old' })]);
        const identity = { accountId: 'account', scopeRef: 'lLOCAL123', localId: 'LOCAL123', incarnation: 'epoch', indexVersion: 3 };
        expect(await db.getAttachmentIndexRecoveryCandidates(1, identity, 1000)).toHaveLength(50);
        await connection.queryAsync("UPDATE attachment_processing_state SET upsert_status = 'failed' WHERE zotero_key = '00000001'");
        await db.enqueueBackgroundJob({ jobType: 'fulltext_upsert', libraryId: 1, zoteroKey: '00000002',
            contentKind: 'pdf', payloadKind: 'structured', priority: 115, now: Date.now() });
        const candidates = await db.getAttachmentIndexRecoveryCandidates(1, identity, 50);
        expect(candidates).toHaveLength(50);
        expect(candidates.some(row => row.zoteroKey === '00000002')).toBe(false);
        expect(candidates.some(row => row.zoteroKey === '00000001')).toBe(true);
        await connection.queryAsync(`INSERT INTO background_jobs_dead
            (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count, payload_json)
            VALUES ('fulltext_upsert', 1, '00000001', 'pdf', 'structured', 0, 1, 3, ?)` ,
            [JSON.stringify({ recovery_incarnation: 'epoch' })]);
        expect((await db.getAttachmentIndexRecoveryCandidates(1, identity, 50)).some(row => row.zoteroKey === '00000001')).toBe(false);
        expect((await db.getAttachmentIndexRecoveryCandidates(1, { ...identity, incarnation: 'next' }, 50)).some(row => row.zoteroKey === '00000001')).toBe(true);
        expect((await db.getAttachmentIndexRecoveryCandidates(1, { ...identity, incarnation: null }, 50)).some(row => row.zoteroKey === '00000001')).toBe(false);
    } finally { await connection.closeDatabase(); }
});
it('measures a 10,000-attachment SQLite summary with zero per-document network requests', async () => {
    vi.useRealTimers();
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    await db.initDatabase('0.99.0');
    owner.db = db;
    const identity = JSON.stringify(indexed.upsertRemoteIdentity);
    await connection.queryAsync(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
        INSERT INTO attachment_processing_state (library_id,zotero_key,content_kind,structured_document_hash,
        extract_status,extract_schema_version,upsert_status,upsert_index_version,upsert_remote_identity)
        SELECT 1, printf('%08d',x), 'pdf', 'hash', 'done', '4', 'done', '3', ? FROM n`, [identity]);
    const reads = vi.spyOn(db, 'getAttachmentProcessingStatesByLibrary');
    const start = performance.now();
    service.publishInventory(1, Array.from({ length: 10000 }, (_, n) => String(n+1).padStart(8,'0')), service.discoveryFence());
    await service.refresh();
    const refreshMs = performance.now() - start;
    expect(service.getSummary()?.libraries[0].indexed).toBe(10000);
    const readCount = reads.mock.calls.length;
    const readStart = performance.now();
    for (let i = 0; i < 10000; i++) service.getSummary();
    const readsMs = performance.now() - readStart;
    await reconcileRemoteRefs([1], () => false);
    expect(reads).toHaveBeenCalledTimes(readCount);
    expect(mocks.requirements).toHaveBeenCalledTimes(1);
    expect(mocks.verify).not.toHaveBeenCalled();
    console.log(JSON.stringify({ attachments: 10000, refreshMs, summaryReads: 10000, readsMs,
        ledgerReads: readCount, requirementsCalls: 1, attachmentRequests: 0, indexQueries: 0 }));
    service.dispose();
    await connection.closeDatabase();
});

it('keeps ninety percent indexed while uploads continue and reads only changed keys', async () => {
    rows = Array.from({ length: 100 }, (_, n) => ({ ...indexed, zoteroKey: String(n) }));
    service.publishInventory(1, rows.map(r => r.zoteroKey), service.discoveryFence());
    await service.refresh();
    owner.db.getAttachmentProcessingStatesByLibrary.mockClear();
    service.changed(rows.slice(90).map(r => ({ libraryId: 1, zoteroKey: r.zoteroKey })));
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 90, pending: 10 });
    let release!: (rows: AttachmentProcessingStateRecord[]) => void;
    owner.db.getAttachmentProcessingStatesByLibrary.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pass = service.refresh();
    service.changed([{ libraryId: 1, zoteroKey: '99' }]);
    release(rows);
    await pass;
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 99, pending: 1 });
    expect(owner.db.getAttachmentProcessingStatesByLibrary).toHaveBeenCalledWith(1, rows.slice(90).map(r => r.zoteroKey));
    await service.refresh();
    expect(owner.db.getAttachmentProcessingStatesByLibrary).toHaveBeenLastCalledWith(1, ['99']);
    expect(service.getSummary()?.libraries[0].indexed).toBe(100);
});

it('retries a failed local read after a bounded delay without losing pending work', async () => {
    service.publishInventory(1, ['KEY00001'], service.discoveryFence());
    owner.db.getAttachmentProcessingStatesByLibrary.mockRejectedValueOnce(new Error('busy'));
    await service.refresh();
    expect(service.getSummary()?.libraries[0].pending).toBe(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(owner.db.getAttachmentProcessingStatesByLibrary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.getSummary()?.libraries[0].indexed).toBe(1);
});

it.each(['ocr_required', 'insufficient_text'])('leaves OCR-capable %s pending and excludes OCR without access', code => {
    const row = { ...indexed, extractStatus: 'failed' as const, ocrStatus: 'needed' as const };
    expect(classifyPreparation(row, code, requirements, 'account', 'lLOCAL123', 'LOCAL123', true)).toBe('pending');
    expect(classifyPreparation(row, code, requirements, 'account', 'lLOCAL123', 'LOCAL123', false)).toEqual({ unavailable: 'ocr_unavailable' });
});
it.each(['empty_document', 'insufficient_text', 'remote_download_denied'])('classifies explicit settled content limitation %s', code => {
    expect(classifyPreparation({ ...indexed, extractStatus: 'failed' }, code, requirements, 'account', 'lLOCAL123', 'LOCAL123'))
        .toEqual({ unavailable: code === 'remote_download_denied' ? code : 'no_extractable_text' });
});

it('journals affected attachment identities without invalidating on queue bookkeeping', async () => {
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    await db.initDatabase('0.99.0');
    const listener = vi.fn();
    const unsubscribe = db.subscribeReadinessChanges(listener);
    try {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf' });
        expect(listener).toHaveBeenLastCalledWith([{ libraryId: 1, zoteroKey: 'KEY00001' }]);
        listener.mockClear();
        await db.enqueueBackgroundJob({ jobType: 'document_extract', libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf', payloadKind: 'structured', priority: 115, now: Date.now() });
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf' });
        expect(listener).not.toHaveBeenCalled();
        await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf', errorCode: 'file_missing', attemptedAt: 1 });
        expect(listener).toHaveBeenCalledTimes(1);
        listener.mockClear();
        await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf', errorCode: 'file_missing', attemptedAt: 2 });
        expect(listener).not.toHaveBeenCalled();
    } finally { unsubscribe(); await connection.closeDatabase(); }
});

it('uses identical OCR reasons for single and batch reads with missing hashes and old failures', async () => {
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    await db.initDatabase('0.99.0');
    try {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf' });
        await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf', errorCode: 'empty_document', attemptedAt: 1 });
        await connection.queryAsync("UPDATE attachment_processing_state SET ocr_status='failed'");
        await db.recordDocumentProcessingFailure({ fileHash: 'bytes', task: 'ocr', engineVersion: 'old', error: 'old', terminalCode: 'encrypted_pdf' });
        for (const hash of [null, 'bytes']) {
            await connection.queryAsync('UPDATE attachment_processing_state SET file_hash=?', [hash]);
            expect(await db.getAttachmentReadingError(1, 'KEY00001')).toBe('empty_document');
            expect((await db.getAttachmentReadingErrorsByLibrary(1, ['KEY00001'])).get('KEY00001')).toBe('empty_document');
        }
    } finally { await connection.closeDatabase(); }
});

it.each([
    ['low_confidence', 'no_extractable_text'], ['ocr_no_text', 'no_extractable_text'],
    ['unsupported', 'unsupported_document'], ['digital_signature', 'unsupported_document'],
    ['image_too_large', 'document_too_large'], ['render_failed', 'unsupported_document'],
])('classifies the explicit OCR document limitation %s', (code, reason) => {
    expect(classifyPreparation({ ...indexed, upsertStatus: null, ocrStatus: 'failed' }, code, requirements, 'account', 'lLOCAL123', 'LOCAL123'))
        .toEqual({ unavailable: reason });
});

it('clears old membership holds on scope reset and never releases a newer batch', async () => {
    const old = service.beginChanges();
    owner.searchableLibraryIds.push(42);
    service.setRequirements(requirements);
    expect(service.getSummary()?.libraries.every(lib => !lib.discovery_complete)).toBe(true);
    const current = service.beginChanges();
    service.completeChanges(old);
    expect(service.getSummary()).toBeNull();
    service.completeChanges(current);
    expect(service.getSummary()).not.toBeNull();
});
it('keeps discovery stable throughout notification bursts but rejects preference invalidation', () => {
    const fence = service.discoveryFence();
    let batch = 0;
    for (let i = 0; i < 100; i++) batch = service.beginChanges();
    expect(service.publishInventory(1, ['KEY00001'], fence)).toBe(true);
    service.completeChanges(batch - 1);
    expect(service.getSummary()).toBeNull();
    service.completeChanges(batch);
    expect(service.getSummary()?.libraries[0].discovery_complete).toBe(true);
    service.invalidateInventory();
    expect(service.publishInventory(1, ['KEY00001'], fence)).toBe(false);
});
it('does not reject a committed ledger write if reading the readiness journal fails', async () => {
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    await db.initDatabase('0.99.0');
    const listener = vi.fn();
    const unsubscribe = db.subscribeReadinessChanges(listener);
    const query = connection.queryAsync.bind(connection);
    const spy = vi.spyOn(connection, 'queryAsync').mockImplementation(async (sql, ...args) => {
        if (sql.startsWith('SELECT id, library_id, zotero_key FROM readiness_changes')) throw new Error('journal unavailable');
        return query(sql, ...args);
    });
    try {
        await expect(db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf' })).resolves.toMatchObject({ zoteroKey: 'KEY00001' });
        expect(listener).toHaveBeenCalledWith();
        expect(await db.getAttachmentProcessingState(1, 'KEY00001')).not.toBeNull();
    } finally { spy.mockRestore(); unsubscribe(); await connection.closeDatabase(); }
});

it.each([true, false])('treats raw PDF no-text observations as OCR preparation (access=%s)', access => {
    const row = { ...indexed, extractStatus: 'failed' as const, ocrStatus: null };
    expect(classifyPreparation(row, 'no_text_layer', requirements, 'account', 'lLOCAL123', 'LOCAL123', access))
        .toEqual(access ? 'pending' : { unavailable: 'ocr_unavailable' });
});
it('classifies a settled non-PDF no-text observation as a document limitation', () => {
    const row = { ...indexed, contentKind: 'snapshot' as const, extractStatus: 'failed' as const };
    expect(classifyPreparation(row, 'no_text_layer', requirements, 'account', 'lLOCAL123', 'LOCAL123'))
        .toEqual({ unavailable: 'no_extractable_text' });
});

it('uses an indexed dead-letter lookup with a large unrelated history', async () => {
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    await db.initDatabase('0.99.0');
    try {
        await connection.queryAsync(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
            INSERT INTO background_jobs_dead (job_type,library_id,zotero_key,content_kind,payload_kind,enqueued_at,died_at,attempt_count,payload_json)
            SELECT 'fulltext_upsert',1,printf('%08d',x),'pdf','structured',0,1,3,'{}' FROM n`);
        const query = vi.spyOn(connection, 'queryAsync');
        await db.getAttachmentIndexRecoveryCandidates(1, { accountId: 'account', scopeRef: 'lLOCAL123', localId: 'LOCAL123', incarnation: 'epoch', indexVersion: 3 }, 50);
        const call = query.mock.calls.find(([sql]) => sql.includes('NOT EXISTS (SELECT 1 FROM background_jobs_dead'))!;
        query.mockRestore();
        const details: string[] = [];
        await connection.queryAsync('EXPLAIN QUERY PLAN ' + call[0], call[1], { onRow: row => details.push(row.getResultByIndex(3)) });
        expect(details.some(detail => detail.includes('idx_background_jobs_dead_identity') && detail.includes('SEARCH'))).toBe(true);
    } finally { await connection.closeDatabase(); }
});


it('keeps indexed counts available through an identified add, its handoff, and delete', async () => {
    rows = Array.from({ length: 1000 }, (_, i) => ({ ...indexed, zoteroKey: `KEY${i}` }));
    service.publishInventory(1, rows.map(row => row.zoteroKey), service.discoveryFence());
    await service.refresh();
    const originalItems = Zotero.Items;
    const originalAttachments = Zotero.Attachments;
    (Zotero as any).Items = { get: vi.fn(() => ({
        libraryID: 1, key: 'NEWPDF01', isAttachment: () => true,
        isInTrash: () => false, isPDFAttachment: () => true, attachmentLinkMode: 0,
    })) };
    (Zotero as any).Attachments = { LINK_MODE_LINKED_URL: 3 };
    let observer: any;
    const register = vi.spyOn(Zotero.Notifier, 'registerObserver').mockImplementation((value: any) => {
        observer = value;
        return 'readiness-watcher';
    });
    const watcher = new NewItemWatcher();
    owner.processingReconciler = { notifyAttachments: vi.fn(events => service.beginChanges(events)) };
    watcher.start();
    try {
        observer.notify('add', 'item', [77], {});
        expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 1000, pending: 1, discovery_complete: true });
        await vi.advanceTimersByTimeAsync(500);
        expect(owner.processingReconciler.notifyAttachments).toHaveBeenCalledTimes(1);
        await service.refresh();
        expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 1000, pending: 1 });
        service.beginChanges([{ event: 'delete', id: 78, extra: { libraryID: 1, key: 'KEY0' } }]);
        expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 999, pending: 1 });
    } finally {
        watcher.stop();
        register.mockRestore();
        (Zotero as any).Items = originalItems;
        (Zotero as any).Attachments = originalAttachments;
    }
});

it('holds a notification during rediscovery until targeted replay corrects the enumerated inventory', async () => {
    service.publishInventory(1, ['KEY00001'], service.discoveryFence());
    await service.refresh();
    service.invalidateLibrary(1);
    const discovery = service.discoveryFence();
    const fence = service.beginChanges([{ event: 'delete', id: 78, extra: { libraryID: 1, key: 'KEY00001' } }]);
    service.publishInventory(1, ['KEY00001'], discovery);
    await service.refresh();
    expect(service.getSummary()).toBeNull();
    service.updateAttachment(1, 'KEY00001', false);
    service.completeChanges(fence);
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 0, pending: 0, discovery_complete: true });
});

it('does not release an unknown notification when a known deletion arrives', async () => {
    service.publishInventory(1, ['KEY00001'], service.discoveryFence());
    await service.refresh();
    const unknown = service.beginChanges([{ event: 'delete', id: 77 }]);
    service.beginChanges([{ event: 'delete', id: 78, extra: { libraryID: 1, key: 'KEY00001' } }]);
    service.completeChanges(unknown);
    expect(service.getSummary()).toBeNull();
});

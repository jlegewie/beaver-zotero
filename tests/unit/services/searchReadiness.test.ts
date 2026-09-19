import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

const requirements: IndexRequirements = { index_version: 3, index_validity: 'current', namespace_generation: 2,
    extract_schema_versions: { pdf: ['4'], epub: ['1'], snapshot: ['1'] } };
const indexed = { libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf',
    extractStatus: 'done', structuredDocumentHash: 'hash', extractSchemaVersion: '4',
    upsertStatus: 'done', upsertIndexVersion: '3',
    upsertRemoteIdentity: { index_account_id: 'account', index_scope_ref: 'lLOCAL123', index_local_id: 'LOCAL123', namespace_generation: 2 },
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
async function discover(libraryId = 1) {
    expect(service.completeDiscovery(libraryId, service.beginDiscovery(libraryId)!)).toBe(true);
    await service.refresh();
}

it.each(['network_error', 'not_entitled', 'retry_exhausted', 'unsupported_schema_version', 'extraction_failed', 'download_failed', 'ocr_geometry_mismatch', 'page_count_mismatch', 'unknown_ocr_error'])('keeps %s pending', code => {
    const row = { ...indexed, extractStatus: 'failed' as const, lastError: code };
    expect(classifyPreparation(row, code, requirements, 'account', 'lLOCAL123', 'LOCAL123')).toBe('pending');
});
it.each(['encrypted', 'invalid_pdf', 'file_missing'])('classifies structured document reason %s, not prose', code => {
    const row = { ...indexed, extractStatus: 'failed' as const };
    expect(classifyPreparation(row, code, requirements, 'account', 'lLOCAL123', 'LOCAL123')).toEqual('unavailable');
    expect(classifyPreparation(row, `${code}: message`, requirements, 'account', 'lLOCAL123', 'LOCAL123')).toBe('pending');
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
            .toEqual('unavailable');
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
            [JSON.stringify({ ...indexed.upsertRemoteIdentity, namespace_generation: 1 })]);
        const identity = { accountId: 'account', scopeRef: 'lLOCAL123', localId: 'LOCAL123', namespaceGeneration: 2, indexVersion: 3 };
        expect(await db.getAttachmentIndexRecoveryCandidates(1, identity, 1000)).toHaveLength(50);
        await connection.queryAsync("UPDATE attachment_processing_state SET upsert_status = 'failed' WHERE zotero_key = '00000001'");
        await db.enqueueBackgroundJob({ jobType: 'fulltext_upsert', libraryId: 1, zoteroKey: '00000002',
            contentKind: 'pdf', payloadKind: 'structured', priority: 115, now: Date.now() });
        const candidates = await db.getAttachmentIndexRecoveryCandidates(1, identity, 50);
        expect(candidates).toHaveLength(50);
        expect(candidates.some(row => row.zoteroKey === '00000002')).toBe(false);
        expect(candidates.some(row => row.zoteroKey === '00000001')).toBe(false);
        await connection.queryAsync(`INSERT INTO background_jobs_dead
            (job_type, library_id, zotero_key, content_kind, payload_kind, enqueued_at, died_at, attempt_count, payload_json)
            VALUES ('fulltext_upsert', 1, '00000001', 'pdf', 'structured', 0, 1, 3, ?)` ,
            ['{}']);
        await connection.queryAsync("UPDATE attachment_processing_state SET upsert_status = 'done' WHERE zotero_key = '00000001'");
        expect((await db.getAttachmentIndexRecoveryCandidates(1, identity, 50)).some(row => row.zoteroKey === '00000001')).toBe(false);
        expect((await db.getAttachmentIndexRecoveryCandidates(1, { ...identity, namespaceGeneration: 3 }, 50)).some(row => row.zoteroKey === '00000001')).toBe(false);
        expect((await db.getAttachmentIndexRecoveryCandidates(1, { ...identity, namespaceGeneration: null }, 50)).some(row => row.zoteroKey === '00000001')).toBe(false);
        await db.enqueueBackgroundJobs(candidates.map(row => ({ jobType: 'fulltext_upsert' as const,
            libraryId: 1, zoteroKey: row.zoteroKey, contentKind: row.contentKind,
            payloadKind: 'structured' as const, priority: 115, now: Date.now() })));
        const next = await db.getAttachmentIndexRecoveryCandidates(1, identity, 50);
        expect(next).toHaveLength(48);
        expect(next.some(row => candidates.some(queued => queued.zoteroKey === row.zoteroKey))).toBe(false);
    } finally { await connection.closeDatabase(); }
});
it.each(['ocr_required', 'insufficient_text'])('leaves OCR-capable %s pending and excludes OCR without access', code => {
    const row = { ...indexed, extractStatus: 'failed' as const, ocrStatus: 'needed' as const };
    expect(classifyPreparation(row, code, requirements, 'account', 'lLOCAL123', 'LOCAL123', true)).toBe('pending');
    expect(classifyPreparation(row, code, requirements, 'account', 'lLOCAL123', 'LOCAL123', false)).toEqual('unavailable');
});
it.each(['empty_document', 'insufficient_text', 'remote_download_denied'])('classifies explicit settled content limitation %s', code => {
    expect(classifyPreparation({ ...indexed, extractStatus: 'failed' }, code, requirements, 'account', 'lLOCAL123', 'LOCAL123'))
        .toEqual('unavailable');
});

it('reports affected attachment identities without invalidating on queue bookkeeping', async () => {
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
        await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf', errorCode: null, attemptedAt: 1 });
        expect(listener).not.toHaveBeenCalled();
        expect(await db.getAttachmentReadingError(1, 'KEY00001')).toBe('file_missing');
        await db.recordAttachmentReadingOutcome({ libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf', errorCode: null, attemptedAt: 3 });
        expect(listener).toHaveBeenCalledExactlyOnceWith([{ libraryId: 1, zoteroKey: 'KEY00001' }]);
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
            expect((await db.getAttachmentReadingErrorsByLibrary(1)).get('KEY00001')).toBe('empty_document');
        }
    } finally { await connection.closeDatabase(); }
});

it.each([
    'low_confidence', 'ocr_no_text', 'unsupported', 'digital_signature', 'image_too_large', 'render_failed',
])('classifies the explicit OCR document limitation %s', code => {
    expect(classifyPreparation({ ...indexed, upsertStatus: null, ocrStatus: 'failed' }, code, requirements, 'account', 'lLOCAL123', 'LOCAL123'))
        .toEqual('unavailable');
});

it.each([true, false])('treats raw PDF no-text observations as OCR preparation (access=%s)', access => {
    const row = { ...indexed, extractStatus: 'failed' as const, ocrStatus: null };
    expect(classifyPreparation(row, 'no_text_layer', requirements, 'account', 'lLOCAL123', 'LOCAL123', access))
        .toEqual(access ? 'pending' : 'unavailable');
});
it('classifies a settled non-PDF no-text observation as a document limitation', () => {
    const row = { ...indexed, contentKind: 'snapshot' as const, extractStatus: 'failed' as const };
    expect(classifyPreparation(row, 'no_text_layer', requirements, 'account', 'lLOCAL123', 'LOCAL123'))
        .toEqual('unavailable');
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
        await db.getAttachmentIndexRecoveryCandidates(1, { accountId: 'account', scopeRef: 'lLOCAL123', localId: 'LOCAL123', namespaceGeneration: 2, indexVersion: 3 }, 50);
        const call = query.mock.calls.find(([sql]) => sql.includes('NOT EXISTS (SELECT 1 FROM background_jobs_dead'))!;
        query.mockRestore();
        const details: string[] = [];
        await connection.queryAsync('EXPLAIN QUERY PLAN ' + call[0], call[1], { onRow: row => details.push(row.getResultByIndex(3)) });
        expect(details.some(detail => detail.includes('idx_background_jobs_dead_identity') && detail.includes('SEARCH'))).toBe(true);
    } finally { await connection.closeDatabase(); }
});


it('reports shared OCR failures for all affected refs and isolates listener errors', async () => {
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    await db.initDatabase('0.99.0');
    const listener = vi.fn();
    db.subscribeReadinessChanges(() => { throw new Error('observer'); });
    db.subscribeReadinessChanges(listener);
    try {
        for (const libraryId of [1, 2]) {
            await db.ensureAttachmentProcessingState({ libraryId, zoteroKey: 'KEY00001', contentKind: 'pdf' });
            await db.ensureAttachmentFileHash(libraryId, 'KEY00001', 'shared');
        }
        listener.mockClear();
        await db.recordDocumentProcessingFailure({ fileHash: 'shared', task: 'ocr', error: 'encrypted', terminalCode: 'encrypted_pdf' });
        expect(listener).toHaveBeenCalledExactlyOnceWith([
            { libraryId: 1, zoteroKey: 'KEY00001' }, { libraryId: 2, zoteroKey: 'KEY00001' },
        ]);
        listener.mockClear();
        await db.clearDocumentProcessingFailure('shared', 'ocr');
        expect(listener).toHaveBeenCalledTimes(1);
        listener.mockClear();
        await db.clearDocumentProcessingFailure('shared', 'ocr');
        expect(listener).not.toHaveBeenCalled();
        expect(connection.getRawDB().prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'readiness_%'").all()).toEqual([]);
    } finally { await connection.closeDatabase(); }
});

it('does not notify guarded writes that lost their race or rolled-back resets', async () => {
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    await db.initDatabase('0.99.0');
    await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'KEY00001', contentKind: 'pdf' });
    const listener = vi.fn();
    db.subscribeReadinessChanges(listener);
    try {
        expect(await db.markAttachmentUpsertDone({ libraryId: 1, zoteroKey: 'KEY00001',
            structuredDocumentHash: 'obsolete', upsertIndexVersion: '3' })).toBe(false);
        expect(listener).not.toHaveBeenCalled();
        const query = connection.queryAsync.bind(connection);
        vi.spyOn(connection, 'queryAsync').mockImplementation(async (sql, ...args) => {
            if (sql.startsWith('DELETE FROM processing_index_state')) throw new Error('rollback');
            return query(sql, ...args);
        });
        await expect(db.resetLocalProcessingState(1)).rejects.toThrow('rollback');
        expect(listener).not.toHaveBeenCalled();
    } finally { await connection.closeDatabase(); }
});

it('requires a successful membership pass before publishing ledger counts', async () => {
    await service.refresh();
    expect(service.getSummary()).toBeNull();
    rows.push({ ...indexed, zoteroKey: 'PENDING1', upsertStatus: null });
    await discover();
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 1, pending: 1, unavailable: 0 });
    service.dispose();
    service = new SearchReadiness();
    service.setRequirements(requirements);
    await service.refresh();
    expect(service.getSummary()).toBeNull();
});

it('coalesces ledger changes into a library read and keeps dispatch free of reads', async () => {
    rows = Array.from({ length: 1000 }, (_, i) => ({ ...indexed, zoteroKey: String(i) }));
    await discover();
    const previous = service.getSummary();
    owner.db.getAttachmentProcessingStatesByLibrary.mockClear();
    rows[0] = { ...rows[0], upsertStatus: null };
    for (const row of rows) service.changed([{ libraryId: 1, zoteroKey: row.zoteroKey }]);
    expect(service.getSummary()).toBe(previous);
    await vi.advanceTimersByTimeAsync(5000);
    expect(owner.db.getAttachmentProcessingStatesByLibrary).toHaveBeenCalledExactlyOnceWith(1);
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 999, pending: 1 });
    for (let i = 0; i < 1000; i++) service.getSummary();
    expect(owner.db.getAttachmentProcessingStatesByLibrary).toHaveBeenCalledTimes(1);
});

it('keeps the completed snapshot while only the affected library is rediscovered', async () => {
    owner.searchableLibraryIds = [1, 2];
    service.setRequirements(requirements);
    await discover(1); await discover(2);
    const previous = service.getSummary();
    owner.db.getAttachmentProcessingStatesByLibrary.mockClear();
    service.notifyAttachments([{ id: 123, event: 'add', extra: { libraryID: 1 } }]);
    await service.refresh();
    expect(service.getSummary()).toBe(previous);
    expect(service.needsDiscovery(1)).toBe(true);
    expect(service.needsDiscovery(2)).toBe(false);
    expect(owner.db.getAttachmentProcessingStatesByLibrary).not.toHaveBeenCalled();
    await discover(1);
    expect(owner.db.getAttachmentProcessingStatesByLibrary).toHaveBeenCalledExactlyOnceWith(1);
    expect(service.getSummary()).not.toBeNull();
});

it.each([undefined, {}, { title: 'Old title' }, { tags: [] }])('preserves discovery for metadata or download notifications (%j)', async changed => {
    await discover();
    const summary = service.getSummary();
    owner.db.getAttachmentProcessingStatesByLibrary.mockClear();
    service.notifyAttachments([{ id: 123, event: 'modify', extra: { libraryID: 1, changed } }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.needsDiscovery()).toBe(false);
    expect(service.getSummary()).toBe(summary);
    expect(owner.db.getAttachmentProcessingStatesByLibrary).not.toHaveBeenCalled();
});

it.each([
    { event: 'add' as const }, { event: 'delete' as const }, { event: 'trash' as const },
    { event: 'modify' as const, changed: { deleted: false } },
    { event: 'modify' as const, changed: { deleted: true } },
    { event: 'modify' as const, changed: { parentKey: 'PARENT01' } },
])('invalidates discovery for membership changes (%j)', async ({ event, changed }) => {
    await discover();
    const previous = service.getSummary();
    service.notifyAttachments([{ id: 123, event, extra: { libraryID: 1, changed } }]);
    expect(service.needsDiscovery(1)).toBe(true);
    expect(service.getSummary()).toBe(previous);
});

it('does not complete discovery after a newer notification or scope change', async () => {
    const pass = service.beginDiscovery(1)!;
    service.requestDiscovery(1);
    expect(service.completeDiscovery(1, pass)).toBe(false);
    const next = service.beginDiscovery(1)!;
    account = 'replacement';
    expect(service.completeDiscovery(1, next)).toBe(false);
    expect(service.getSummary()).toBeNull();
});

it.each(['write', 'membership', 'account', 'scope', 'requirements', 'ocr', 'dispose'])('rejects an async count read after %s changes', async change => {
    await discover();
    const previous = service.getSummary();
    service.changed([{ libraryId: 1, zoteroKey: indexed.zoteroKey }]);
    let release!: (value: AttachmentProcessingStateRecord[]) => void;
    owner.db.getAttachmentProcessingStatesByLibrary.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const read = service.refresh();
    if (change === 'write') service.changed([{ libraryId: 1, zoteroKey: indexed.zoteroKey }]);
    if (change === 'membership') service.requestDiscovery(1);
    if (change === 'account') account = 'other';
    if (change === 'scope') owner.searchableLibraryIds = [1, 2];
    if (change === 'requirements') service.setRequirements({ ...requirements, namespace_generation: 3 });
    if (change === 'ocr') owner.hasOcrAccess = true;
    if (change === 'dispose') service.dispose();
    release(rows);
    await read;
    if (change === 'write' || change === 'membership') expect(service.getSummary()).toBe(previous);
    else expect(service.getSummary()).toBeNull();
    if (change === 'write' || change === 'requirements' || change === 'ocr') {
        await service.refresh();
        expect(service.getSummary()?.libraries[0].indexed).toBe(change === 'requirements' ? 0 : 1);
    }
});

it('retains the completed snapshot while retrying failed local reads', async () => {
    await discover();
    const previous = service.getSummary();
    service.changed([{ libraryId: 1, zoteroKey: indexed.zoteroKey }]);
    rows[0] = { ...rows[0], upsertStatus: null };
    owner.db.getAttachmentProcessingStatesByLibrary.mockClear().mockRejectedValueOnce(new Error('busy'));
    await service.refresh();
    expect(service.getSummary()).toBe(previous);
    await vi.advanceTimersByTimeAsync(4999);
    expect(owner.db.getAttachmentProcessingStatesByLibrary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 0, pending: 1 });
});

it('reclassifies OCR access and processing versions without rediscovery', async () => {
    rows.push({ ...indexed, zoteroKey: 'OCR00001', extractStatus: 'failed', ocrStatus: 'needed' });
    await discover();
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 1, unavailable: 1 });
    owner.hasOcrAccess = true;
    expect(service.getSummary()).toBeNull();
    await service.refresh();
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 1, pending: 1, unavailable: 0 });
    service.setRequirements({ ...requirements, extract_schema_versions: { ...requirements.extract_schema_versions, pdf: ['next'] } });
    await service.refresh();
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 0, pending: 2 });
    expect(service.needsDiscovery()).toBe(false);
});

it.each(['unknown', 'missing', undefined] as const)('fails closed on index validity %s without changing acknowledgements', async validity => {
    await discover();
    service.setRequirements({ ...requirements, index_validity: validity });
    await service.refresh();
    expect(service.getSummary()).toBeNull();
    expect(rows[0].upsertStatus).toBe('done');
});

it('keeps 5000 indexed attachments available through an addition and replaces the snapshot after discovery', async () => {
    rows = Array.from({ length: 5000 }, (_, i) => ({ ...indexed, zoteroKey: String(i) }));
    await discover();
    const previous = service.getSummary();
    service.notifyAttachments([{ id: 99999, event: 'add', extra: { libraryID: 1 } }]);
    const pass = service.beginDiscovery(1)!;
    rows.push({ ...indexed, zoteroKey: 'NEW00001', upsertStatus: null });
    service.changed([{ libraryId: 1, zoteroKey: 'NEW00001' }]);
    await service.refresh();
    expect(service.getSummary()).toBe(previous);
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 5000, pending: 0 });
    expect(service.completeDiscovery(1, pass)).toBe(true);
    expect(service.getSummary()).toBe(previous);
    await service.refresh();
    expect(service.getSummary()).not.toBe(previous);
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 5000, pending: 1 });
});

it('publishes refreshed libraries together instead of replacing a complete snapshot with partial counts', async () => {
    owner.searchableLibraryIds = [1, 2];
    service.setRequirements(requirements);
    await discover(1); await discover(2);
    const previous = service.getSummary();
    service.requestDiscovery();
    await discover(1);
    expect(service.getSummary()).toBe(previous);
    await discover(2);
    expect(service.getSummary()).not.toBe(previous);
    expect(service.getSummary()?.libraries).toHaveLength(2);
});

it('drops the retained snapshot immediately when search entitlement is revoked', async () => {
    await discover();
    service.requestDiscovery(1);
    expect(service.getSummary()).not.toBeNull();
    owner.hasSearchIndexAccess = false;
    expect(service.getSummary()).toBeNull();
});

it('folds a large SQLite ledger once and caches only its summary', async () => {
    const connection = new MockDBConnection();
    const db = new BeaverDB(connection);
    await db.initDatabase('0.99.0');
    owner.db = db;
    try {
        await connection.queryAsync(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
            INSERT INTO attachment_processing_state (library_id,zotero_key,content_kind,structured_document_hash,
                extract_status,extract_schema_version,upsert_status,upsert_index_version,upsert_remote_identity)
            SELECT 1, printf('%08d',x), 'pdf', 'hash', 'done', '4', 'done', '3', ? FROM n`,
            [JSON.stringify(indexed.upsertRemoteIdentity)]);
        const reads = vi.spyOn(db, 'getAttachmentProcessingStatesByLibrary');
        await discover();
        for (let i = 0; i < 1000; i++) expect(service.getSummary()?.libraries[0].indexed).toBe(10000);
        await reconcileRemoteRefs([1], () => false);
        expect(reads).toHaveBeenCalledExactlyOnceWith(1);
        expect(mocks.verify).not.toHaveBeenCalled();
    } finally { service.dispose(); await connection.closeDatabase(); }
});

it('keeps legacy acknowledgements pending instead of inferring their generation', () => {
    const identity = { ...indexed.upsertRemoteIdentity!, namespace_generation: undefined, index_incarnation: 'legacy' };
    expect(classifyPreparation({ ...indexed, upsertRemoteIdentity: identity }, undefined,
        requirements, 'account', 'lLOCAL123', 'LOCAL123')).toBe('pending');
});

it('reuses counts across validity-only changes and immediately fails closed', async () => {
    await discover();
    const counts = service.getSummary()!.libraries;
    const read = owner.db.getAttachmentProcessingStatesByLibrary;
    read.mockClear();
    service.setRequirements({ ...requirements, index_validity: 'unknown' });
    expect(service.getSummary()).toBeNull();
    await service.refresh();
    service.setRequirements(requirements);
    expect(service.getSummary()!.libraries).toEqual(counts);
    await service.refresh();
    expect(read).not.toHaveBeenCalled();
});

it('keeps a count read in flight through a validity-only change', async () => {
    service.completeDiscovery(1, service.beginDiscovery(1)!);
    let resolve!: (value: AttachmentProcessingStateRecord[]) => void;
    owner.db.getAttachmentProcessingStatesByLibrary.mockImplementation(() => new Promise(r => { resolve = r; }));
    const refresh = service.refresh();
    service.setRequirements({ ...requirements, index_validity: 'unknown' });
    resolve(rows);
    await refresh;
    expect(service.getSummary()).toBeNull();
    service.setRequirements(requirements);
    expect(service.getSummary()?.libraries[0].indexed).toBe(1);
    expect(owner.db.getAttachmentProcessingStatesByLibrary).toHaveBeenCalledTimes(1);
});

it('does not classify later libraries using requirements superseded during a read', async () => {
    owner.searchableLibraryIds = [1, 2];
    service.setRequirements(requirements);
    for (const id of [1, 2]) service.completeDiscovery(id, service.beginDiscovery(id)!);
    let resolve!: (value: AttachmentProcessingStateRecord[]) => void;
    owner.db.getAttachmentProcessingStatesByLibrary.mockImplementation(async (id: number) => rows.map(row => ({
        ...row, upsertRemoteIdentity: { ...row.upsertRemoteIdentity!, index_scope_ref: id === 1 ? 'lLOCAL123' : 'g2' },
    })));
    owner.db.getAttachmentProcessingStatesByLibrary.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const refresh = service.refresh();
    service.setRequirements({ ...requirements, index_version: 4 });
    resolve(rows);
    await refresh;
    await service.refresh();
    expect(service.getSummary()?.libraries.map(lib => lib.indexed)).toEqual([0, 0]);
    expect(service.getSummary()?.libraries.map(lib => lib.pending)).toEqual([1, 1]);
});

it('bounds full-ledger reads under sustained writes and refreshes after they settle', async () => {
    await discover();
    const read = owner.db.getAttachmentProcessingStatesByLibrary;
    read.mockClear();
    for (let i = 0; i < 100; i++) {
        service.changed([{ libraryId: 1, zoteroKey: indexed.zoteroKey }]);
        await vi.advanceTimersByTimeAsync(100);
    }
    expect(read).toHaveBeenCalledTimes(2);
    rows[0] = { ...rows[0], upsertStatus: null };
    service.changed([{ libraryId: 1, zoteroKey: indexed.zoteroKey }]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.getSummary()?.libraries[0]).toMatchObject({ indexed: 0, pending: 1 });
});

it('backs off when writes supersede an in-flight count read', async () => {
    await discover();
    const read = owner.db.getAttachmentProcessingStatesByLibrary;
    let resolve!: (value: AttachmentProcessingStateRecord[]) => void;
    read.mockClear().mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    service.changed([{ libraryId: 1, zoteroKey: indexed.zoteroKey }]);
    await vi.advanceTimersByTimeAsync(5000);
    service.changed([{ libraryId: 1, zoteroKey: indexed.zoteroKey }]);
    resolve(rows);
    await vi.advanceTimersByTimeAsync(4999);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
});

it.each([2, 3])('retains counts through unknown/null generation but checks returning generation %s', async generation => {
    await discover();
    const read = owner.db.getAttachmentProcessingStatesByLibrary;
    read.mockClear();
    service.setRequirements({ ...requirements, index_validity: 'unknown', namespace_generation: null });
    expect(service.getSummary()).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).not.toHaveBeenCalled();
    service.setRequirements({ ...requirements, namespace_generation: generation });
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(generation === 2 ? 0 : 1);
    expect(service.getSummary()?.libraries[0].indexed).toBe(generation === 2 ? 1 : 0);
});

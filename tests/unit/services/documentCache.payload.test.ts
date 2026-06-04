import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { DocumentCache } from '../../../src/services/documentCache';
import { gzipString } from '../../../src/utils/gzip';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { createMockAttachment } from '../../helpers/factories';
import type { BeaverExtractResult } from '../../../src/beaver-extract/schema/schema';
import type { PageGeometry } from '../../../src/services/documentCache';

const mockIOUtils = (globalThis as any).IOUtils as {
    exists: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    makeDirectory: ReturnType<typeof vi.fn>;
};

type CacheAttachmentItem = Parameters<DocumentCache['putResult']>[0]['item'];
const onePageGeometry: PageGeometry[] = [
    { viewBox: [0, 0, 100, 200], width: 100, height: 200, rotation: 0 },
];

function createCacheAttachment(): CacheAttachmentItem {
    return createMockAttachment({ id: 100, key: 'ABCD1234', libraryID: 1 }) as unknown as CacheAttachmentItem;
}

const structuredResult: BeaverExtractResult = {
    schemaVersion: '4',
    mode: 'structured',
    document: {
        pageCount: 1,
        pageLabels: { '0': '1' },
        bboxOrigin: 'top-left',
        bboxPrecision: 2,
        pages: [{ index: 0, label: '1', width: 100, height: 200, viewBox: [0, 0, 100, 200], rotation: 0, items: [] }],
        citationIndex: {},
    },
};

describe('DocumentCache payloads', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;
    let cache: DocumentCache;
    let files: Map<string, Uint8Array>;
    // Keys that exist in the mock Zotero items table.
    let existingItemKeys: Set<string>;
    // Keys whose item (or parent) is in the trash.
    let trashedItemKeys: Set<string>;
    const sourcePath = '/tmp/source.pdf';

    beforeEach(async () => {
        vi.clearAllMocks();
        files = new Map([[sourcePath, new Uint8Array([1, 2, 3])]]);
        mockIOUtils.exists.mockImplementation(async (path: string) => files.has(path) || path === sourcePath);
        mockIOUtils.stat.mockResolvedValue({ lastModified: 10, size: 3 } as any);
        mockIOUtils.write.mockImplementation(async (path: string, bytes: Uint8Array) => {
            files.set(path, new Uint8Array(bytes));
        });
        mockIOUtils.read.mockImplementation(async (path: string) => {
            const bytes = files.get(path);
            if (!bytes) throw new Error(`missing ${path}`);
            return bytes;
        });
        mockIOUtils.remove.mockImplementation(async (path: string) => {
            files.delete(path);
        });
        mockIOUtils.makeDirectory.mockResolvedValue(undefined);
        existingItemKeys = new Set(['ABCD1234']);
        trashedItemKeys = new Set();
        // Mock the Zotero database lookup used by startup GC. Returns a row only
        // for keys that exist; trashed state is reported via the second column.
        (globalThis as any).Zotero.DB = {
            queryAsync: vi.fn(async (_sql: string, params: any[], options?: any) => {
                if (!options?.onRow) return [];
                for (const key of params.slice(1)) {
                    if (!existingItemKeys.has(key)) continue;
                    const trashed = trashedItemKeys.has(key) ? 1 : 0;
                    options.onRow({ getResultByIndex: (i: number) => [key, trashed, 0][i] });
                }
                return [];
            }),
        };

        conn = new MockDBConnection();
        db = new BeaverDB(conn);
        await db.initDatabase('0.99.0');
        cache = new DocumentCache(db);
        (cache as any).payloadCacheDir = '/mock/profile/beaver/document-cache';
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    it('putResult then getResult returns the cached extraction result', async () => {
        const item = createCacheAttachment();
        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: [{ viewBox: [0, 0, 100, 200], width: 100, height: 200, rotation: 0 }],
            },
        });

        await expect(cache.getResult(
            { libraryId: 1, zoteroKey: 'ABCD1234' },
            'structured',
            sourcePath,
        )).resolves.toEqual(structuredResult);

        const metadata = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(metadata?.contentKind).toBe('pdf');
        expect(metadata?.documentMetadata).toMatchObject({
            content_kind: 'pdf',
            pageCount: 1,
        });
        const payload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        expect(payload?.contentKind).toBe('pdf');
    });

    it('does not write payload files for EPUB metadata in this phase', async () => {
        const item = createCacheAttachment();

        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/epub+zip',
            result: structuredResult,
            metadata: {
                contentKind: 'epub',
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });

        expect(mockIOUtils.write).not.toHaveBeenCalled();
        expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).toBeNull();
        expect(await db.getDocumentCachePayloadCount()).toBe(0);
    });

    it.each(['text', 'snapshot'] as const)(
        'does not write payload files for uncacheable %s metadata',
        async (contentKind) => {
            const item = createCacheAttachment();

            await cache.putResult({
                item,
                filePath: sourcePath,
                mode: 'structured',
                sourceSizeBytes: 3,
                contentType: 'text/plain',
                result: structuredResult,
                metadata: {
                    contentKind,
                    pageCount: 1,
                    pageLabels: { '0': '1' },
                    pages: onePageGeometry,
                },
            });

            expect(mockIOUtils.write).not.toHaveBeenCalled();
            expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).toBeNull();
            expect(await db.getDocumentCachePayloadCount()).toBe(0);
        },
    );

    it('coalesces concurrent cold result creation for the same source identity', async () => {
        const item = createCacheAttachment();
        let createCalls = 0;
        let releaseCreate!: () => void;
        const createBarrier = new Promise<void>((resolve) => {
            releaseCreate = resolve;
        });
        const create = vi.fn(async (_signal: AbortSignal) => {
            createCalls++;
            await createBarrier;
            return structuredResult;
        });

        const first = cache.getOrCreateResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            create,
            metadata: (result) => ({
                pageCount: result.document.pageCount,
                pageLabels: result.document.pageLabels ?? null,
                pages: onePageGeometry,
            }),
        });

        while (createCalls === 0) {
            await Promise.resolve();
        }

        const second = cache.getOrCreateResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            create,
            metadata: (result) => ({
                pageCount: result.document.pageCount,
                pageLabels: result.document.pageLabels ?? null,
                pages: onePageGeometry,
            }),
        });

        releaseCreate();
        await expect(Promise.all([first, second])).resolves.toEqual([
            structuredResult,
            structuredResult,
        ]);
        expect(create).toHaveBeenCalledTimes(1);
        expect(await db.getDocumentCachePayloadCount()).toBe(1);
    });

    it('keeps shared extraction alive while another waiter remains active', async () => {
        const item = createCacheAttachment();
        const firstController = new AbortController();
        const expectedSourceIdentity = await cache.getSourceIdentitySnapshot(sourcePath);
        let createCalls = 0;
        let createSignal: AbortSignal | null = null;
        let releaseCreate!: () => void;
        const createBarrier = new Promise<void>((resolve) => {
            releaseCreate = resolve;
        });
        const create = vi.fn(async (signal: AbortSignal) => {
            createCalls++;
            createSignal = signal;
            await createBarrier;
            expect(signal.aborted).toBe(false);
            return structuredResult;
        });

        const first = cache.getOrCreateResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            abortSignal: firstController.signal,
            expectedSourceIdentity,
            create,
            metadata: (result) => ({
                pageCount: result.document.pageCount,
                pageLabels: result.document.pageLabels ?? null,
                pages: onePageGeometry,
            }),
        });

        while (createCalls === 0) {
            await Promise.resolve();
        }

        const second = cache.getOrCreateResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            expectedSourceIdentity,
            create,
            metadata: (result) => ({
                pageCount: result.document.pageCount,
                pageLabels: result.document.pageLabels ?? null,
                pages: onePageGeometry,
            }),
        });

        await Promise.resolve();
        await Promise.resolve();

        firstController.abort();
        await expect(first).rejects.toThrow('Operation aborted');
        expect(createSignal).not.toBeNull();
        expect(createSignal!.aborted).toBe(false);

        releaseCreate();
        await expect(second).resolves.toEqual(structuredResult);
        expect(create).toHaveBeenCalledTimes(1);
        expect(await db.getDocumentCachePayloadCount()).toBe(1);
    });

    it('passes the caller abort signal to cold result creation', async () => {
        const item = createCacheAttachment();
        const controller = new AbortController();
        const create = vi.fn(async (signal: AbortSignal) => {
            expect(signal.aborted).toBe(true);
            throw new Error('aborted');
        });
        controller.abort();

        await expect(cache.getOrCreateResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            abortSignal: controller.signal,
            create,
            metadata: (result) => ({
                pageCount: result.document.pageCount,
                pageLabels: result.document.pageLabels ?? null,
                pages: onePageGeometry,
            }),
        })).rejects.toThrow('aborted');

        expect(create).toHaveBeenCalledTimes(1);
        expect(await db.getDocumentCachePayloadCount()).toBe(0);
    });

    it('skips storing a result when the local source changes after the initial snapshot', async () => {
        const item = createCacheAttachment();
        const expectedSourceIdentity = await cache.getSourceIdentitySnapshot(sourcePath);
        mockIOUtils.stat.mockResolvedValue({ lastModified: 20, size: 3 } as any);

        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
            expectedSourceIdentity,
        });

        expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).toBeNull();
        expect(await db.getDocumentCachePayloadCount()).toBe(0);
    });

    it('maxSourceSizeBytes rejects a valid hit without deleting it', async () => {
        const item = createCacheAttachment();
        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });

        await expect(cache.getResult(
            { libraryId: 1, zoteroKey: 'ABCD1234' },
            'structured',
            sourcePath,
            { maxSourceSizeBytes: 2 },
        )).resolves.toBeNull();
        expect(await db.getDocumentCachePayloadCount()).toBe(1);
    });

    it('corrupt gzip returns null, deletes payload, and keeps metadata', async () => {
        const item = createCacheAttachment();
        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });
        const payload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        files.set(payload!.payloadPath, gzipString('{not json'));

        await expect(cache.getResult(
            { libraryId: 1, zoteroKey: 'ABCD1234' },
            'structured',
            sourcePath,
        )).resolves.toBeNull();

        expect(await db.getDocumentCachePayloadCount()).toBe(0);
        expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).not.toBeNull();
    });

    it('corrupt metadata JSON is stale and deletes payload before parsing it', async () => {
        const raw = conn.getRawDB();
        const payloadPath = '/cache/corrupt-metadata.gz';
        files.set(payloadPath, gzipString(JSON.stringify(structuredResult)));
        raw.prepare(`
            INSERT INTO document_cache_metadata (
                item_id, library_id, zotero_key, content_kind, file_path,
                file_mtime_ms, file_size_bytes, source_size_bytes, content_type,
                document_metadata_json, extraction_schema_version, metadata_format_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            100,
            1,
            'ABCD1234',
            'pdf',
            sourcePath,
            10,
            3,
            3,
            'application/pdf',
            '{not json',
            '4',
            1,
        );
        const metadataId = (raw.prepare(`
            SELECT id FROM document_cache_metadata
            WHERE library_id = 1 AND zotero_key = 'ABCD1234'
        `).get() as { id: number }).id;
        raw.prepare(`
            INSERT INTO document_cache_payloads (
                metadata_id, item_id, library_id, zotero_key, payload_kind, content_kind,
                source_file_path, source_file_mtime_ms, source_file_size_bytes,
                source_size_bytes, payload_path, payload_size_bytes, payload_sha256,
                extraction_schema_version, cache_format_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            metadataId,
            100,
            1,
            'ABCD1234',
            'structured',
            'pdf',
            sourcePath,
            10,
            3,
            3,
            payloadPath,
            files.get(payloadPath)!.byteLength,
            null,
            '4',
            1,
        );

        await expect(cache.getResult(
            { libraryId: 1, zoteroKey: 'ABCD1234' },
            'structured',
            sourcePath,
        )).resolves.toBeNull();

        expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).toBeNull();
        expect(await db.getDocumentCachePayloadCount()).toBe(0);
        expect(files.has(payloadPath)).toBe(false);
    });

    it('metadata discriminator mismatch is stale and deletes payload', async () => {
        const raw = conn.getRawDB();
        const payloadPath = '/cache/mismatch-metadata.gz';
        files.set(payloadPath, gzipString(JSON.stringify(structuredResult)));
        raw.prepare(`
            INSERT INTO document_cache_metadata (
                item_id, library_id, zotero_key, content_kind, file_path,
                file_mtime_ms, file_size_bytes, source_size_bytes, content_type,
                document_metadata_json, extraction_schema_version, metadata_format_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            100,
            1,
            'ABCD1234',
            'pdf',
            sourcePath,
            10,
            3,
            3,
            'application/pdf',
            JSON.stringify({ content_kind: 'epub', sectionCount: 1, sections: [] }),
            '4',
            1,
        );
        const metadataId = (raw.prepare(`
            SELECT id FROM document_cache_metadata
            WHERE library_id = 1 AND zotero_key = 'ABCD1234'
        `).get() as { id: number }).id;
        raw.prepare(`
            INSERT INTO document_cache_payloads (
                metadata_id, item_id, library_id, zotero_key, payload_kind, content_kind,
                source_file_path, source_file_mtime_ms, source_file_size_bytes,
                source_size_bytes, payload_path, payload_size_bytes, payload_sha256,
                extraction_schema_version, cache_format_version
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            metadataId,
            100,
            1,
            'ABCD1234',
            'structured',
            'pdf',
            sourcePath,
            10,
            3,
            3,
            payloadPath,
            files.get(payloadPath)!.byteLength,
            null,
            '4',
            1,
        );

        await expect(cache.getResult(
            { libraryId: 1, zoteroKey: 'ABCD1234' },
            'structured',
            sourcePath,
        )).resolves.toBeNull();

        expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).toBeNull();
        expect(await db.getDocumentCachePayloadCount()).toBe(0);
        expect(files.has(payloadPath)).toBe(false);
    });

    it('overwrites a corrupt orphan at the content-addressed payload path', async () => {
        const item = createCacheAttachment();
        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });
        const firstPayload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        await db.deleteDocumentCacheMetadata(1, 'ABCD1234');
        files.set(firstPayload!.payloadPath, new Uint8Array([9, 9, 9]));

        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });

        const secondPayload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        expect(secondPayload?.payloadPath).toBe(firstPayload?.payloadPath);
        await expect(cache.getResult(
            { libraryId: 1, zoteroKey: 'ABCD1234' },
            'structured',
            sourcePath,
        )).resolves.toEqual(structuredResult);
    });

    it('putErrorMetadata deletes existing payload rows and files', async () => {
        const item = createCacheAttachment();
        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });
        const payload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');

        await cache.putErrorMetadata({
            item,
            filePath: sourcePath,
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            errorCode: 'no_text_layer',
            pageCount: 1,
            pageLabels: { '0': '1' },
            pages: onePageGeometry,
        });

        expect(await db.getDocumentCachePayloadCount()).toBe(0);
        expect(files.has(payload!.payloadPath)).toBe(false);
        const metadata = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(metadata?.errorCode).toBe('no_text_layer');
    });

    it('putErrorMetadata stores the error code and preserves page metadata', async () => {
        const item = createCacheAttachment();

        await cache.putErrorMetadata({
            item,
            filePath: sourcePath,
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            errorCode: 'encrypted',
            pageCount: 7,
            pageLabels: { '0': 'i' },
            pages: onePageGeometry,
        });

        const metadata = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(metadata?.errorCode).toBe('encrypted');
        expect(metadata?.pageCount).toBe(7);
        expect(metadata?.pageLabels).toEqual({ '0': 'i' });
    });

    it('does not delete the active payload when source changes but output bytes match', async () => {
        const item = createCacheAttachment();
        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });
        const firstPayload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        mockIOUtils.stat.mockResolvedValue({ lastModified: 20, size: 3 } as any);

        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });

        const secondPayload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        expect(secondPayload?.payloadPath).toBe(firstPayload?.payloadPath);
        expect(files.has(secondPayload!.payloadPath)).toBe(true);
    });

    it('payload freshness treats metadata and payload content-kind mismatch as stale', async () => {
        const item = createCacheAttachment();
        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });
        const payload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        const raw = conn.getRawDB();
        raw.prepare(`
            UPDATE document_cache_payloads
            SET content_kind = 'epub', extraction_schema_version = '1'
            WHERE id = ?
        `).run(payload!.id);

        await expect(cache.getResult(
            { libraryId: 1, zoteroKey: 'ABCD1234' },
            'structured',
            sourcePath,
        )).resolves.toBeNull();

        expect(await db.getDocumentCachePayloadCount()).toBe(0);
        expect(files.has(payload!.payloadPath)).toBe(false);
    });

    it('startup GC removes cache entries for attachments missing from Zotero', async () => {
        const item = createCacheAttachment();
        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });
        const payload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        expect(payload).not.toBeNull();

        existingItemKeys.delete('ABCD1234');
        await cache.runStartupGC();

        expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).toBeNull();
        expect(await db.getDocumentCachePayloadCount()).toBe(0);
        expect(files.has(payload!.payloadPath)).toBe(false);
    });

    it('startup GC removes cache entries for attachments moved to the trash', async () => {
        const item = createCacheAttachment();
        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });
        const payload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        expect(payload).not.toBeNull();

        trashedItemKeys.add('ABCD1234');
        await cache.runStartupGC();

        expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).toBeNull();
        expect(await db.getDocumentCachePayloadCount()).toBe(0);
        expect(files.has(payload!.payloadPath)).toBe(false);
    });

    it('startup GC keeps cache entries for attachments still present in Zotero', async () => {
        const item = createCacheAttachment();
        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });

        await cache.runStartupGC();

        expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).not.toBeNull();
        expect(await db.getDocumentCachePayloadCount()).toBe(1);
    });

    it('startup GC removes cache rows whose schema version mismatches the content kind', async () => {
        const item = createCacheAttachment();
        await cache.putResult({
            item,
            filePath: sourcePath,
            mode: 'structured',
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            result: structuredResult,
            metadata: {
                pageCount: 1,
                pageLabels: { '0': '1' },
                pages: onePageGeometry,
            },
        });
        const payload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        const raw = conn.getRawDB();
        raw.exec(`UPDATE document_cache_metadata SET extraction_schema_version = '3'`);

        await cache.runStartupGC();

        expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).toBeNull();
        expect(await db.getDocumentCachePayloadCount()).toBe(0);
        expect(files.has(payload!.payloadPath)).toBe(false);
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { DocumentCache } from '../../../src/services/documentCache';
import { gzipString } from '../../../src/utils/gzip';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { createMockAttachment } from '../../helpers/factories';
import type { BeaverExtractResult } from '../../../src/beaver-extract/schema/schema';

const mockIOUtils = (globalThis as any).IOUtils as {
    exists: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    makeDirectory: ReturnType<typeof vi.fn>;
};

function createCacheAttachment(): Parameters<DocumentCache['putResult']>[0]['item'] {
    return createMockAttachment({ id: 100, key: 'ABCD1234', libraryID: 1 }) as Parameters<DocumentCache['putResult']>[0]['item'];
}

const structuredResult: BeaverExtractResult = {
    schemaVersion: '4',
    mode: 'structured',
    document: {
        pageCount: 1,
        pageLabels: { '0': '1' },
        bboxOrigin: 'top-left',
        bboxPrecision: 2,
        pages: [{ index: 0, label: '1', width: 100, height: 200, items: [] }],
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
            },
        });

        await expect(cache.getResult(
            { libraryId: 1, zoteroKey: 'ABCD1234' },
            'structured',
            sourcePath,
        )).resolves.toEqual(structuredResult);
    });

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
            },
        });

        const secondPayload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        expect(secondPayload?.payloadPath).toBe(firstPayload?.payloadPath);
        expect(files.has(secondPayload!.payloadPath)).toBe(true);
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
            },
        });

        await cache.runStartupGC();

        expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).not.toBeNull();
        expect(await db.getDocumentCachePayloadCount()).toBe(1);
    });
});

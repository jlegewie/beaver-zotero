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
        (globalThis as any).Zotero.Items = {
            getByLibraryAndKey: vi.fn(() => createCacheAttachment()),
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
                pageLabels: result.document.pageLabels,
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
                pageLabels: result.document.pageLabels,
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

        (globalThis as any).Zotero.Items.getByLibraryAndKey.mockReturnValue(null);
        await cache.runStartupGC();

        expect(await db.getDocumentCacheMetadataByKey(1, 'ABCD1234')).toBeNull();
        expect(await db.getDocumentCachePayloadCount()).toBe(0);
        expect(files.has(payload!.payloadPath)).toBe(false);
    });
});

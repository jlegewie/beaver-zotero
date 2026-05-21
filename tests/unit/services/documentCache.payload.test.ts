import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { DocumentCache } from '../../../src/services/documentCache';
import { gzipString } from '../../../src/utils/gzip';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { createMockAttachment } from '../../helpers/factories';
import type { BeaverExtractResult } from '../../../src/beaver-extract/schema/schema';

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
        vi.mocked(IOUtils.exists).mockImplementation(async (path: string) => files.has(path) || path === sourcePath);
        vi.mocked(IOUtils.stat).mockResolvedValue({ lastModified: 10, size: 3 } as any);
        vi.mocked(IOUtils.write).mockImplementation(async (path: string, bytes: Uint8Array) => {
            files.set(path, new Uint8Array(bytes));
        });
        vi.mocked(IOUtils.read).mockImplementation(async (path: string) => {
            const bytes = files.get(path);
            if (!bytes) throw new Error(`missing ${path}`);
            return bytes;
        });
        vi.mocked(IOUtils.remove).mockImplementation(async (path: string) => {
            files.delete(path);
        });
        vi.mocked((IOUtils as any).makeDirectory).mockResolvedValue(undefined);

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
        const item = createMockAttachment({ id: 100, key: 'ABCD1234', libraryID: 1 }) as Zotero.Item;
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
                hasTextLayer: true,
                needsOcr: false,
            },
        });

        await expect(cache.getResult(
            { libraryId: 1, zoteroKey: 'ABCD1234' },
            'structured',
            sourcePath,
        )).resolves.toEqual(structuredResult);
    });

    it('maxSourceSizeBytes rejects a valid hit without deleting it', async () => {
        const item = createMockAttachment({ id: 100, key: 'ABCD1234', libraryID: 1 }) as Zotero.Item;
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
                hasTextLayer: true,
                needsOcr: false,
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
        const item = createMockAttachment({ id: 100, key: 'ABCD1234', libraryID: 1 }) as Zotero.Item;
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
                hasTextLayer: true,
                needsOcr: false,
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
        const item = createMockAttachment({ id: 100, key: 'ABCD1234', libraryID: 1 }) as Zotero.Item;
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
                hasTextLayer: true,
                needsOcr: false,
            },
        });
        const payload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');

        await cache.putErrorMetadata({
            item,
            filePath: sourcePath,
            sourceSizeBytes: 3,
            contentType: 'application/pdf',
            errorState: 'no_text_layer',
            pageCount: 1,
            pageLabels: { '0': '1' },
        });

        expect(await db.getDocumentCachePayloadCount()).toBe(0);
        expect(files.has(payload!.payloadPath)).toBe(false);
        const metadata = await db.getDocumentCacheMetadataByKey(1, 'ABCD1234');
        expect(metadata?.needsOcr).toBe(true);
        expect(metadata?.hasTextLayer).toBe(false);
    });

    it('does not delete the active payload when source changes but output bytes match', async () => {
        const item = createMockAttachment({ id: 100, key: 'ABCD1234', libraryID: 1 }) as Zotero.Item;
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
                hasTextLayer: true,
                needsOcr: false,
            },
        });
        const firstPayload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        vi.mocked(IOUtils.stat).mockResolvedValue({ lastModified: 20, size: 3 } as any);

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
                hasTextLayer: true,
                needsOcr: false,
            },
        });

        const secondPayload = await db.getDocumentCachePayload(1, 'ABCD1234', 'structured');
        expect(secondPayload?.payloadPath).toBe(firstPayload?.payloadPath);
        expect(files.has(secondPayload!.payloadPath)).toBe(true);
    });
});

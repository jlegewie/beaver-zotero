import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { DocumentCache, derivedPageLabelsFromSerializedResult } from '../../../src/services/documentCache';
import {
    printedPageLabelsFromMetadata,
    zoteroLocatorPageLabelsFromMetadata,
} from '../../../src/services/documentExtraction/pageLabels';
import { MockDBConnection } from '../../mocks/mockDBConnection';
import { createMockAttachment } from '../../helpers/factories';
import { SCHEMA_VERSION, type BeaverExtractResult } from '@beaver/agent-core/extract/schema';
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
const pages: PageGeometry[] = [
    { viewBox: [0, 0, 100, 200], width: 100, height: 200, rotation: 0 },
    { viewBox: [0, 0, 100, 200], width: 100, height: 200, rotation: 0 },
];
const sourcePath = '/tmp/source.pdf';
const ref = { libraryId: 1, zoteroKey: 'ABCD1234' };

function attachment(): CacheAttachmentItem {
    return createMockAttachment({ id: 100, key: 'ABCD1234', libraryID: 1 }) as unknown as CacheAttachmentItem;
}

function structuredResult(derived?: Record<string, string>): BeaverExtractResult {
    return {
        schemaVersion: SCHEMA_VERSION,
        mode: 'structured',
        document: {
            pageCount: 2,
            pageLabels: { '0': '1', '1': '2' },
            ...(derived ? { derivedPageLabels: derived } : {}),
            bboxOrigin: 'top-left',
            bboxPrecision: 2,
            pages: [0, 1].map(index => ({
                index, label: String(index + 1), width: 100, height: 200,
                viewBox: [0, 0, 100, 200] as [number, number, number, number], rotation: 0 as const, items: [],
            })),
            citationIndex: {},
        },
    };
}

describe('DocumentCache derived page labels', () => {
    let conn: MockDBConnection;
    let db: BeaverDB;
    let cache: DocumentCache;
    let files: Map<string, Uint8Array>;

    const settleWrites = () => Promise.allSettled([...(cache as any).activeWrites]);

    beforeEach(async () => {
        vi.clearAllMocks();
        files = new Map([[sourcePath, new Uint8Array([1, 2, 3])]]);
        mockIOUtils.exists.mockImplementation(async (path: string) => files.has(path));
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

        conn = new MockDBConnection();
        db = new BeaverDB(conn);
        await db.initDatabase('0.99.0');
        cache = new DocumentCache(db);
        (cache as any).payloadCacheDir = '/mock/profile/beaver/document-cache';
    });

    afterEach(async () => {
        await conn.closeDatabase();
    });

    async function putStructured(
        result: BeaverExtractResult,
        derivedPageLabels?: Record<string, string> | null,
    ) {
        await cache.putResult({
            item: attachment(), filePath: sourcePath, mode: 'structured',
            sourceSizeBytes: 3, contentType: 'application/pdf', result,
            metadata: {
                pageCount: 2, pageLabels: { '0': '1', '1': '2' }, pages,
                ...(derivedPageLabels !== undefined ? { derivedPageLabels } : {}),
            },
        });
    }

    it('round-trips derived labels through cache metadata', async () => {
        await putStructured(structuredResult({ '1': '1202' }), { '1': '1202' });
        const record = await cache.getMetadata(ref, sourcePath);
        expect(record?.derivedPageLabels).toEqual({ '1': '1202' });
        expect(record?.pageLabels).toEqual({ '0': '1', '1': '2' });
    });

    it('records an absent derived map as unknown and an empty one as "none found"', async () => {
        await putStructured(structuredResult());
        const record = await cache.getMetadata(ref, sourcePath);
        expect(record).not.toBeNull();
        expect(record?.derivedPageLabels).toBeUndefined();

        await putStructured(structuredResult(), {});
        expect((await cache.getMetadata(ref, sourcePath))?.derivedPageLabels).toBeNull();
    });

    it('keeps stored derived labels across a metadata-only write of the same source', async () => {
        await putStructured(structuredResult({ '1': '1202' }), { '1': '1202' });
        await cache.putMetadata({
            item: attachment(), filePath: sourcePath, sourceSizeBytes: 3, contentType: 'application/pdf',
            metadata: { pageCount: 2, pageLabels: { '0': '1', '1': '2' }, pages, errorCode: null },
        });
        expect((await cache.getMetadata(ref, sourcePath))?.derivedPageLabels).toEqual({ '1': '1202' });
    });

    it('keeps stored derived labels when a markdown payload of the same source is cached', async () => {
        await putStructured(structuredResult({ '1': '1202' }), { '1': '1202' });
        const markdown: BeaverExtractResult = {
            schemaVersion: SCHEMA_VERSION,
            mode: 'markdown',
            document: { pageCount: 2, pages: [] },
        };
        await cache.putResult({
            item: attachment(), filePath: sourcePath, mode: 'markdown',
            sourceSizeBytes: 3, contentType: 'application/pdf', result: markdown,
            metadata: { pageCount: 2, pageLabels: { '0': '1', '1': '2' }, pages },
        });
        expect((await cache.getMetadata(ref, sourcePath))?.derivedPageLabels).toEqual({ '1': '1202' });
    });

    it('drops derived labels when a metadata-only write sees a changed source', async () => {
        await putStructured(structuredResult({ '1': '1202' }), { '1': '1202' });
        mockIOUtils.stat.mockResolvedValue({ lastModified: 11, size: 3 } as any);
        await cache.putMetadata({
            item: attachment(), filePath: sourcePath, sourceSizeBytes: 3, contentType: 'application/pdf',
            metadata: { pageCount: 2, pageLabels: null, pages, errorCode: null },
        });
        expect((await cache.getMetadata(ref, sourcePath))?.derivedPageLabels).toBeUndefined();
    });

    it('backfills derived labels from a cached payload read for metadata written without them', async () => {
        await putStructured(structuredResult({ '0': '1201', '1': '1202' }));
        expect((await cache.getMetadata(ref, sourcePath))?.derivedPageLabels).toBeUndefined();

        await cache.getResult(ref, 'structured', sourcePath);
        await settleWrites();

        const record = await cache.getMetadata(ref, sourcePath);
        expect(record?.derivedPageLabels).toEqual({ '0': '1201', '1': '1202' });
        expect(printedPageLabelsFromMetadata(record)).toEqual({ '0': '1201', '1': '1202' });
    });

    it('backfills derived labels from serialized payload bytes', async () => {
        await putStructured(structuredResult({ '1': '1202' }));
        const serialized = await cache.getSerializedResult(ref, 'structured', sourcePath);
        expect(serialized?.metadata.derivedPageLabels).toEqual({ '1': '1202' });
        await settleWrites();
        expect((await cache.getMetadata(ref, sourcePath))?.derivedPageLabels).toEqual({ '1': '1202' });
    });
});

describe('derivedPageLabelsFromSerializedResult', () => {
    const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

    it('reads the derived map of a serialized structured result', () => {
        expect(derivedPageLabelsFromSerializedResult(encode(structuredResult({ '0': '}{"', '1': 'x\\y' }))))
            .toEqual({ '0': '}{"', '1': 'x\\y' });
    });

    it('reports "none found" when the document has no derived map', () => {
        expect(derivedPageLabelsFromSerializedResult(encode(structuredResult()))).toBeNull();
    });

    it('reports unknown when the bytes do not reach the document', () => {
        const bytes = encode(structuredResult({ '0': '1' }));
        expect(derivedPageLabelsFromSerializedResult(bytes.subarray(0, 30))).toBeUndefined();
        expect(derivedPageLabelsFromSerializedResult(encode({ mode: 'markdown' }))).toBeUndefined();
    });
});

describe('page-label namespaces from cache metadata', () => {
    const record = {
        pageCount: 3,
        pageLabels: { '0': '1', '1': '2', '2': '3' },
        derivedPageLabels: { '1': '1202', '2': '1203' },
    } as any;

    it('reads printed labels from derived labels only', () => {
        expect(printedPageLabelsFromMetadata(record)).toEqual({ '1': '1202', '2': '1203' });
        expect(printedPageLabelsFromMetadata({ ...record, derivedPageLabels: undefined })).toBeNull();
        expect(printedPageLabelsFromMetadata({ ...record, derivedPageLabels: null })).toBeNull();
        expect(printedPageLabelsFromMetadata(null)).toBeNull();
    });

    it('reads Zotero locator labels from the labels the PDF declares, ignoring derived labels', () => {
        expect(zoteroLocatorPageLabelsFromMetadata(record)).toEqual({ '0': '1', '1': '2', '2': '3' });
        expect(zoteroLocatorPageLabelsFromMetadata({ ...record, pageLabels: {} })).toBeNull();
    });
});

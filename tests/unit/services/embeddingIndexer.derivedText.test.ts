import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

const mocks = vi.hoisted(() => ({
    generate: vi.fn(),
    bestAttachments: new Map<number, number>(),
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('@beaver/agent-core/transport/clients/embeddingsService', () => ({
    embeddingsService: { generateEmbeddingsWithRetry: mocks.generate },
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    getClientDateModifiedBatch: vi.fn(async () => new Map()),
}));
vi.mock('../../../src/services/documentExtraction/attachmentInfoBatch', () => ({
    getBestAttachmentBatch: vi.fn(async (parentIds: number[]) => new Map(
        parentIds.filter((id) => mocks.bestAttachments.has(id))
            .map((id) => [id, mocks.bestAttachments.get(id)!]),
    )),
}));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    liveAttachmentContentKind: () => 'pdf',
}));

import { EmbeddingIndexer } from '../../../src/services/embeddingIndexer';
import { EMBEDDING_TEXT_VERSION } from '../../../src/services/documentExtraction/embeddingText';

const TITLE = 'A monograph whose record has no abstract';
const BODY = 'Opening paragraph that describes the topic of the monograph.';

describe('EmbeddingIndexer with derived attachment text', () => {
    let conn: MockDBConnection;
    let connection: MockDBConnection;
    let db: BeaverDB;
    let indexer: EmbeddingIndexer;
    const items = new Map<number, any>();

    const regular = (id: number, title: string, abstract = '') => ({
        id, libraryID: 1, key: `ITEM${id}`, version: 1, deleted: false,
        isRegularItem: () => true,
        getField: (field: string) => field === 'title' ? title : field === 'abstractNote' ? abstract : '',
    });
    const pdf = (id: number, key: string) => ({
        id, libraryID: 1, key, getFilePathAsync: async () => `/tmp/${key}.pdf`,
    });

    async function storeText(key: string, itemId: number, body = BODY) {
        await db.upsertAttachmentEmbeddingText({
            libraryId: 1, zoteroKey: key, itemId, contentKind: 'pdf', fileMtimeMs: 0, fileSizeBytes: 0, fileHash: null,
            extractionSource: 'native', textVersion: EMBEDDING_TEXT_VERSION, title: null, titleSource: null,
            keywords: 'keyword one', body, bodySource: 'opening',
        });
    }

    beforeEach(async () => {
        vi.clearAllMocks();
        items.clear();
        mocks.bestAttachments.clear();
        conn = new MockDBConnection();
        connection = conn;
        db = new BeaverDB(conn as any);
        await db.initDatabase('0.99.0');
        indexer = new EmbeddingIndexer(db);
        (globalThis as any).Zotero.Beaver = {
            db, libraryScopeInitialized: true, searchableLibraryIds: [1],
            backgroundExtractor: { notify: vi.fn() },
        };
        (globalThis as any).Zotero.Items = {
            getAsync: vi.fn(async (ids: number[] | number) => Array.isArray(ids)
                ? ids.map((id) => items.get(id) ?? false)
                : items.get(ids) ?? false),
            loadDataTypes: vi.fn(async () => undefined),
            getIDFromLibraryAndKey: vi.fn((_libraryId: number, key: string) =>
                [...items.values()].find((item) => item.key === key)?.id ?? false),
        };
        mocks.generate.mockImplementation(async (texts: string[], ids: number[]) => ({
            embeddings: ids.map((item_id) => ({ item_id, embedding: [1, 2, 3, 4] })),
        }));
    });

    afterEach(async () => {
        await conn.closeDatabase();
        delete (globalThis as any).Zotero.Beaver;
    });

    it('embeds derived text for short-abstract items and records its attachment', async () => {
        items.set(1, regular(1, TITLE)).set(9, pdf(9, 'PDF00009'));
        mocks.bestAttachments.set(1, 9);
        await storeText('PDF00009', 9);

        const result = await indexer.indexItemIdsBatch([1]);

        expect(result.indexed).toBe(1);
        expect(mocks.generate).toHaveBeenCalledWith(
            [`${TITLE}\n\nKeywords: keyword one\n\n${BODY}`],
            [1],
        );
        expect(await db.getEmbedding(1)).toMatchObject({ source: 'attachment_text', source_attachment_id: 9 });
    });

    it('re-embeds a unit once its derived text lands and skips it when unchanged', async () => {
        items.set(1, regular(1, TITLE)).set(9, pdf(9, 'PDF00009'));
        mocks.bestAttachments.set(1, 9);
        await indexer.indexItemIdsBatch([1], { skipUnchanged: true });
        expect(await db.getEmbedding(1)).toMatchObject({ source: 'metadata' });

        await storeText('PDF00009', 9);
        const updated = await indexer.indexItemIdsBatch([1], { skipUnchanged: true });
        const unchanged = await indexer.indexItemIdsBatch([1], { skipUnchanged: true });

        expect(updated.indexed).toBe(1);
        expect(unchanged).toMatchObject({ indexed: 0, skipped: 1 });
        expect(await db.getEmbedding(1)).toMatchObject({ source: 'attachment_text' });
    });

    it('repoints an unchanged embedding at a duplicate attachment with identical text', async () => {
        items.set(1, regular(1, TITLE)).set(9, pdf(9, 'PDF00009')).set(10, pdf(10, 'PDF00010'));
        mocks.bestAttachments.set(1, 9);
        await storeText('PDF00009', 9);
        await storeText('PDF00010', 10);
        await indexer.indexItemIdsBatch([1]);
        vi.spyOn(indexer, 'getItemMetadataForLibrary').mockResolvedValue([
            { itemId: 1, libraryId: 1, clientDateModified: '' },
        ]);
        mocks.generate.mockClear();

        // The original is erased; the duplicate becomes the best attachment.
        mocks.bestAttachments.set(1, 10);
        expect(await indexer.indexItemIdsBatch([1], { skipUnchanged: true })).toMatchObject({ indexed: 0, skipped: 1 });
        expect(await db.getEmbedding(1)).toMatchObject({ source: 'attachment_text', source_attachment_id: 10 });

        mocks.bestAttachments.set(1, 9);
        expect((await indexer.computeIndexingDiff(1)).toIndex).toEqual([]);
        expect(await db.getEmbedding(1)).toMatchObject({ source_attachment_id: 9 });
        expect(mocks.generate).not.toHaveBeenCalled();
    });

    it('reports loaded items that are no longer indexable', async () => {
        items.set(1, regular(1, 'Tiny')).set(2, { ...regular(2, TITLE), deleted: true });
        const result = await indexer.indexItemIdsBatch([1, 2, 3]);
        expect(result.unindexable).toEqual([1, 2]);
        expect(mocks.generate).not.toHaveBeenCalled();
    });

    it('enqueues extraction from batch indexing only when asked', async () => {
        items.set(1, regular(1, TITLE)).set(9, pdf(9, 'PDF00009'));
        mocks.bestAttachments.set(1, 9);
        await indexer.indexItemIdsBatch([1]);
        expect(await db.peekBackgroundJobs()).toEqual([]);

        await indexer.indexItemIdsBatch([1], { extractions: {} });
        expect((await db.peekBackgroundJobs()).map((job) => job.zoteroKey)).toEqual(['PDF00009']);
    });

    it('diffs units by their resolved text, enqueues missing text and drops orphaned rows', async () => {
        items.set(1, regular(1, TITLE)).set(2, regular(2, 'An item with a complete abstract', 'x'.repeat(400)))
            .set(9, pdf(9, 'PDF00009')).set(10, pdf(10, 'PDF00010'));
        mocks.bestAttachments.set(1, 9);
        await storeText('GONE0001', 99);
        vi.spyOn(indexer, 'getItemMetadataForLibrary').mockResolvedValue([
            { itemId: 1, libraryId: 1, clientDateModified: '' },
            { itemId: 2, libraryId: 1, clientDateModified: '' },
        ]);

        const diff = await indexer.computeIndexingDiff(1);

        expect(diff).toEqual({ toIndex: [1, 2], toDelete: [], totalIndexable: 2 });
        expect((await db.peekBackgroundJobs()).map((job) => job.zoteroKey)).toEqual(['PDF00009']);
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual([]);

        // Once text exists, the stored metadata hash no longer matches.
        await indexer.indexItemIdsBatch([1, 2]);
        await storeText('PDF00009', 9);
        expect((await indexer.computeIndexingDiff(1)).toIndex).toEqual([1]);
    });

    it('re-checks stored text against the files on every full diff', async () => {
        items.set(1, regular(1, TITLE)).set(9, pdf(9, 'PDF00009'));
        mocks.bestAttachments.set(1, 9);
        await storeText('PDF00009', 9);
        vi.spyOn(indexer, 'getItemMetadataForLibrary').mockResolvedValue([
            { itemId: 1, libraryId: 1, clientDateModified: '' },
        ]);
        await indexer.computeIndexingDiff(1);
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual(['PDF00009']);

        // The file was edited while Zotero was closed.
        (globalThis as any).IOUtils.stat.mockResolvedValueOnce({ lastModified: 5, size: 0 });
        await indexer.computeIndexingDiff(1);
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual([]);
        expect((await db.peekBackgroundJobs()).map((job) => job.zoteroKey)).toEqual(['PDF00009']);
    });

    it('retries an outdated terminal verdict once, not on every full diff', async () => {
        items.set(1, regular(1, TITLE)).set(9, { ...pdf(9, 'PDF00009'), attachmentContentType: 'application/pdf' });
        mocks.bestAttachments.set(1, 9);
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'PDF00009', itemId: 9, contentKind: 'pdf' });
        await db.markAttachmentExtractFailure({
            libraryId: 1, zoteroKey: 'PDF00009', status: 'skipped', error: 'too_many_pages',
            attemptedAt: 0, extractionSource: 'recorded-for-an-older-schema',
        });
        vi.spyOn(indexer, 'getItemMetadataForLibrary').mockResolvedValue([
            { itemId: 1, libraryId: 1, clientDateModified: '' },
        ]);

        await indexer.computeIndexingDiff(1);
        expect((await db.peekBackgroundJobs()).map((job) => job.zoteroKey)).toEqual(['PDF00009']);

        // The retry fails the same way; its verdict now records the current source.
        await connection.queryAsync('DELETE FROM background_jobs');
        const observed = (await db.getAttachmentProcessingState(1, 'PDF00009'))!;
        expect(observed.extractStatus).toBeNull();
        const { observeAttachmentSource } = await import('../../../src/services/documentExtraction/sourceObservation');
        const current = await observeAttachmentSource(items.get(9), 'pdf');
        await db.markAttachmentExtractFailure({
            libraryId: 1, zoteroKey: 'PDF00009', status: 'skipped', error: 'too_many_pages',
            attemptedAt: 1, extractionSource: current!.identity,
        });
        await indexer.computeIndexingDiff(1);
        expect(await db.peekBackgroundJobs()).toEqual([]);
    });

    it('removes derived text of libraries that left the searchable scope', async () => {
        await storeText('PDF00009', 9);
        await db.upsertAttachmentEmbeddingText({
            libraryId: 2, zoteroKey: 'PDF00010', itemId: 10, contentKind: 'pdf', fileMtimeMs: 0,
            fileSizeBytes: 0, fileHash: null, extractionSource: 'native', textVersion: 1, title: null, titleSource: null,
            keywords: null, body: BODY, bodySource: 'opening',
        });
        await indexer.cleanupUnsyncedLibraries([1]);
        expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual(['PDF00009']);
        expect(await db.getAttachmentEmbeddingTextKeys(2)).toEqual([]);
    });
});

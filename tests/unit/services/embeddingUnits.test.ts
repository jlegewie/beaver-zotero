import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeaverDB } from '../../../src/services/database';
import { MockDBConnection } from '../../mocks/mockDBConnection';

const mocks = vi.hoisted(() => ({
    bestAttachments: new Map<number, number>(),
    signature: { mtime_ms: 10, size_bytes: 20 } as { mtime_ms: number; size_bytes: number } | null,
    observedIdentity: 'source-a',
    remoteHash: 'hash' as string | null,
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/services/documentExtraction/attachmentInfoBatch', () => ({
    getBestAttachmentBatch: vi.fn(async (parentIds: number[]) => new Map(
        parentIds.filter((id) => mocks.bestAttachments.has(id))
            .map((id) => [id, mocks.bestAttachments.get(id)!]),
    )),
}));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    liveAttachmentContentKind: (item: any) => item.kind ?? null,
}));
vi.mock('../../../src/services/documentFileIdentity', () => ({
    getFileSignature: vi.fn(async () => {
        if (!mocks.signature) throw new Error('stat failed');
        return mocks.signature;
    }),
    getRemoteFileHash: vi.fn(async () => mocks.remoteHash),
}));
vi.mock('../../../src/services/documentExtraction/sourceObservation', () => ({
    observeAttachmentSource: vi.fn(async () => ({ identity: mocks.observedIdentity, signature: null })),
}));

import {
    ABSTRACT_ENRICHMENT_THRESHOLD,
    EMBEDDABLE_CONTENT_TYPES,
    enqueueEmbeddingExtractions,
    MIN_CONTENT_LENGTH,
    needsDerivedText,
    resolveUnitText,
    resolveUnitsBatch,
    type ExtractionCandidate,
} from '../../../src/services/embeddingUnits';
import { getBestAttachmentBatch } from '../../../src/services/documentExtraction/attachmentInfoBatch';
import { EMBEDDING_TEXT_VERSION } from '../../../src/services/documentExtraction/embeddingText';
import { EMBEDDING_EXTRACT_PRIORITY } from '../../../src/services/backgroundProcessing/constants';

function regularItem(fields: { title?: string; abstract?: string }, overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        libraryID: 1,
        key: 'PARENT01',
        deleted: false,
        isRegularItem: () => true,
        getField: (field: string) => field === 'title'
            ? fields.title ?? ''
            : field === 'abstractNote' ? fields.abstract ?? '' : '',
        ...overrides,
    } as any;
}

const LONG_ABSTRACT = 'x'.repeat(ABSTRACT_ENRICHMENT_THRESHOLD);
const derived = { attachmentId: 9, keywords: 'topic, method', body: 'Derived body text about the topic.' };

describe('resolveUnitText', () => {
    it('embeds title + abstract when the abstract reaches the threshold, even with derived text', () => {
        const unit = resolveUnitText(regularItem({ title: 'A title', abstract: LONG_ABSTRACT }), derived);
        expect(unit).toEqual({
            text: `A title\n\n${LONG_ABSTRACT}`,
            source: 'metadata',
            sourceAttachmentId: null,
        });
    });

    it('replaces a short abstract with the title, keywords and derived body', () => {
        const unit = resolveUnitText(
            regularItem({ title: ' A title ', abstract: 'Short abstract.' }),
            derived,
        );
        expect(unit).toEqual({
            text: 'A title\n\nKeywords: topic, method\n\nDerived body text about the topic.',
            source: 'attachment_text',
            sourceAttachmentId: 9,
        });
    });

    it('omits the keyword line when there are no keywords', () => {
        const unit = resolveUnitText(regularItem({ title: 'A title' }), { ...derived, keywords: null });
        expect(unit?.text).toBe('A title\n\nDerived body text about the topic.');
    });

    it('falls back to metadata while no derived body exists', () => {
        const item = regularItem({ title: 'A reasonably descriptive title', abstract: 'Short abstract.' });
        expect(resolveUnitText(item, null)).toMatchObject({ source: 'metadata' });
        expect(resolveUnitText(item, { ...derived, body: '' })).toMatchObject({ source: 'metadata' });
    });

    it('applies the minimum content length to the final text', () => {
        const shortTitle = regularItem({ title: 'Brief' });
        expect(resolveUnitText(shortTitle, null)).toBeNull();
        expect(resolveUnitText(shortTitle, derived)).toMatchObject({ source: 'attachment_text' });
        expect(resolveUnitText(shortTitle, { ...derived, keywords: null, body: 'x'.repeat(MIN_CONTENT_LENGTH - 8) }))
            .toBeNull();
    });

    it('never indexes non-regular or trashed items', () => {
        expect(resolveUnitText(regularItem({ title: 'A title' }, { isRegularItem: () => false }), derived))
            .toBeNull();
        expect(resolveUnitText(regularItem({ title: 'A title' }, { deleted: true }), derived)).toBeNull();
    });
});

describe('needsDerivedText', () => {
    it('is true only for live regular items with an abstract under the threshold', () => {
        expect(needsDerivedText(regularItem({ abstract: 'x'.repeat(ABSTRACT_ENRICHMENT_THRESHOLD - 1) })))
            .toBe(true);
        expect(needsDerivedText(regularItem({ abstract: `  ${LONG_ABSTRACT}  ` }))).toBe(false);
        expect(needsDerivedText(regularItem({}, { deleted: true }))).toBe(false);
        expect(needsDerivedText(regularItem({}, { isRegularItem: () => false }))).toBe(false);
    });
});

describe('embedding extraction queue', () => {
    let connection: MockDBConnection;
    let db: BeaverDB;
    const notify = vi.fn();

    function attachment(overrides: Record<string, unknown> = {}) {
        return {
            id: 9,
            libraryID: 1,
            key: 'ATTACH01',
            kind: 'pdf',
            getFilePathAsync: async () => '/tmp/file.pdf',
            ...overrides,
        } as any;
    }

    async function storeRow(textVersion = EMBEDDING_TEXT_VERSION, key = 'ATTACH01') {
        await db.upsertAttachmentEmbeddingText({
            libraryId: 1, zoteroKey: key, itemId: 9, contentKind: 'pdf',
            fileMtimeMs: 10, fileSizeBytes: 20, fileHash: 'hash', extractionSource: 'native', textVersion,
            title: null, titleSource: null, keywords: null,
            body: 'Opening paragraph of the attached document.', bodySource: 'opening',
        });
        return (await db.getAttachmentEmbeddingTexts([{ libraryId: 1, zoteroKey: key }])).get(`1/${key}`)!;
    }

    function candidate(row: ExtractionCandidate['row'] = null, overrides: Record<string, unknown> = {}) {
        return { attachment: attachment(overrides), kind: 'pdf' as const, row };
    }

    beforeEach(async () => {
        vi.clearAllMocks();
        mocks.bestAttachments.clear();
        mocks.signature = { mtime_ms: 10, size_bytes: 20 };
        mocks.observedIdentity = 'source-a';
        mocks.remoteHash = 'hash';
        connection = new MockDBConnection();
        db = new BeaverDB(connection);
        await db.initDatabase('0.99.0');
        (globalThis as any).Zotero.Beaver = {
            db,
            libraryScopeInitialized: true,
            searchableLibraryIds: [1],
            backgroundExtractor: { notify },
        };
    });

    afterEach(async () => {
        await connection.closeDatabase();
        delete (globalThis as any).Zotero.Beaver;
    });

    it('enqueues a structured extraction in the embedding band for an attachment without text', async () => {
        expect(await enqueueEmbeddingExtractions([candidate()], db)).toBe(1);
        const [job] = await db.peekBackgroundJobs();
        expect(job).toMatchObject({
            jobType: 'document_extract', libraryId: 1, itemId: 9, zoteroKey: 'ATTACH01',
            contentKind: 'pdf', payloadKind: 'structured', priority: EMBEDDING_EXTRACT_PRIORITY,
        });
        expect(job.payload).toEqual({ content_kind: 'pdf', maxPages: null, timeoutSeconds: 120 });
        expect(notify).toHaveBeenCalledOnce();
    });

    it('keeps input order so the newest items are claimed first', async () => {
        const jobs = [candidate(null, { id: 3, key: 'NEWEST01' }), candidate(null, { id: 2, key: 'OLDER001' })];
        await enqueueEmbeddingExtractions(jobs, db);
        const first = await db.claimNextBackgroundJob(Date.now(), 60_000);
        expect(first?.zoteroKey).toBe('NEWEST01');
    });

    it('skips current rows and re-derives rows from an older text version', async () => {
        expect(await enqueueEmbeddingExtractions([candidate(await storeRow())], db)).toBe(0);
        expect(await enqueueEmbeddingExtractions([candidate(await storeRow(EMBEDDING_TEXT_VERSION - 1))], db))
            .toBe(1);
    });

    it('skips excluded libraries and files that are not available locally', async () => {
        expect(await enqueueEmbeddingExtractions([candidate(null, { libraryID: 2 })], db)).toBe(0);
        expect(await enqueueEmbeddingExtractions([candidate(null, { getFilePathAsync: async () => false })], db))
            .toBe(0);
        expect(await db.peekBackgroundJobs()).toEqual([]);
    });

    it.each([
        ['failed extraction', { extract: 'failed' }],
        ['skipped extraction', { extract: 'skipped' }],
        ['scan awaiting OCR', { ocr: 'needed' }],
        ['failed OCR', { ocr: 'failed' }],
    ])('respects a terminal ledger verdict (%s)', async (_label, verdict: { extract?: string; ocr?: string }) => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'ATTACH01', itemId: 9, contentKind: 'pdf' });
        if (verdict.extract) {
            await db.markAttachmentExtractFailure({
                libraryId: 1, zoteroKey: 'ATTACH01', status: verdict.extract as 'failed' | 'skipped',
                error: 'broken', attemptedAt: 0, extractionSource: 'source-a',
            });
        } else {
            await db.markAttachmentExtracted({
                libraryId: 1, zoteroKey: 'ATTACH01', expectedFileMtimeMs: null, expectedFileSizeBytes: null,
                previousDocumentHash: null, expectedExtractStatus: null, fileMtimeMs: 10, fileSizeBytes: 20,
                fileHash: 'hash', structuredDocumentHash: null, extractSchemaVersion: '1',
                extractionSource: 'source-a', ocrStatus: 'needed',
            });
            if (verdict.ocr === 'failed') await db.markAttachmentOcrFailed(1, 'ATTACH01', 'hash', 'no text');
        }
        expect(await enqueueEmbeddingExtractions([candidate()], db)).toBe(0);
        // A verdict recorded for another source is reopened and retried once.
        mocks.observedIdentity = 'source-b';
        expect(await enqueueEmbeddingExtractions([candidate()], db)).toBe(1);
        expect(await db.getAttachmentProcessingState(1, 'ATTACH01'))
            .toMatchObject({ extractStatus: null, lastError: 'source_recheck' });
    });

    it('extracts attachments that were extracted before derived text existed', async () => {
        await db.ensureAttachmentProcessingState({ libraryId: 1, zoteroKey: 'ATTACH01', itemId: 9, contentKind: 'pdf' });
        await db.markAttachmentExtracted({
            libraryId: 1, zoteroKey: 'ATTACH01', expectedFileMtimeMs: null, expectedFileSizeBytes: null,
            previousDocumentHash: null, expectedExtractStatus: null, fileMtimeMs: 10, fileSizeBytes: 20,
            fileHash: 'hash', structuredDocumentHash: 'doc', extractSchemaVersion: '1',
            extractionSource: 'source-a', ocrStatus: 'na',
        });
        expect(await enqueueEmbeddingExtractions([candidate()], db)).toBe(1);
    });

    it('merges with an existing background extraction at the lower priority', async () => {
        await db.enqueueBackgroundJob({
            jobType: 'document_extract', libraryId: 1, itemId: 9, zoteroKey: 'ATTACH01', contentKind: 'pdf',
            payloadKind: 'structured', priority: 110, payload: { content_kind: 'pdf', maxPages: null, timeoutSeconds: 120 },
            now: 0,
        });
        await enqueueEmbeddingExtractions([candidate()], db);
        const jobs = await db.peekBackgroundJobs();
        expect(jobs).toHaveLength(1);
        expect(jobs[0].priority).toBe(EMBEDDING_EXTRACT_PRIORITY);
    });

    describe('resolveUnitsBatch', () => {
        beforeEach(() => {
            (globalThis as any).Zotero.Items = {
                getAsync: vi.fn(async (ids: number[]) => ids.map((id) => attachment({ id, key: `ATT${id}` }))),
            };
        });

        it('uses the best readable attachment of short-abstract items only', async () => {
            mocks.bestAttachments.set(1, 9).set(2, 10);
            await storeRow(EMBEDDING_TEXT_VERSION, 'ATT9');
            const short = regularItem({ title: 'An item with a short abstract' });
            const long = regularItem({ title: 'Long-abstract item', abstract: LONG_ABSTRACT }, { id: 2 });

            const [first, second] = await resolveUnitsBatch([short, long], db);

            expect(getBestAttachmentBatch).toHaveBeenCalledWith([1], EMBEDDABLE_CONTENT_TYPES);
            expect(first.unit).toMatchObject({ source: 'attachment_text', sourceAttachmentId: 9 });
            expect(first.candidate).toMatchObject({ kind: 'pdf', row: { zoteroKey: 'ATT9' } });
            expect(second).toMatchObject({ unit: { source: 'metadata' }, candidate: null });
        });

        it('embeds metadata instead of stored text that fails the quality gate, without re-extracting', async () => {
            mocks.bestAttachments.set(1, 9);
            await db.upsertAttachmentEmbeddingText({
                libraryId: 1, zoteroKey: 'ATT9', itemId: 9, contentKind: 'pdf', fileMtimeMs: 10, fileSizeBytes: 20,
                fileHash: 'hash', extractionSource: 'ocr', textVersion: EMBEDDING_TEXT_VERSION, title: null,
                titleSource: null, keywords: null, body: 'Receipt. Store 15. Subtotal. Total', bodySource: 'outline',
            });
            const [resolution] = await resolveUnitsBatch([regularItem({ title: 'A descriptive title without any abstract' })], db);

            expect(resolution.unit?.source).toBe('metadata');
            expect(resolution.candidate?.row).not.toBeNull();
            expect(await enqueueEmbeddingExtractions([resolution.candidate!], db)).toBe(0);
        });

        it('offers a candidate without text while the unit indexes from metadata', async () => {
            mocks.bestAttachments.set(1, 9);
            const item = regularItem({ title: 'A descriptive title without any abstract' });
            const [resolution] = await resolveUnitsBatch([item], db);
            expect(resolution.unit).toMatchObject({ source: 'metadata' });
            expect(resolution.candidate).toMatchObject({ row: null, attachment: { id: 9 } });
        });

        it('keeps stored text when only the file signature changed', async () => {
            mocks.bestAttachments.set(1, 9);
            await storeRow(EMBEDDING_TEXT_VERSION, 'ATT9');
            (globalThis as any).Zotero.Items.getAsync = vi.fn(async (ids: number[]) =>
                ids.map((id) => attachment({ id, key: `ATT${id}`, attachmentHash: Promise.resolve('hash') })));
            mocks.signature = { mtime_ms: 99, size_bytes: 20 };
            const item = regularItem({ title: 'A descriptive title without any abstract' });

            const [resolution] = await resolveUnitsBatch([item], db, { checkFileIdentity: true });

            expect(resolution.unit?.source).toBe('attachment_text');
            const [row] = (await db.getAttachmentEmbeddingTexts([{ libraryId: 1, zoteroKey: 'ATT9' }])).values();
            expect(row).toMatchObject({ fileMtimeMs: 99, fileSizeBytes: 20 });
        });

        it('drops stored text of a checked attachment whose file changed', async () => {
            mocks.bestAttachments.set(1, 9);
            await storeRow(EMBEDDING_TEXT_VERSION, 'ATT9');
            const item = regularItem({ title: 'A descriptive title without any abstract' });

            // Unchecked or unchanged files keep their text.
            mocks.signature = { mtime_ms: 11, size_bytes: 20 };
            expect((await resolveUnitsBatch([item], db))[0].unit?.source).toBe('attachment_text');
            expect((await resolveUnitsBatch([item], db, { checkFileIdentity: new Set([8]) }))[0]
                .unit?.source).toBe('attachment_text');
            mocks.signature = { mtime_ms: 10, size_bytes: 20 };
            expect((await resolveUnitsBatch([item], db, { checkFileIdentity: true }))[0]
                .unit?.source).toBe('attachment_text');

            mocks.signature = { mtime_ms: 11, size_bytes: 20 };
            const [resolution] = await resolveUnitsBatch([item], db, { checkFileIdentity: new Set([9]) });
            expect(resolution.unit?.source).toBe('metadata');
            expect(resolution.candidate?.row).toBeNull();
            expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual([]);
            expect(await enqueueEmbeddingExtractions([resolution.candidate!], db)).toBe(1);
        });

        it('checks a file that is not available locally against the synced hash', async () => {
            mocks.bestAttachments.set(1, 9);
            await storeRow(EMBEDDING_TEXT_VERSION, 'ATT9');
            (globalThis as any).Zotero.Items.getAsync = vi.fn(async (ids: number[]) =>
                ids.map((id) => attachment({ id, key: `ATT${id}`, getFilePathAsync: async () => false })));
            const resolve = async () => (await resolveUnitsBatch(
                [regularItem({ title: 'A descriptive title without any abstract' })], db,
                { checkFileIdentity: true },
            ))[0];

            expect((await resolve()).unit?.source).toBe('attachment_text');
            mocks.remoteHash = null;
            expect((await resolve()).unit?.source).toBe('attachment_text');
            mocks.remoteHash = 'replaced';
            const replaced = await resolve();
            expect(replaced.unit?.source).toBe('metadata');
            expect(await db.getAttachmentEmbeddingTextKeys(1)).toEqual([]);
            // Remote-only files are never downloaded for the index.
            expect(await enqueueEmbeddingExtractions([replaced.candidate!], db)).toBe(0);
        });

        it('reports an item whose fields cannot be read without failing the batch', async () => {
            const broken = regularItem({}, { id: 3, getField: () => { throw new Error('corrupt'); } });
            const fine = regularItem({ title: 'A perfectly fine and descriptive title', abstract: LONG_ABSTRACT });
            const [first, second] = await resolveUnitsBatch([broken, fine], db);
            expect(first.error).toBeInstanceOf(Error);
            expect(second.unit).toMatchObject({ source: 'metadata' });
        });
    });
});

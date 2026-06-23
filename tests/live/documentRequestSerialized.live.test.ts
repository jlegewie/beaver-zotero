/**
 * Serialized PDF document-request wire path live suite.
 *
 * The public `/beaver/attachment/document` endpoint runs the handler in object
 * mode, so it never touches the perf path this branch adds. These tests drive
 * `handleZoteroDocumentRequest` in `responseMode: 'websocket'` (via the dev-only
 * `/beaver/test/document-serialized` endpoint) and assert on the materialized
 * wire output — the exact bytes the agent connection sends. Covered:
 *   - PDF success returns a `PreparedJsonMessage`: the `"content_kind":"pdf"`
 *     splice, `result` body, resolved attachment, and content type
 *   - content/result parity between the serialized path and the object path
 *     (markdown + structured) — the optimization must not change output
 *   - the document-cache byte path: cold extraction (`extractSerialized` +
 *     `putSerializedResult`) → warm hit (`getSerializedResult`, no re-dispatch)
 *   - cross-path cache compatibility: a payload written by either path is read
 *     by the other (the `isLikelySerializedPdfResult` probe accepts it)
 *   - cache-metadata parity (page count / labels / geometry) across paths
 *   - `guardSerializedPayloadSize`: `max_payload_bytes` rejects with
 *     `document_too_large` without parsing the result graph
 *   - the response `timing` breakdown (`cache_hit`/`cache_miss`, worker +
 *     payload metrics)
 *   - non-PDF (EPUB) and error outcomes fall back to a plain object response
 *   - the external-file branch of the serialized path
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *   - Fixture attachments seeded (SMALL_PDF, NORMAL_PDF, ENCRYPTED_PDF,
 *     NO_TEXT_PDF, GROUP_LIB_PDF, NON_PDF).
 *
 * Run with: `npm run test:live -- documentRequestSerialized`
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import {
    getCacheMetadata,
    getCachePayload,
    invalidateCache,
    workerStats,
} from '../helpers/cacheInspector';
import {
    fetchDocument,
    fetchDocumentSerialized,
    fetchExternalFileDocumentSerialized,
    attachExternalFileForTest,
    deleteExternalFileForTest,
    type DocumentExtractResult,
    type SerializedDocumentWireResponse,
} from '../helpers/zoteroHttpClient';
import {
    SMALL_PDF,
    NORMAL_PDF,
    ENCRYPTED_PDF,
    NO_TEXT_PDF,
    GROUP_LIB_PDF,
    NON_PDF,
} from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const SMALL_PDF_PAGE_COUNT = 2;

/** Generous timeout — whole-document extraction is slower than a metadata probe. */
const EXTRACT_OPTS = { timeout: 90_000 } as const;

/** Narrow a serialized wire response to the prepared PDF result, failing otherwise. */
function expectPreparedResult(
    res: SerializedDocumentWireResponse,
): NonNullable<DocumentExtractResult> {
    if (!res.prepared) {
        throw new Error(
            `Expected a prepared PDF wire message, got plain response: ` +
            `${res.response?.error_code} ${res.response?.error}`,
        );
    }
    if (!res.wire?.result) {
        throw new Error('Prepared wire message had no result body');
    }
    return res.wire.result;
}

/** Assert two extract results carry identical extracted page content. */
function expectSamePages(a: DocumentExtractResult, b: DocumentExtractResult): void {
    expect(a.mode).toBe(b.mode);
    expect(a.schemaVersion).toBe(b.schemaVersion);
    expect(a.content_kind).toBe(b.content_kind);
    expect(a.document.pageCount).toBe(b.document.pageCount);
    expect(a.document.pages.length).toBe(b.document.pages.length);
    for (let i = 0; i < a.document.pages.length; i++) {
        const pa = a.document.pages[i];
        const pb = b.document.pages[i];
        expect(pa.index).toBe(pb.index);
        expect(pa.label).toBe(pb.label);
        if (a.mode === 'markdown') {
            expect(pa.markdown).toBe(pb.markdown);
        } else {
            expect(pa.items).toEqual(pb.items);
        }
    }
}

describe('serialized document request — prepared wire output', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns a PreparedJsonMessage with the content_kind splice for a PDF', async () => {
        const res = await fetchDocumentSerialized(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS);
        const result = expectPreparedResult(res);

        // Envelope carries the wire metadata; the result was spliced in raw.
        expect(res.wire?.type).toBe('zotero_document');
        expect(res.wire?.content_kind).toBe('pdf');
        expect(res.wire?.content_type).toBe('application/pdf');
        expect(res.wire?.resolved_attachment).toMatchObject({
            library_id: SMALL_PDF.library_id,
            zotero_key: SMALL_PDF.zotero_key,
        });
        // The spliced result is the full extract result, content_kind first.
        expect(result.content_kind).toBe('pdf');
        expect(result.mode).toBe('structured');
        expect(result.document.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
        expect(result.document.pages).toHaveLength(SMALL_PDF_PAGE_COUNT);
        expect(Array.isArray(result.document.pages[0]?.items)).toBe(true);

        // wire_bytes reflects the materialized message, not the parsed graph.
        expect(typeof res.wire_bytes).toBe('number');
        expect(res.wire_bytes).toBeGreaterThan(0);
        expect(res.wire_bytes).toBe(
            new TextEncoder().encode(JSON.stringify(res.wire)).byteLength,
        );
    });

    it('returns a markdown PreparedJsonMessage when mode is markdown', async () => {
        const res = await fetchDocumentSerialized(SMALL_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        const result = expectPreparedResult(res);
        expect(result.mode).toBe('markdown');
        expect(result.content_kind).toBe('pdf');
        expect(typeof result.document.pages[0]?.markdown).toBe('string');
    });

    it('defaults to structured mode when mode is omitted', async () => {
        const res = await fetchDocumentSerialized(SMALL_PDF, {}, EXTRACT_OPTS);
        const result = expectPreparedResult(res);
        expect(result.mode).toBe('structured');
    });

    it('serves a group-library PDF through the serialized path', async () => {
        const res = await fetchDocumentSerialized(GROUP_LIB_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        const result = expectPreparedResult(res);
        expect(result.document.pageCount).toBeGreaterThan(0);
        expect(res.wire?.resolved_attachment?.library_id).toBe(GROUP_LIB_PDF.library_id);
    });
});

describe('serialized document request — parity with the object path', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('produces structured content identical to the object endpoint', async () => {
        // Warm the cache once via the serialized path, then read the SAME stored
        // payload back through both read paths — deterministic, byte-for-byte.
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        const serialized = expectPreparedResult(
            await fetchDocumentSerialized(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS),
        );
        const objectRes = await fetchDocument(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS);
        expect(objectRes.error ?? null).toBeNull();
        expect(objectRes.result).toBeTruthy();

        expectSamePages(serialized, objectRes.result as DocumentExtractResult);
    });

    it('produces markdown content identical to the object endpoint', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        const serialized = expectPreparedResult(
            await fetchDocumentSerialized(SMALL_PDF, { mode: 'markdown' }, EXTRACT_OPTS),
        );
        const objectRes = await fetchDocument(SMALL_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(objectRes.error ?? null).toBeNull();
        expectSamePages(serialized, objectRes.result as DocumentExtractResult);
    });
});

describe('serialized document request — cache round-trip', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('writes a payload on a cold miss and serves a warm hit without re-dispatch', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);

        // Cold miss → serialized extraction dispatches the worker once.
        await workerStats({ reset: true });
        const cold = expectPreparedResult(
            await fetchDocumentSerialized(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS),
        );
        const coldStats = await workerStats();
        expect(coldStats.stats.dispatchCounts.extractSerialized ?? 0).toBeGreaterThanOrEqual(1);

        // A clean metadata record + a structured payload row now exist.
        const record = await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(record?.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
        expect(record?.errorCode).toBeNull();
        const payload = await getCachePayload(SMALL_PDF.library_id, SMALL_PDF.zotero_key, 'structured');
        expect(payload?.payloadKind).toBe('structured');
        expect(payload?.contentKind).toBe('pdf');
        expect(payload?.payloadSizeBytes).toBeGreaterThan(0);

        // Warm hit → cached bytes, no new worker dispatch, identical content.
        await workerStats({ reset: true });
        const warm = expectPreparedResult(
            await fetchDocumentSerialized(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS),
        );
        const warmStats = await workerStats();
        expect(warmStats.stats.dispatchCounts.extractSerialized ?? 0).toBe(0);
        expectSamePages(warm, cold);
    });
});

describe('serialized document request — cross-path cache compatibility', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('reads an object-path-written payload from the serialized path (probe accepts)', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        // Object path writes the payload.
        const objectRes = await fetchDocument(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS);
        expect(objectRes.result).toBeTruthy();

        // Serialized read must hit the cache (no extractSerialized dispatch) and
        // return identical content — proving the probe accepts the object bytes.
        await workerStats({ reset: true });
        const serialized = expectPreparedResult(
            await fetchDocumentSerialized(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS),
        );
        const stats = await workerStats();
        expect(stats.stats.dispatchCounts.extractSerialized ?? 0).toBe(0);
        expectSamePages(serialized, objectRes.result as DocumentExtractResult);
    });

    it('reads a serialized-path-written payload from the object path', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        // Serialized path writes the payload.
        const serialized = expectPreparedResult(
            await fetchDocumentSerialized(SMALL_PDF, { mode: 'markdown' }, EXTRACT_OPTS),
        );

        // Object read must hit the cache (no extract dispatch) and match.
        await workerStats({ reset: true });
        const objectRes = await fetchDocument(SMALL_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        const stats = await workerStats();
        expect(stats.stats.dispatchCounts.extract ?? 0).toBe(0);
        expect(objectRes.result).toBeTruthy();
        expectSamePages(objectRes.result as DocumentExtractResult, serialized);
    });

    it('stores identical cache metadata via both paths', async () => {
        // Serialized path metadata.
        await invalidateCache(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);
        await fetchDocumentSerialized(NORMAL_PDF, { mode: 'structured' }, EXTRACT_OPTS);
        const serializedMeta = await getCacheMetadata(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
        );

        // Object path metadata for the same fixture.
        await invalidateCache(NORMAL_PDF.library_id, NORMAL_PDF.zotero_key);
        await fetchDocument(NORMAL_PDF, { mode: 'structured' }, EXTRACT_OPTS);
        const objectMeta = await getCacheMetadata(
            NORMAL_PDF.library_id,
            NORMAL_PDF.zotero_key,
        );

        expect(serializedMeta?.pageCount).toBe(objectMeta?.pageCount);
        expect(serializedMeta?.pageLabels).toEqual(objectMeta?.pageLabels);
        expect(serializedMeta?.documentMetadata?.content_kind).toBe('pdf');
        expect(objectMeta?.documentMetadata?.content_kind).toBe('pdf');
        // Page geometry is built by identical logic on both paths.
        expect((serializedMeta?.documentMetadata as any)?.pages).toEqual(
            (objectMeta?.documentMetadata as any)?.pages,
        );
    });
});

describe('serialized document request — payload-size guard', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('rejects with document_too_large when max_payload_bytes is tiny', async () => {
        const res = await fetchDocumentSerialized(
            SMALL_PDF,
            { mode: 'structured', max_payload_bytes: 100 },
            EXTRACT_OPTS,
        );
        expect(res.prepared).toBe(false);
        expect(res.response?.error_code).toBe('document_too_large');
        expect(res.response?.total_pages).toBe(SMALL_PDF_PAGE_COUNT);
    });

    it('returns the prepared result when max_payload_bytes is generous', async () => {
        const res = await fetchDocumentSerialized(
            SMALL_PDF,
            { mode: 'structured', max_payload_bytes: 50_000_000 },
            EXTRACT_OPTS,
        );
        const result = expectPreparedResult(res);
        expect(result.document.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
    });
});

describe('serialized document request — non-PDF and error fallbacks', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('falls back to a plain object response for an EPUB attachment', async () => {
        await invalidateCache(NON_PDF.library_id, NON_PDF.zotero_key);
        const res = await fetchDocumentSerialized(NON_PDF, { mode: 'markdown' }, EXTRACT_OPTS);

        // The serialized path is PDF-only; EPUB extraction returns a plain object.
        expect(res.prepared).toBe(false);
        expect(res.response?.content_kind).toBe('epub');
        const result = res.response?.result as any;
        expect(result?.content_kind).toBe('epub');
        expect(result?.sectionCount).toBeGreaterThan(0);
    });

    it('returns a plain error response for an encrypted PDF', async () => {
        await invalidateCache(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        const res = await fetchDocumentSerialized(ENCRYPTED_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(res.prepared).toBe(false);
        expect(res.response?.error_code).toBe('encrypted');
    });

    it('returns a plain error response for a scanned (no-text) PDF', async () => {
        await invalidateCache(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);
        const res = await fetchDocumentSerialized(NO_TEXT_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(res.prepared).toBe(false);
        expect(res.response?.error_code).toBe('no_text_layer');
    });

    it('rejects with too_many_pages before preparing a message', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        const res = await fetchDocumentSerialized(
            SMALL_PDF,
            { mode: 'structured', max_pages: 1 },
            EXTRACT_OPTS,
        );
        expect(res.prepared).toBe(false);
        expect(res.response?.error_code).toBe('too_many_pages');
        expect(res.response?.total_pages).toBe(SMALL_PDF_PAGE_COUNT);
    });

    it('reports an unresolvable attachment reference as a plain error', async () => {
        const res = await fetchDocumentSerialized(
            { library_id: 1, zotero_key: 'ZZZZZZZZ', description: 'missing' },
            { mode: 'structured' },
        );
        expect(res.prepared).toBe(false);
        expect(res.response?.error_code).toBeTruthy();
        expect(['not_found', 'invalid_format']).toContain(res.response?.error_code);
    });
});

describe('serialized document request — timing metadata', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('reports cache_miss timing with worker + payload metrics on a cold extraction', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        const res = await fetchDocumentSerialized(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS);
        expectPreparedResult(res);

        const timing = res.envelope?.timing ?? {};
        expect(timing.cache_miss).toBe(1);
        expect(timing.cache_hit).toBe(0);
        expect(timing.page_count).toBe(SMALL_PDF_PAGE_COUNT);
        expect(timing.file_size_bytes).toBeGreaterThan(0);
        expect(timing.payload_bytes).toBeGreaterThan(0);
        // A cold extraction owned a worker call.
        expect(typeof timing.worker_extract_ms).toBe('number');
        expect(typeof timing.serialize_ms).toBe('number');
    });

    it('reports cache_hit timing on a warm read', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        await fetchDocumentSerialized(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS);
        const warm = await fetchDocumentSerialized(SMALL_PDF, { mode: 'structured' }, EXTRACT_OPTS);
        expectPreparedResult(warm);

        const timing = warm.envelope?.timing ?? {};
        expect(timing.cache_hit).toBe(1);
        expect(timing.cache_miss).toBe(0);
        // Serialized warm hits still report the cached payload size.
        expect(timing.payload_bytes).toBeGreaterThan(0);
    });
});

describe('serialized document request — external files', () => {
    const FIXTURE_PDF = resolve(
        __dirname,
        '../fixtures/pdfs/extract-public/legewie-fagan__p0/source.pdf',
    );
    const attachedKeys: string[] = [];

    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    afterAll(async () => {
        if (!available) return;
        for (const key of attachedKeys) {
            await deleteExternalFileForTest(key).catch(() => undefined);
        }
    });

    it('serves an external-file PDF through the serialized path', async () => {
        const attach = await attachExternalFileForTest(FIXTURE_PDF);
        if (!attach.ok || !attach.record) {
            throw new Error(`attach failed: ${attach.reason} ${attach.error}`);
        }
        attachedKeys.push(attach.record.extKey);

        const res = await fetchExternalFileDocumentSerialized(
            attach.record.extKey,
            { mode: 'markdown' },
            EXTRACT_OPTS,
        );
        const result = expectPreparedResult(res);
        expect(res.wire?.external_file_key).toBe(attach.record.extKey);
        expect(res.wire?.content_kind).toBe('pdf');
        expect(result.content_kind).toBe('pdf');
        expect(result.document.pageCount).toBeGreaterThan(0);

        // Second read is a warm cache hit with identical content.
        const warm = await fetchExternalFileDocumentSerialized(
            attach.record.extKey,
            { mode: 'markdown' },
            EXTRACT_OPTS,
        );
        expectSamePages(expectPreparedResult(warm), result);
    }, 120_000);
});

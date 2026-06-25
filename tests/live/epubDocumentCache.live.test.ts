/**
 * EPUB document-cache live suite (`/beaver/attachment/document` +
 * `/beaver/test/cache-metadata` / `/beaver/test/cache-payload`).
 *
 * Covers how EPUB extractions are persisted in the document cache:
 *   - a successful extraction writes an `epub` metadata row whose
 *     `documentMetadata` blob carries the per-section summary (index, rawHref,
 *     itemCount) and a `sectionCount` matching the extracted document; the
 *     PDF-shaped derived fields (pageCount/pageLabels/pages) stay null
 *   - exactly one structured payload row is written (EPUBs have no markdown
 *     payload), tagged `content_kind: 'epub'`
 *   - warm reads are served from the cached payload without re-extracting
 *     (the payload row survives byte-identical)
 *   - `mode: 'structured'` requests return the same EPUB document shape
 *   - cache invalidation removes both the metadata and payload rows
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - Fixture attachment seeded (NON_PDF — a multi-section EPUB).
 *
 * Run with: `npm run test:live -- epubDocumentCache`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import {
    getCacheMetadata,
    getCachePayload,
    invalidateCache,
} from '../helpers/cacheInspector';
import { fetchDocument, type DocumentResponse } from '../helpers/zoteroHttpClient';
import { NON_PDF } from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const EXTRACT_OPTS = { timeout: 90_000 } as const;
const EXTRACT_TIMEOUT = 90_000;

/** Extract the EPUB document payload from a document response. */
function expectEpubResult(res: DocumentResponse): any {
    expect(res.error ?? null).toBeNull();
    expect(res.error_code ?? null).toBeNull();
    expect(res.content_kind).toBe('epub');
    const result = res.result as any;
    expect(result?.content_kind).toBe('epub');
    expect(result?.sectionCount).toBeGreaterThan(0);
    return result;
}

describe('EPUB extractions persist to the document cache', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('writes an epub metadata row with a per-section summary', async () => {
        await invalidateCache(NON_PDF.library_id, NON_PDF.zotero_key);

        const res = await fetchDocument(NON_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        const document = expectEpubResult(res);

        const record = await getCacheMetadata(NON_PDF.library_id, NON_PDF.zotero_key);
        expect(record).toBeTruthy();
        expect(record!.contentKind).toBe('epub');
        expect(record!.errorCode).toBeNull();
        expect(record!.extractionSchemaVersion).toBe(document.schemaVersion);

        // PDF-shaped derived fields don't apply to EPUB rows.
        expect(record!.pageCount).toBeNull();
        expect(record!.pageLabels).toBeNull();
        expect(record!.pages).toBeNull();

        const meta = record!.documentMetadata;
        expect(meta?.content_kind).toBe('epub');
        if (meta?.content_kind !== 'epub') throw new Error('expected epub metadata blob');
        expect(meta.sectionCount).toBe(document.sectionCount);
        expect(meta.sections).toHaveLength(document.sectionCount);
        expect(meta.sections[0]).toMatchObject({ index: 0 });
        expect(typeof meta.sections[0].rawHref).toBe('string');
        expect(typeof meta.sections[0].itemCount).toBe('number');
    }, EXTRACT_TIMEOUT);

    it('stores a single structured payload row and no markdown payload', async () => {
        const structured = await getCachePayload(
            NON_PDF.library_id,
            NON_PDF.zotero_key,
            'structured',
        );
        expect(structured).toBeTruthy();
        expect(structured!.payloadKind).toBe('structured');
        expect(structured!.contentKind).toBe('epub');
        expect(structured!.payloadSizeBytes).toBeGreaterThan(0);
        expect(structured!.payloadSha256).toBeTruthy();

        const markdown = await getCachePayload(
            NON_PDF.library_id,
            NON_PDF.zotero_key,
            'markdown',
        );
        expect(markdown).toBeNull();
    }, EXTRACT_TIMEOUT);

    it('serves warm reads from the cached payload without re-extracting', async () => {
        const cold = await fetchDocument(NON_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        const coldDocument = expectEpubResult(cold);
        const payloadBefore = await getCachePayload(
            NON_PDF.library_id,
            NON_PDF.zotero_key,
            'structured',
        );
        expect(payloadBefore).toBeTruthy();

        const warm = await fetchDocument(NON_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        const warmDocument = expectEpubResult(warm);
        expect(warmDocument.sectionCount).toBe(coldDocument.sectionCount);

        // A cache hit keeps the payload row (and its bytes) untouched.
        const payloadAfter = await getCachePayload(
            NON_PDF.library_id,
            NON_PDF.zotero_key,
            'structured',
        );
        expect(payloadAfter?.id).toBe(payloadBefore!.id);
        expect(payloadAfter?.payloadSha256).toBe(payloadBefore!.payloadSha256);
    }, EXTRACT_TIMEOUT);

    it('returns the same EPUB document for structured-mode requests', async () => {
        const markdownRes = await fetchDocument(NON_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        const structuredRes = await fetchDocument(NON_PDF, { mode: 'structured' }, EXTRACT_OPTS);

        const markdownDoc = expectEpubResult(markdownRes);
        const structuredDoc = expectEpubResult(structuredRes);
        expect(structuredDoc.sectionCount).toBe(markdownDoc.sectionCount);
        expect(structuredDoc.schemaVersion).toBe(markdownDoc.schemaVersion);
    }, EXTRACT_TIMEOUT);

    it('removes both rows on cache invalidation', async () => {
        await invalidateCache(NON_PDF.library_id, NON_PDF.zotero_key);

        const record = await getCacheMetadata(NON_PDF.library_id, NON_PDF.zotero_key);
        expect(record).toBeNull();
        const payload = await getCachePayload(
            NON_PDF.library_id,
            NON_PDF.zotero_key,
            'structured',
        );
        expect(payload).toBeNull();
    }, EXTRACT_TIMEOUT);
});

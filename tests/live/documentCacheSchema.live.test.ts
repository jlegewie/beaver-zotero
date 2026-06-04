/**
 * Document-cache schema-refactor live suite.
 *
 * Covers the refactor that consolidated the document-cache tables onto a
 * content-kind discriminator: the `page_count` / `page_labels_json` /
 * `pages_json` columns were replaced by a single `content_kind` +
 * `document_metadata_json` pair on `document_cache_metadata`, and a
 * `content_kind` column was added to `document_cache_payloads`.
 *
 * These tests run against the real Zotero SQLite database (not the unit-test
 * better-sqlite3 mock), so they are the regression net for:
 *   - the reordered `SELECT` column indices on both tables
 *     (`getResultByIndex` mapping in `selectDocumentCacheMetadata` /
 *     `selectDocumentCachePayloads`)
 *   - the round-trip of `content_kind` + `document_metadata_json` through
 *     INSERT … ON CONFLICT and back out
 *   - the derived `pageCount` / `pageLabels` / `pages` accessors now reading
 *     from the PDF metadata blob
 *   - content-kind-aware extraction schema versions on both tables
 *
 * Each fixture is extracted at most once per run (see `ensureExtracted`) and
 * the remaining assertions read the warm record back, which exercises the same
 * SELECT round-trip while keeping load off the MuPDF worker.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *   - Fixture attachments seeded (SMALL_PDF, NORMAL_PDF, ENCRYPTED_PDF,
 *     NO_TEXT_PDF, GROUP_LIB_PDF).
 *
 * Run with: `npm run test:live -- documentCacheSchema`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import {
    clearAllCache,
    getCacheMetadata,
    getCachePayload,
    invalidateCache,
    readAttachment,
    triggerFileStatus,
    type CacheMetadataRecord,
} from '../helpers/cacheInspector';
import {
    SMALL_PDF,
    NORMAL_PDF,
    ENCRYPTED_PDF,
    NO_TEXT_PDF,
    GROUP_LIB_PDF,
    type AttachmentFixture,
} from '../helpers/fixtures';
import { SCHEMA_VERSION } from '../../src/beaver-extract/schema/schema';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const SMALL_PDF_PAGE_COUNT = 2;

function attachmentId(fix: AttachmentFixture): string {
    return `${fix.library_id}-${fix.zotero_key}`;
}

// One cold extraction per fixture per run; later tests reuse the warm record so
// the leaky MuPDF worker is not re-invoked for every assertion.
const extracted = new Set<string>();

async function ensureExtracted(fix: AttachmentFixture): Promise<CacheMetadataRecord | null> {
    const key = `${fix.library_id}-${fix.zotero_key}`;
    if (!extracted.has(key)) {
        await invalidateCache(fix.library_id, fix.zotero_key);
        await triggerFileStatus(fix.library_id, fix.zotero_key);
        extracted.add(key);
    }
    return getCacheMetadata(fix.library_id, fix.zotero_key);
}

describe('document_cache_metadata: content_kind + document_metadata_json', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('persists content_kind "pdf" and a pdf metadata blob for a successful extraction', async () => {
        const record = await ensureExtracted(SMALL_PDF);

        expect(record).not.toBeNull();
        expect(record?.errorCode).toBeNull();
        expect(record?.contentKind).toBe('pdf');

        // The durable blob carries the discriminator and the per-kind payload.
        expect(record?.documentMetadata).not.toBeNull();
        expect(record?.documentMetadata?.content_kind).toBe('pdf');
        expect(record?.documentMetadata?.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
        expect(Array.isArray(record?.documentMetadata?.pages)).toBe(true);
        expect(record?.documentMetadata?.pages).toHaveLength(SMALL_PDF_PAGE_COUNT);
    });

    it('exposes derived pageCount/pageLabels/pages that mirror the metadata blob', async () => {
        const record = await ensureExtracted(SMALL_PDF);
        expect(record).not.toBeNull();

        // The top-level accessors are now projections of documentMetadata; if
        // the SELECT indices or the projection drifted these would diverge.
        expect(record?.pageCount).toBe(record?.documentMetadata?.pageCount);
        expect(record?.pages).toEqual(record?.documentMetadata?.pages);
        expect(record?.pageLabels).toEqual(record?.documentMetadata?.pageLabels);
    });

    it('round-trips pageLabels inside the metadata blob', async () => {
        const record = await ensureExtracted(NORMAL_PDF);
        expect(record).not.toBeNull();
        expect(record?.contentKind).toBe('pdf');

        // pageLabels is an object map (possibly empty) — never an array or a
        // raw JSON string. This guards the JSON parse/stringify round-trip.
        const labels = record?.documentMetadata?.pageLabels;
        expect(labels === null || (typeof labels === 'object' && !Array.isArray(labels))).toBe(true);
        expect(record?.pageLabels).toEqual(labels);
    });

    it('reports the pdf extraction schema version and metadata format version', async () => {
        const record = await ensureExtracted(SMALL_PDF);
        expect(record).not.toBeNull();
        expect(record?.extractionSchemaVersion).toBe(SCHEMA_VERSION);
        expect(record?.metadataFormatVersion).toBe(1);
    });

    it('keeps content_kind "pdf" and a pdf blob for an encrypted PDF error record', async () => {
        const record = await ensureExtracted(ENCRYPTED_PDF);

        expect(record?.errorCode).toBe('encrypted');
        expect(record?.contentKind).toBe('pdf');
        // Error records still write a pdf-shaped blob, with nulls for geometry.
        expect(record?.documentMetadata?.content_kind).toBe('pdf');
        expect(record?.documentMetadata?.pageCount).toBeNull();
        expect(record?.documentMetadata?.pages).toBeNull();
        expect(record?.pages).toBeNull();
    });

    it('keeps content_kind "pdf" and a metadata blob for a no_text_layer record', async () => {
        const record = await ensureExtracted(NO_TEXT_PDF);

        expect(record?.errorCode).toBe('no_text_layer');
        expect(record?.contentKind).toBe('pdf');
        expect(record?.documentMetadata).not.toBeNull();
        expect(record?.documentMetadata?.content_kind).toBe('pdf');
    });

    it('round-trips content_kind for a group-library PDF', async () => {
        const record = await ensureExtracted(GROUP_LIB_PDF);

        expect(record).not.toBeNull();
        expect(record?.libraryId).toBe(GROUP_LIB_PDF.library_id);
        expect(record?.contentKind).toBe('pdf');
        expect(record?.documentMetadata?.content_kind).toBe('pdf');
    });
});

describe('document_cache_payloads: content_kind column', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('persists content_kind on the payload row that mirrors the metadata row', async () => {
        // Warm the markdown payload via read_attachment (idempotent — a second
        // call after the metadata row exists is a cache hit, not a re-extract).
        await ensureExtracted(SMALL_PDF);
        await readAttachment({
            attachment_id: attachmentId(SMALL_PDF),
            start_page: 1,
            end_page: SMALL_PDF_PAGE_COUNT,
        });

        const metadata = await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        const payload = await getCachePayload(SMALL_PDF.library_id, SMALL_PDF.zotero_key, 'markdown');

        expect(metadata).not.toBeNull();
        expect(payload).not.toBeNull();
        expect(payload?.mode).toBe('markdown');
        // The payload's content_kind, schema version, and FK must agree with
        // the metadata row — the freshness check in `isPayloadRowFresh` now
        // compares content_kind, so a drift here would silently drop the cache.
        expect(payload?.contentKind).toBe('pdf');
        expect(payload?.contentKind).toBe(metadata?.contentKind);
        expect(payload?.extractionSchemaVersion).toBe(SCHEMA_VERSION);
        expect(payload?.extractionSchemaVersion).toBe(metadata?.extractionSchemaVersion);
        expect(payload?.metadataId).toBe(metadata?.id);
        expect(payload?.cacheFormatVersion).toBe(1);
    });

    it('serves a warm cached read after the payload is persisted', async () => {
        // The metadata + markdown payload are already warm from the previous
        // test; this read must validate the payload row against the metadata
        // (including content_kind) and return the same content rather than
        // dropping it.
        const result = await readAttachment({
            attachment_id: attachmentId(SMALL_PDF),
            start_page: 1,
            end_page: SMALL_PDF_PAGE_COUNT,
        });

        expect(typeof result).toBe('string');
        expect(result).toContain(`Total pages: ${SMALL_PDF_PAGE_COUNT}`);

        const payload = await getCachePayload(SMALL_PDF.library_id, SMALL_PDF.zotero_key, 'markdown');
        expect(payload?.contentKind).toBe('pdf');
    });

    it('returns null for both rows after the cache is cleared', async () => {
        // Runs last: wipes every document-cache row + payload file.
        await clearAllCache();
        extracted.clear();

        const metadata = await getCacheMetadata(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        const payload = await getCachePayload(SMALL_PDF.library_id, SMALL_PDF.zotero_key, 'markdown');
        expect(metadata).toBeNull();
        expect(payload).toBeNull();
    });
});

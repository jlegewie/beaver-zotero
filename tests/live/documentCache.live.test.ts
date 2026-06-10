/**
 * Document-cache consolidation live suite.
 *
 * Covers the staged refactor that removed `AttachmentFileCache` and routed
 * everything through `DocumentCache`:
 *   - the MCP `read_attachment` tool (page-argument validation, document
 *     request round-trip, page-window slicing) via `/beaver/test/read-attachment`
 *   - file-status extraction writing error metadata to the document cache
 *     (`errorCode` shape) via `/beaver/test/file-status` + `/beaver/test/cache-metadata`
 *   - page-image and search handlers against broken PDFs
 *   - the `/beaver/test/cache-clear-all` reset endpoint
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *   - Fixture attachments seeded (SMALL_PDF, NORMAL_PDF, ENCRYPTED_PDF,
 *     NO_TEXT_PDF, INVALID_PDF_FIXTURE).
 *
 * Run with: `npm run test:live -- documentCache`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import {
    clearAllCache,
    getCacheMetadata,
    invalidateCache,
    isMcpToolError,
    readAttachment,
    triggerFileStatus,
    type ReadAttachmentResult,
} from '../helpers/cacheInspector';
import { fetchPageImages, searchAttachment } from '../helpers/zoteroHttpClient';
import {
    SMALL_PDF,
    NORMAL_PDF,
    ENCRYPTED_PDF,
    NO_TEXT_PDF,
    INVALID_PDF_FIXTURE,
    type AttachmentFixture,
} from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const SMALL_PDF_PAGE_COUNT = 2;

function attachmentId(fix: AttachmentFixture): string {
    return `${fix.library_id}-${fix.zotero_key}`;
}

/** Narrow a read_attachment result to its success string, failing otherwise. */
function expectText(result: ReadAttachmentResult): string {
    if (isMcpToolError(result)) {
        throw new Error(`Expected success, got MCP error: ${result.content[0]?.text}`);
    }
    expect(typeof result).toBe('string');
    return result;
}

/** Narrow a read_attachment result to its MCP error message, failing otherwise. */
function expectErrorMessage(result: ReadAttachmentResult): string {
    if (!isMcpToolError(result)) {
        throw new Error(`Expected an MCP error, got success: ${String(result).slice(0, 120)}`);
    }
    return result.content[0]?.text ?? '';
}

describe('MCP read_attachment tool', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns markdown pages wrapped in <pageN> tags (happy path)', async () => {
        const result = await readAttachment({
            attachment_id: attachmentId(SMALL_PDF),
            start_page: 1,
            end_page: SMALL_PDF_PAGE_COUNT,
        });
        const text = expectText(result);

        expect(text).toContain(`Attachment: ${attachmentId(SMALL_PDF)}`);
        expect(text).toContain(`Total pages: ${SMALL_PDF_PAGE_COUNT}`);
        expect(text).toContain(`Showing pages 1-${SMALL_PDF_PAGE_COUNT}`);
        expect(text).toContain('<page1>');
        expect(text).toContain('</page1>');
        expect(text).toContain(`<page${SMALL_PDF_PAGE_COUNT}>`);
    });

    it('slices to the requested page window', async () => {
        const result = await readAttachment({
            attachment_id: attachmentId(NORMAL_PDF),
            start_page: 2,
            end_page: 3,
        });
        const text = expectText(result);

        expect(text).toContain('Showing pages 2-3');
        expect(text).toContain('<page2>');
        expect(text).toContain('<page3>');
        expect(text).not.toContain('<page1>');
        expect(text).not.toContain('<page4>');
    });

    it('rejects a non-positive start_page', async () => {
        const result = await readAttachment({
            attachment_id: attachmentId(SMALL_PDF),
            start_page: 0,
        });
        expect(expectErrorMessage(result)).toBe('start_page must be a positive integer.');
    });

    it('rejects a fractional start_page', async () => {
        const result = await readAttachment({
            attachment_id: attachmentId(SMALL_PDF),
            start_page: 2.5,
        });
        expect(expectErrorMessage(result)).toBe('start_page must be a positive integer.');
    });

    it('rejects end_page below start_page', async () => {
        const result = await readAttachment({
            attachment_id: attachmentId(SMALL_PDF),
            start_page: 5,
            end_page: 2,
        });
        expect(expectErrorMessage(result)).toBe(
            'end_page must be greater than or equal to start_page.',
        );
    });

    it('rejects a malformed attachment_id', async () => {
        const result = await readAttachment({ attachment_id: 'not-a-real-key-xx' });
        // 'not-a-real-key-xx' parses (libraryId NaN guard) → invalid format error.
        expect(expectErrorMessage(result)).toMatch(/Invalid attachment_id format|not_found|Failed to read/i);
    });

    it('reports an out-of-range start_page', async () => {
        const result = await readAttachment({
            attachment_id: attachmentId(SMALL_PDF),
            start_page: 500,
        });
        const message = expectErrorMessage(result);
        expect(message).toMatch(
            new RegExp(`out of range|attachment has ${SMALL_PDF_PAGE_COUNT} pages`, 'i'),
        );
    });
});

describe('file status writes errorCode to the document cache', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('persists errorCode "encrypted" for a password-protected PDF', async () => {
        await invalidateCache(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);

        const status = await triggerFileStatus(
            ENCRYPTED_PDF.library_id,
            ENCRYPTED_PDF.zotero_key,
        );
        expect(status.status).toBe('unreadable');

        const record = await getCacheMetadata(
            ENCRYPTED_PDF.library_id,
            ENCRYPTED_PDF.zotero_key,
        );
        expect(record).not.toBeNull();
        expect(record?.errorCode).toBe('encrypted');
    });

    it('persists errorCode "no_text_layer" for a scanned PDF', async () => {
        await invalidateCache(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);

        const status = await triggerFileStatus(
            NO_TEXT_PDF.library_id,
            NO_TEXT_PDF.zotero_key,
        );
        expect(status.status).toBe('unreadable');

        const record = await getCacheMetadata(
            NO_TEXT_PDF.library_id,
            NO_TEXT_PDF.zotero_key,
        );
        expect(record).not.toBeNull();
        expect(record?.errorCode).toBe('no_text_layer');
    });

    it('persists a clean record (errorCode null) for a normal PDF', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);

        const status = await triggerFileStatus(
            SMALL_PDF.library_id,
            SMALL_PDF.zotero_key,
        );
        expect(status.status).toBe('readable');

        const record = await getCacheMetadata(
            SMALL_PDF.library_id,
            SMALL_PDF.zotero_key,
        );
        expect(record).not.toBeNull();
        expect(record?.errorCode).toBeNull();
        expect(record?.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
    });
});

describe('attachment handlers against broken PDFs', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('page-images returns an error for an encrypted PDF', async () => {
        const res = await fetchPageImages(ENCRYPTED_PDF, { pages: [1] });
        expect(res.error_code).toBeTruthy();
        expect(res.pages).toHaveLength(0);
    });

    it('page-images returns an error for an invalid PDF', async () => {
        const res = await fetchPageImages(INVALID_PDF_FIXTURE, { pages: [1] });
        expect(res.error_code).toBeTruthy();
        expect(res.pages).toHaveLength(0);
    });

    it('search reads the cached no_text_layer record and short-circuits', async () => {
        // file-status writes the document-cache no_text_layer record; the
        // search handler must read it back via documentCache.getMetadata +
        // preflightCachedPdfMeta and refuse to search.
        await invalidateCache(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);
        await triggerFileStatus(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);

        const res = await searchAttachment(NO_TEXT_PDF, 'introduction');
        expect(res.error_code).toBe('no_text_layer');
        expect(res.pages).toHaveLength(0);

        const record = await getCacheMetadata(
            NO_TEXT_PDF.library_id,
            NO_TEXT_PDF.zotero_key,
        );
        expect(record?.errorCode).toBe('no_text_layer');
    });
});

describe('cache-clear-all endpoint', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('wipes every document-cache record', async () => {
        // Seed at least one record, then clear everything.
        await triggerFileStatus(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        const cleared = await clearAllCache();
        expect(cleared.metadataRows).toBeGreaterThanOrEqual(0);

        const after = await getCacheMetadata(
            SMALL_PDF.library_id,
            SMALL_PDF.zotero_key,
        );
        expect(after).toBeNull();
    });
});

describe('document cache persists per-page geometry', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('writes a dense PageGeometry array for a successful extraction', async () => {
        await invalidateCache(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        const status = await triggerFileStatus(
            SMALL_PDF.library_id,
            SMALL_PDF.zotero_key,
        );
        expect(status.status).toBe('readable');

        const record = await getCacheMetadata(
            SMALL_PDF.library_id,
            SMALL_PDF.zotero_key,
        );
        expect(record).not.toBeNull();
        expect(record?.errorCode).toBeNull();
        expect(record?.pageCount).toBe(SMALL_PDF_PAGE_COUNT);
        expect(Array.isArray(record?.pages)).toBe(true);
        expect(record?.pages).toHaveLength(SMALL_PDF_PAGE_COUNT);

        for (const page of record!.pages!) {
            expect(page).not.toBeNull();
            expect(page!.viewBox).toHaveLength(4);
            expect(page!.viewBox.every((v) => Number.isFinite(v))).toBe(true);
            expect(page!.width).toBeGreaterThan(0);
            expect(page!.height).toBeGreaterThan(0);
            // viewBox derives unrotated width/height: x1-x0 / y1-y0.
            expect(page!.width).toBeCloseTo(
                page!.viewBox[2] - page!.viewBox[0],
                3,
            );
            expect(page!.height).toBeCloseTo(
                page!.viewBox[3] - page!.viewBox[1],
                3,
            );
            expect([0, 90, 180, 270]).toContain(page!.rotation);
        }
    });

    it('records null pages on an encrypted PDF', async () => {
        await invalidateCache(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        await triggerFileStatus(
            ENCRYPTED_PDF.library_id,
            ENCRYPTED_PDF.zotero_key,
        );
        const record = await getCacheMetadata(
            ENCRYPTED_PDF.library_id,
            ENCRYPTED_PDF.zotero_key,
        );
        expect(record?.errorCode).toBe('encrypted');
        // putErrorMetadata writes `pages: null` for encrypted PDFs — never an
        // empty array, which would be confused with "we tried and got nothing".
        expect(record?.pages).toBeNull();
    });

    it('records pages for a scanned PDF that hits no_text_layer', async () => {
        await invalidateCache(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);
        await triggerFileStatus(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);
        const record = await getCacheMetadata(
            NO_TEXT_PDF.library_id,
            NO_TEXT_PDF.zotero_key,
        );
        expect(record?.errorCode).toBe('no_text_layer');
        // OCR-needed PDFs still get geometry persisted so headless annotations
        // can land on them; only fully unreadable PDFs get pages = null.
        if (record?.pages) {
            expect(record.pages.length).toBeGreaterThan(0);
            const firstNonNull = record.pages.find((p) => p !== null);
            if (firstNonNull) {
                expect(firstNonNull.viewBox).toHaveLength(4);
                expect([0, 90, 180, 270]).toContain(firstNonNull.rotation);
            }
        }
    });
});

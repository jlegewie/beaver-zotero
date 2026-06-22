/**
 * Item-validation live suite (`/beaver/test/validate-item` +
 * `/beaver/test/validate-regular-item`).
 *
 * Exercises `itemValidationManager.validateItem` / `validateRegularItem`
 * through the dev-only validate endpoints. Covers the full result shape
 * (`state` / `severity` / `reason` / `status_code` / `content_kind` /
 * `page_count`) and the gating in `resultFromAttachmentInfo`:
 *   - content-kind classification (PDF readable/encrypted/scanned, text,
 *     image, linked-URL, snapshot, unsupported octet-stream)
 *   - capability-dependent gating: images need vision, scanned PDFs need
 *     local OCR, libraries can be excluded from search
 *   - EPUB admission via the shared attachment-info path (cold + warm cache;
 *     no extraction on the validation hot path)
 *   - regular-item shell checks (readable, no per-file analysis)
 *   - the batch path for regular items: best-attachment promotion
 *     (`is_primary`) and per-child validation
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the test endpoints are registered.
 *   - Library-1 fixtures seeded (SMALL_PDF, ENCRYPTED_PDF, NO_TEXT_PDF,
 *     LARGE_PDF, TEXT_ATTACHMENT, IMAGE, LINKED_URL, UNREADABLE_ATTACHMENT,
 *     NON_PDF, EPUB_PARENT_ITEM, PARENT_PDF_AND_TEXT, PARENT_MANY_READABLE,
 *     PARENT_LINKED_URL_ONLY).
 *   - Group-library-3 fixture seeded (SNAPSHOT_ATTACHMENT).
 *
 * Run with: `npm run test:live -- itemValidation`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { invalidateCache, validateItem, validateRegularItem } from '../helpers/cacheInspector';
import { fetchDocument } from '../helpers/zoteroHttpClient';
import {
    SMALL_PDF,
    ENCRYPTED_PDF,
    NO_TEXT_PDF,
    LARGE_PDF,
    TEXT_ATTACHMENT,
    IMAGE,
    LINKED_URL,
    SNAPSHOT_ATTACHMENT,
    UNREADABLE_ATTACHMENT,
    NON_PDF,
    EPUB_PARENT_ITEM,
    PARENT_PDF_AND_TEXT,
    PARENT_MANY_READABLE,
    PARENT_LINKED_URL_ONLY,
} from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const EXTRACT_TIMEOUT = 90_000;

describe('validateItem — attachment content kinds (default capabilities)', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('validates a readable PDF attachment', async () => {
        const res = await validateItem(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.content_kind).toBe('pdf');
        expect(res.page_count).toBe(2);
        expect(res.reason).toBeNull();
    }, 60_000);

    it('admits a large but under-limit PDF (no page-limit block)', async () => {
        const res = await validateItem(LARGE_PDF.library_id, LARGE_PDF.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.content_kind).toBe('pdf');
        expect(res.page_count).toBe(373);
    }, 60_000);

    it('marks an encrypted PDF as password-protected', async () => {
        const res = await validateItem(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('unreadable');
        expect(res.severity).toBe('error');
        expect(res.status_code).toBe('pdf_encrypted');
        expect(res.reason).toContain('password-protected');
    }, 60_000);

    it('blocks a scanned PDF that needs OCR when OCR is unavailable', async () => {
        const res = await validateItem(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('blocked');
        expect(res.severity).toBe('error');
        expect(res.status_code).toBe('pdf_needs_ocr');
        expect(res.content_kind).toBe('pdf');
        expect(res.page_count).toBeGreaterThan(0);
        expect(res.reason).toContain('OCR');
    }, 60_000);

    it('validates a text attachment as readable', async () => {
        const res = await validateItem(TEXT_ATTACHMENT.library_id, TEXT_ATTACHMENT.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.content_kind).toBe('text');
    });

    it('blocks an image attachment without model vision support', async () => {
        const res = await validateItem(IMAGE.library_id, IMAGE.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('blocked');
        expect(res.severity).toBe('error');
        expect(res.content_kind).toBe('image');
        expect(res.reason).toContain('vision support');
    });

    it('marks a linked-URL attachment as unreadable', async () => {
        const res = await validateItem(LINKED_URL.library_id, LINKED_URL.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('unreadable');
        expect(res.content_kind).toBe('linked_url');
        expect(res.reason).toContain('web links');
    });

    it('marks an HTML snapshot as unreadable', async () => {
        const res = await validateItem(SNAPSHOT_ATTACHMENT.library_id, SNAPSHOT_ATTACHMENT.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('unreadable');
        expect(res.content_kind).toBe('snapshot');
        expect(res.reason).toContain('snapshot');
    });

    it('marks an unsupported octet-stream attachment as unreadable', async () => {
        const res = await validateItem(UNREADABLE_ATTACHMENT.library_id, UNREADABLE_ATTACHMENT.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('unreadable');
        expect(res.content_kind).toBe('other');
        expect(res.reason).toContain('cannot read');
    });
});

describe('validateItem — capability-dependent gating', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('admits an image attachment when the model supports vision', async () => {
        const res = await validateItem(IMAGE.library_id, IMAGE.zotero_key, { supportsVision: true });
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.content_kind).toBe('image');
    });

    it('admits a scanned PDF when OCR can run locally', async () => {
        const res = await validateItem(NO_TEXT_PDF.library_id, NO_TEXT_PDF.zotero_key, {
            canHandleOCRLocally: true,
        });
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.status_code).toBe('pdf_needs_ocr');
        expect(res.content_kind).toBe('pdf');
        expect(res.page_count).toBeGreaterThan(0);
    }, 60_000);

    it('blocks an item whose library is excluded from search', async () => {
        const res = await validateItem(SMALL_PDF.library_id, SMALL_PDF.zotero_key, {
            // A library id the fixture's library is guaranteed not to be.
            searchableLibraryIds: [SMALL_PDF.library_id + 100_000],
        });
        expect(res.ok).toBe(true);
        expect(res.state).toBe('blocked');
        expect(res.severity).toBe('error');
        expect(res.reason).toContain('excluded from Beaver');
    });

    it('admits an item whose library is in the searchable set', async () => {
        const res = await validateItem(SMALL_PDF.library_id, SMALL_PDF.zotero_key, {
            searchableLibraryIds: [SMALL_PDF.library_id],
        });
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.content_kind).toBe('pdf');
    }, 60_000);
});

describe('validateItem — EPUB attachments', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('admits an EPUB with a cold document cache without extracting', async () => {
        await invalidateCache(NON_PDF.library_id, NON_PDF.zotero_key);

        const start = Date.now();
        const res = await validateItem(NON_PDF.library_id, NON_PDF.zotero_key);
        const elapsedMs = Date.now() - start;

        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.content_kind).toBe('epub');
        expect(res.reason).toBeNull();
        // A cold cache is admitted after existence and size checks; EPUB
        // extraction is reserved for the document read path.
        expect(elapsedMs).toBeLessThan(5_000);
    }, 30_000);

    it('admits an EPUB whose successful extraction is cached', async () => {
        const docRes = await fetchDocument(NON_PDF, { mode: 'markdown' }, { timeout: EXTRACT_TIMEOUT });
        expect(docRes.error_code ?? null).toBeNull();
        expect(docRes.content_kind).toBe('epub');

        const res = await validateItem(NON_PDF.library_id, NON_PDF.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.content_kind).toBe('epub');
        expect(res.reason).toBeNull();
    }, EXTRACT_TIMEOUT + 30_000);
});

describe('validateItem — regular items', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('validates a regular item via the cheap shell check (no file analysis)', async () => {
        const res = await validateItem(EPUB_PARENT_ITEM.library_id, EPUB_PARENT_ITEM.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        // Regular items pass the existence/trash check without resolving a file,
        // so there is no content kind on the result.
        expect(res.content_kind).toBeNull();
    });
});

describe('validateRegularItem — batch attachment validation', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('promotes a single EPUB child as primary and readable', async () => {
        const res = await validateRegularItem(EPUB_PARENT_ITEM.library_id, EPUB_PARENT_ITEM.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.attachments).toHaveLength(1);
        const [child] = res.attachments!;
        expect(child.content_kind).toBe('epub');
        expect(child.state).toBe('readable');
        expect(child.is_primary).toBe(true);
    }, 60_000);

    it('prefers the PDF child over a text child as primary', async () => {
        const res = await validateRegularItem(PARENT_PDF_AND_TEXT.library_id, PARENT_PDF_AND_TEXT.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');

        const attachments = res.attachments!;
        const primary = attachments.filter((a) => a.is_primary);
        expect(primary).toHaveLength(1);
        expect(primary[0].content_kind).toBe('pdf');

        const text = attachments.find((a) => a.content_kind === 'text');
        expect(text).toBeDefined();
        expect(text!.state).toBe('readable');
        expect(text!.is_primary).toBe(false);
    }, 90_000);

    it('selects exactly one primary PDF and blocks image children without vision', async () => {
        const res = await validateRegularItem(PARENT_MANY_READABLE.library_id, PARENT_MANY_READABLE.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');

        const attachments = res.attachments!;
        const primary = attachments.filter((a) => a.is_primary);
        expect(primary).toHaveLength(1);
        expect(primary[0].content_kind).toBe('pdf');

        const images = attachments.filter((a) => a.content_kind === 'image');
        expect(images.length).toBeGreaterThan(0);
        for (const image of images) {
            expect(image.state).toBe('blocked');
            expect(image.reason).toContain('vision support');
        }
    }, 120_000);

    it('admits image children when the model supports vision', async () => {
        const res = await validateRegularItem(PARENT_MANY_READABLE.library_id, PARENT_MANY_READABLE.zotero_key, {
            supportsVision: true,
        });
        expect(res.ok).toBe(true);
        const images = res.attachments!.filter((a) => a.content_kind === 'image');
        expect(images.length).toBeGreaterThan(0);
        for (const image of images) {
            expect(image.state).toBe('readable');
        }
    }, 120_000);

    it('returns an unreadable child for a linked-URL-only parent without a primary', async () => {
        const res = await validateRegularItem(PARENT_LINKED_URL_ONLY.library_id, PARENT_LINKED_URL_ONLY.zotero_key);
        expect(res.ok).toBe(true);
        // The regular-item shell still validates; only the child is unreadable.
        expect(res.state).toBe('readable');

        const attachments = res.attachments!;
        expect(attachments.length).toBeGreaterThanOrEqual(1);
        // Linked-URL attachments are excluded from best-attachment ranking.
        expect(attachments.some((a) => a.is_primary)).toBe(false);
        const linked = attachments.find((a) => a.content_kind === 'linked_url');
        expect(linked).toBeDefined();
        expect(linked!.state).toBe('unreadable');
    }, 60_000);

    it('rejects a non-regular item with not_a_regular_item', async () => {
        const res = await validateRegularItem(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(res.ok).toBe(false);
        expect(res.error).toBe('not_a_regular_item');
    });
});

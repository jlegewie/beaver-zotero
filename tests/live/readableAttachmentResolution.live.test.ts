/**
 * Readable-attachment resolution live suite.
 *
 * Covers the document-extraction refactor that replaced the PDF-only resolver
 * with `resolveToReadableAttachment`, so the extractor now classifies every
 * readable attachment kind (pdf / epub / text / snapshot / image) and rejects
 * the non-PDF kinds with `unsupported_type` instead of `not_pdf`.
 *
 * Two surfaces are exercised:
 *
 *   1. The production hot path `/beaver/attachment/document`
 *      (`handleZoteroDocumentRequest`):
 *        - PDFs still extract (regression guard).
 *        - EPUB / text / snapshot attachments → `unsupported_type` carrying the
 *          resolved `content_kind` and the "supports PDF only" message.
 *        - Image and otherwise-unreadable attachments → `unsupported_type`
 *          with NO `content_kind` (image has no extractor kind; octet-stream
 *          is not readable at all). Critically, neither is mislabeled `pdf`.
 *        - Linked-URL attachments → `is_linked_url`.
 *        - A regular item resolves through to its readable child before the
 *          unsupported-kind rejection.
 *
 *   2. The dev-only resolver probe `/beaver/test/resolve-readable`
 *      (`resolveToReadableAttachment`), which returns the chosen attachment key
 *      and content kind verbatim — without extraction — so resolution of
 *      regular items (PDF preference, single readable child, best-attachment
 *      selection, linked-URL child filtering) can be asserted precisely.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the `/beaver/test/*` endpoints are registered.
 *   - Fixtures seeded: SMALL_PDF, PARENT_ITEM, NON_PDF, IMAGE, TEXT_ATTACHMENT,
 *     SNAPSHOT_ATTACHMENT, UNREADABLE_ATTACHMENT, LINKED_URL,
 *     PARENT_PDF_AND_TEXT, PARENT_SNAPSHOT_ONLY, PARENT_MANY_READABLE,
 *     PARENT_LINKED_URL_ONLY.
 *
 * Run with: `npm run test:live -- readableAttachmentResolution`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { resolveReadable } from '../helpers/cacheInspector';
import { fetchDocument } from '../helpers/zoteroHttpClient';
import {
    SMALL_PDF,
    PARENT_ITEM,
    NON_PDF,
    IMAGE,
    TEXT_ATTACHMENT,
    SNAPSHOT_ATTACHMENT,
    UNREADABLE_ATTACHMENT,
    LINKED_URL,
    PARENT_PDF_AND_TEXT,
    PARENT_SNAPSHOT_ONLY,
    PARENT_MANY_READABLE,
    PARENT_LINKED_URL_ONLY,
} from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

/** Generous timeout — the document endpoint may extract a real PDF. */
const EXTRACT_OPTS = { timeout: 90_000 } as const;

describe('document request — readable but unsupported attachment kinds', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('still extracts a PDF attachment (regression guard)', async () => {
        const res = await fetchDocument(SMALL_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(res.error_code ?? null).toBeNull();
        expect(res.content_kind).toBe('pdf');
        expect(res.result?.document.pageCount).toBeGreaterThan(0);
    });

    it('extracts an EPUB attachment with content_kind "epub"', async () => {
        const res = await fetchDocument(NON_PDF, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(res.error_code ?? null).toBeNull();
        expect(res.content_kind).toBe('epub');
        expect((res.result as any)?.sectionCount).toBeGreaterThan(0);
    });

    it('extracts a text attachment with content_kind "text"', async () => {
        const res = await fetchDocument(TEXT_ATTACHMENT, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(res.error_code ?? null).toBeNull();
        expect(res.content_kind).toBe('text');
        expect(res.result).toBeTruthy();
    });

    it('rejects a local HTML snapshot attachment as unsupported_type with content_kind "snapshot"', async (ctx) => {
        const res = await fetchDocument(SNAPSHOT_ATTACHMENT, { mode: 'markdown' });
        if (res.error_code === 'file_missing') ctx.skip();
        expect(res.error_code).toBe('unsupported_type');
        expect(res.content_kind).toBe('snapshot');
        expect(res.result ?? null).toBeNull();
    });

    it('rejects an image attachment as unsupported_type without reporting a content_kind', async () => {
        // Images are readable but have no extractor content kind, so the
        // response must not carry one — and must never be mislabeled `pdf`.
        const res = await fetchDocument(IMAGE, { mode: 'markdown' });
        expect(res.error_code).toBe('unsupported_type');
        expect(res.content_kind ?? null).toBeNull();
        expect(res.result ?? null).toBeNull();
    });

    it('rejects an unreadable (octet-stream) attachment as unsupported_type without a content_kind', async () => {
        const res = await fetchDocument(UNREADABLE_ATTACHMENT, { mode: 'markdown' });
        expect(res.error_code).toBe('unsupported_type');
        expect(res.content_kind ?? null).toBeNull();
        expect(res.error).toContain('not a readable document');
        expect(res.result ?? null).toBeNull();
    });

    it('rejects a linked-URL attachment with is_linked_url and no content_kind', async () => {
        const res = await fetchDocument(LINKED_URL, { mode: 'markdown' });
        expect(res.error_code).toBe('is_linked_url');
        expect(res.content_kind ?? null).toBeNull();
        expect(res.result ?? null).toBeNull();
    });

    it('resolves a regular item to its local readable child before rejecting the kind', async (ctx) => {
        // The parent has a single snapshot child; resolution must reach it and
        // surface the snapshot kind rather than a "no attachments" error.
        const res = await fetchDocument(PARENT_SNAPSHOT_ONLY, { mode: 'markdown' });
        if (res.error_code === 'file_missing') ctx.skip();
        expect(res.error_code).toBe('unsupported_type');
        expect(res.content_kind).toBe('snapshot');
        expect(res.result ?? null).toBeNull();
    });
});

describe('resolveToReadableAttachment — direct attachments', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('resolves a PDF attachment to itself', async () => {
        const res = await resolveReadable(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(res).toMatchObject({
            resolved: true,
            resolved_key: `${SMALL_PDF.library_id}-${SMALL_PDF.zotero_key}`,
            content_kind: 'pdf',
            content_type: 'application/pdf',
        });
    });

    it('resolves an EPUB attachment with its content type', async () => {
        const res = await resolveReadable(NON_PDF.library_id, NON_PDF.zotero_key);
        expect(res).toMatchObject({
            resolved: true,
            resolved_key: `${NON_PDF.library_id}-${NON_PDF.zotero_key}`,
            content_kind: 'epub',
            content_type: 'application/epub+zip',
        });
    });

    it('resolves a text attachment as kind "text"', async () => {
        const res = await resolveReadable(TEXT_ATTACHMENT.library_id, TEXT_ATTACHMENT.zotero_key);
        expect(res).toMatchObject({
            resolved: true,
            resolved_key: `${TEXT_ATTACHMENT.library_id}-${TEXT_ATTACHMENT.zotero_key}`,
            content_kind: 'text',
            content_type: 'text/plain',
        });
    });

    it('resolves an HTML snapshot attachment as kind "snapshot"', async () => {
        const res = await resolveReadable(SNAPSHOT_ATTACHMENT.library_id, SNAPSHOT_ATTACHMENT.zotero_key);
        expect(res).toMatchObject({
            resolved: true,
            resolved_key: `${SNAPSHOT_ATTACHMENT.library_id}-${SNAPSHOT_ATTACHMENT.zotero_key}`,
            content_kind: 'snapshot',
        });
        expect(res.content_type).toBe('text/html');
    });

    it('resolves an image attachment as kind "image"', async () => {
        const res = await resolveReadable(IMAGE.library_id, IMAGE.zotero_key);
        expect(res).toMatchObject({
            resolved: true,
            resolved_key: `${IMAGE.library_id}-${IMAGE.zotero_key}`,
            content_kind: 'image',
        });
        expect(res.content_type).toMatch(/^image\//);
    });

    it('rejects an unreadable attachment with not_readable', async () => {
        const res = await resolveReadable(UNREADABLE_ATTACHMENT.library_id, UNREADABLE_ATTACHMENT.zotero_key);
        expect(res.resolved).toBe(false);
        expect(res.error_code).toBe('not_readable');
        expect(res.content_kind ?? null).toBeNull();
    });

    it('rejects a linked-URL attachment with is_linked_url', async () => {
        const res = await resolveReadable(LINKED_URL.library_id, LINKED_URL.zotero_key);
        expect(res.resolved).toBe(false);
        expect(res.error_code).toBe('is_linked_url');
        expect(res.content_kind ?? null).toBeNull();
    });
});

describe('resolveToReadableAttachment — regular item resolution', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('resolves a regular item to its single PDF child', async () => {
        const res = await resolveReadable(PARENT_ITEM.library_id, PARENT_ITEM.zotero_key);
        expect(res.is_regular_item).toBe(true);
        expect(res.resolved).toBe(true);
        expect(res.content_kind).toBe('pdf');
        // Resolves to a child attachment, not the requested parent key.
        expect(res.resolved_key).not.toBe(`${PARENT_ITEM.library_id}-${PARENT_ITEM.zotero_key}`);
    });

    it('prefers the PDF child of a regular item with both a PDF and a text child', async () => {
        const res = await resolveReadable(PARENT_PDF_AND_TEXT.library_id, PARENT_PDF_AND_TEXT.zotero_key);
        expect(res.resolved).toBe(true);
        expect(res.content_kind).toBe('pdf');
        expect(res.content_type).toBe('application/pdf');
    });

    it('resolves a regular item to its only readable child when no PDF is present', async () => {
        const res = await resolveReadable(PARENT_SNAPSHOT_ONLY.library_id, PARENT_SNAPSHOT_ONLY.zotero_key);
        expect(res.resolved).toBe(true);
        expect(res.content_kind).toBe('snapshot');
        // The single snapshot child is in the same (group) library as the parent.
        expect(res.resolved_key).not.toBe(
            `${PARENT_SNAPSHOT_ONLY.library_id}-${PARENT_SNAPSHOT_ONLY.zotero_key}`,
        );
    });

    it('falls back to the best attachment when a regular item has multiple readable children', async () => {
        const res = await resolveReadable(PARENT_MANY_READABLE.library_id, PARENT_MANY_READABLE.zotero_key);
        expect(res.resolved).toBe(true);
        // The best attachment for this item is a PDF.
        expect(res.content_kind).toBe('pdf');
        expect(res.content_type).toBe('application/pdf');
    });

    it('reports no readable attachments when a regular item only has a linked-URL child', async () => {
        const res = await resolveReadable(PARENT_LINKED_URL_ONLY.library_id, PARENT_LINKED_URL_ONLY.zotero_key);
        expect(res.resolved).toBe(false);
        expect(res.error_code).toBe('not_attachment');
        expect(res.error).toContain('no readable attachments');
    });
});

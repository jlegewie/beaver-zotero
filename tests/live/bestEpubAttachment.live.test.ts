/**
 * Best-EPUB-attachment resolution live suite.
 *
 * Covers `getBestEpubAttachmentAsync` (src/utils/zoteroItemHelpers.ts), the
 * attachment resolver used by the EPUB citation-navigation path
 * (`navigateToEpubCitation`). It picks the EPUB attachment to open when a
 * citation click lands on an EPUB source:
 *
 *   - An attachment passed directly is returned as-is (the helper short-circuits
 *     on `isAttachment()` before any kind check — so a PDF/image attachment
 *     passed directly comes back unchanged; the EPUB-ness is enforced upstream).
 *   - A regular item resolves to its EPUB child (via Zotero's best-attachment
 *     ranking, falling back to the first EPUB child).
 *   - A regular item with readable children but no EPUB resolves to null, so the
 *     citation path falls back to revealing the item in the library.
 *
 * Exercised via the dev-only `/beaver/test/best-epub-attachment` probe, which
 * runs the production helper and returns the chosen attachment key/content type
 * verbatim — without driving the reader UI.
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - User authenticated so the `/beaver/test/*` endpoints are registered.
 *   - Fixtures seeded: NON_PDF (top-level EPUB), EPUB_WITH_PARENT,
 *     EPUB_PARENT_ITEM, SMALL_PDF, IMAGE, PARENT_PDF_AND_TEXT,
 *     PARENT_MANY_READABLE, PARENT_LINKED_URL_ONLY.
 *
 * Run with: `npm run test:live -- bestEpubAttachment`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { bestEpubAttachment } from '../helpers/cacheInspector';
import {
    NON_PDF,
    EPUB_WITH_PARENT,
    EPUB_PARENT_ITEM,
    SMALL_PDF,
    IMAGE,
    PARENT_PDF_AND_TEXT,
    PARENT_MANY_READABLE,
    PARENT_LINKED_URL_ONLY,
} from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

describe('getBestEpubAttachmentAsync — direct attachments', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns a top-level EPUB attachment as itself', async () => {
        const res = await bestEpubAttachment(NON_PDF.library_id, NON_PDF.zotero_key);
        expect(res).toMatchObject({
            is_attachment: true,
            resolved: true,
            resolved_key: `${NON_PDF.library_id}-${NON_PDF.zotero_key}`,
            content_type: 'application/epub+zip',
        });
    });

    it('returns an EPUB attachment that has a parent as itself', async () => {
        const res = await bestEpubAttachment(EPUB_WITH_PARENT.library_id, EPUB_WITH_PARENT.zotero_key);
        expect(res).toMatchObject({
            is_attachment: true,
            resolved: true,
            resolved_key: `${EPUB_WITH_PARENT.library_id}-${EPUB_WITH_PARENT.zotero_key}`,
            content_type: 'application/epub+zip',
        });
    });

    it('returns a directly-passed PDF attachment unchanged (no kind filtering on attachments)', async () => {
        // The helper short-circuits on isAttachment() before checking the kind,
        // so any attachment passed directly is returned as-is. EPUB-ness is
        // enforced by the caller (the EPUB citation path only invokes it for
        // EPUB content); this documents the contract.
        const res = await bestEpubAttachment(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(res).toMatchObject({
            is_attachment: true,
            resolved: true,
            resolved_key: `${SMALL_PDF.library_id}-${SMALL_PDF.zotero_key}`,
            content_type: 'application/pdf',
        });
    });

    it('returns a directly-passed image attachment unchanged', async () => {
        const res = await bestEpubAttachment(IMAGE.library_id, IMAGE.zotero_key);
        expect(res).toMatchObject({
            is_attachment: true,
            resolved: true,
            resolved_key: `${IMAGE.library_id}-${IMAGE.zotero_key}`,
        });
        expect(res.content_type).toMatch(/^image\//);
    });
});

describe('getBestEpubAttachmentAsync — regular item resolution', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('resolves a regular item to its single EPUB child', async () => {
        const res = await bestEpubAttachment(EPUB_PARENT_ITEM.library_id, EPUB_PARENT_ITEM.zotero_key);
        expect(res.is_regular_item).toBe(true);
        expect(res.resolved).toBe(true);
        expect(res.content_type).toBe('application/epub+zip');
        // Resolves to the EPUB child, not the requested parent key.
        expect(res.resolved_key).toBe(
            `${EPUB_WITH_PARENT.library_id}-${EPUB_WITH_PARENT.zotero_key}`,
        );
    });

    it('returns null for a regular item with a PDF and text child but no EPUB', async () => {
        const res = await bestEpubAttachment(PARENT_PDF_AND_TEXT.library_id, PARENT_PDF_AND_TEXT.zotero_key);
        expect(res.is_regular_item).toBe(true);
        expect(res.resolved).toBe(false);
        expect(res.resolved_key ?? null).toBeNull();
    });

    it('returns null for a regular item with many readable children but no EPUB', async () => {
        const res = await bestEpubAttachment(PARENT_MANY_READABLE.library_id, PARENT_MANY_READABLE.zotero_key);
        expect(res.is_regular_item).toBe(true);
        expect(res.resolved).toBe(false);
        expect(res.resolved_key ?? null).toBeNull();
    });

    it('returns null for a regular item whose only child is a linked URL', async () => {
        const res = await bestEpubAttachment(PARENT_LINKED_URL_ONLY.library_id, PARENT_LINKED_URL_ONLY.zotero_key);
        expect(res.resolved).toBe(false);
        expect(res.resolved_key ?? null).toBeNull();
    });
});

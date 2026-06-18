/**
 * Item-validation live suite (`/beaver/test/validate-item`).
 *
 * Exercises `itemValidationManager.validateItem` through the
 * dev-only validate-item endpoint, covering the agent-support gating:
 *   - PDF attachments still validate (readable PDF readable, encrypted unreadable)
 *   - EPUB attachments are admitted — cold document cache (no extraction on
 *     the validation path) and warm cache (successful extraction metadata)
 *   - text and image attachments are readable source types
 *   - regular items pass the simple existence/trash check
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - Fixture attachments seeded (SMALL_PDF, ENCRYPTED_PDF, TEXT_ATTACHMENT,
 *     IMAGE, NON_PDF, EPUB_WITH_PARENT).
 *
 * Run with: `npm run test:live -- itemValidation`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { invalidateCache, validateItem } from '../helpers/cacheInspector';
import { post, fetchDocument } from '../helpers/zoteroHttpClient';
import {
    SMALL_PDF,
    ENCRYPTED_PDF,
    TEXT_ATTACHMENT,
    IMAGE,
    NON_PDF,
    EPUB_WITH_PARENT,
} from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const EXTRACT_TIMEOUT = 90_000;

describe('frontend validation of attachment kinds', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('validates a readable PDF attachment', async () => {
        const res = await validateItem(SMALL_PDF.library_id, SMALL_PDF.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.reason).toBeNull();
    }, 60_000);

    it('marks an encrypted PDF as password-protected', async () => {
        const res = await validateItem(ENCRYPTED_PDF.library_id, ENCRYPTED_PDF.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('unreadable');
        expect(res.reason).toContain('password-protected');
    }, 60_000);

    it('validates a text attachment as readable', async () => {
        const res = await validateItem(TEXT_ATTACHMENT.library_id, TEXT_ATTACHMENT.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.content_kind).toBe('text');
    });

    it('validates an image attachment as readable', async () => {
        const res = await validateItem(IMAGE.library_id, IMAGE.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.content_kind).toBe('image');
    });
});

describe('frontend validation of EPUB attachments', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('validates an EPUB through the shared attachment-info path', async () => {
        await invalidateCache(NON_PDF.library_id, NON_PDF.zotero_key);

        const start = Date.now();
        const res = await validateItem(NON_PDF.library_id, NON_PDF.zotero_key);
        const elapsedMs = Date.now() - start;

        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.reason).toBeNull();
        // A cold cache is admitted after existence and size checks; EPUB
        // extraction is reserved for the document read path.
        expect(elapsedMs).toBeLessThan(5_000);
    }, 30_000);

    it('validates an EPUB whose successful extraction is cached', async () => {
        const docRes = await fetchDocument(NON_PDF, { mode: 'markdown' }, { timeout: EXTRACT_TIMEOUT });
        expect(docRes.error_code ?? null).toBeNull();
        expect(docRes.content_kind).toBe('epub');

        const res = await validateItem(NON_PDF.library_id, NON_PDF.zotero_key);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
        expect(res.reason).toBeNull();
    }, EXTRACT_TIMEOUT + 30_000);
});

describe('frontend validation of regular items', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('validates the regular parent item of an EPUB attachment', async () => {
        // Resolve the parent key from the attachment's metadata.
        const attachmentRes = await post<{ items?: Array<Record<string, any>> }>(
            '/beaver/library/metadata',
            { item_ids: [`${EPUB_WITH_PARENT.library_id}-${EPUB_WITH_PARENT.zotero_key}`] },
        );
        const parentKey = attachmentRes.items?.[0]?.parentItem;
        expect(parentKey, 'EPUB fixture must have a parent item').toBeTruthy();

        const res = await validateItem(EPUB_WITH_PARENT.library_id, parentKey);
        expect(res.ok).toBe(true);
        expect(res.state).toBe('readable');
    });
});

/**
 * EPUB source-gating live suite (`/beaver/library/metadata`).
 *
 * Verifies that EPUB attachments are reported as readable through the
 * agent-facing attachment-info path:
 *   - `content_kind: 'epub'` with `status: 'readable'` (no nonPdfReadableEnabled
 *     flag required)
 *   - cold document cache → `page_count: null`
 *   - after a document extraction populates the cache, `page_count` equals the
 *     extracted page count
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - Fixture attachment seeded (EPUB_WITH_PARENT — an EPUB with a parent item).
 *
 * Run with: `npm run test:live -- epubReadability`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { invalidateCache } from '../helpers/cacheInspector';
import { post, fetchDocument } from '../helpers/zoteroHttpClient';
import { EPUB_WITH_PARENT } from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

const EXTRACT_OPTS = { timeout: 90_000 } as const;

interface MetadataResponse {
    items?: Array<Record<string, any>>;
    not_found?: string[];
    error?: string | null;
}

function epubItemId(): string {
    return `${EPUB_WITH_PARENT.library_id}-${EPUB_WITH_PARENT.zotero_key}`;
}

/** Fetch the EPUB's parent item metadata including attachment infos. */
async function fetchParentMetadataWithAttachments(): Promise<Record<string, any>> {
    // Resolve the parent key from the attachment's own metadata.
    const attachmentRes = await post<MetadataResponse>('/beaver/library/metadata', {
        item_ids: [epubItemId()],
    });
    const attachmentItem = attachmentRes.items?.[0];
    expect(attachmentItem, 'EPUB fixture metadata').toBeTruthy();
    const parentKey = attachmentItem!.parentItem;
    expect(parentKey, 'EPUB fixture must have a parent item').toBeTruthy();

    const parentRes = await post<MetadataResponse>('/beaver/library/metadata', {
        item_ids: [`${EPUB_WITH_PARENT.library_id}-${parentKey}`],
        include_attachments: true,
    });
    const parentItem = parentRes.items?.[0];
    expect(parentItem, 'parent item metadata').toBeTruthy();
    return parentItem!;
}

function findEpubAttachmentInfo(parentItem: Record<string, any>): Record<string, any> {
    const attachments: Array<Record<string, any>> = parentItem.attachments ?? [];
    const info = attachments.find((a) => a.attachment_id === epubItemId());
    expect(info, 'EPUB attachment info on parent').toBeTruthy();
    return info!;
}

describe('EPUB readability via get-metadata', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('reports a cold-cache EPUB attachment as readable without a page count', async () => {
        await invalidateCache(EPUB_WITH_PARENT.library_id, EPUB_WITH_PARENT.zotero_key);

        const parentItem = await fetchParentMetadataWithAttachments();
        const info = findEpubAttachmentInfo(parentItem);

        expect(info).toMatchObject({
            content_kind: 'epub',
            status: 'readable',
        });
        expect(info.page_count).toBeNull();
        expect(info.status_code ?? null).toBeNull();
    });

    it('reports the extracted page count as page_count once cached', async () => {
        await invalidateCache(EPUB_WITH_PARENT.library_id, EPUB_WITH_PARENT.zotero_key);

        // Populate the document cache through the hot extraction path.
        const docRes = await fetchDocument(EPUB_WITH_PARENT, { mode: 'markdown' }, EXTRACT_OPTS);
        expect(docRes.content_kind).toBe('epub');
        const pageCount = (docRes.result as any)?.pageCount;
        expect(pageCount).toBeGreaterThan(0);

        const parentItem = await fetchParentMetadataWithAttachments();
        const info = findEpubAttachmentInfo(parentItem);

        expect(info).toMatchObject({
            content_kind: 'epub',
            status: 'readable',
            page_count: pageCount,
        });
    });
});

/**
 * Agent item-filtering live suite (`/beaver/search/metadata`,
 * `/beaver/attachment/search`).
 *
 * Covers the agent-facing item filter (PDF + EPUB) on the search endpoints:
 *   - metadata search returns regular items whose only attachment is an EPUB,
 *     and serializes that attachment with `content_kind: 'epub'` and
 *     `status: 'readable'`
 *   - in-document attachment search stays PDF-only: an EPUB attachment is
 *     rejected with `error_code: 'not_pdf'` and a message naming the content
 *     type, while PDF attachments keep working
 *
 * Prerequisites (per tests/README.md):
 *   - Dev build of Beaver loaded in a running Zotero (NODE_ENV=development).
 *   - Fixture attachments seeded (SMALL_PDF, NON_PDF, EPUB_WITH_PARENT) and
 *     library 1 searchable for the signed-in profile.
 *
 * Run with: `npm run test:live -- agentItemFiltering`
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post, searchAttachment } from '../helpers/zoteroHttpClient';
import { SMALL_PDF, NON_PDF, EPUB_WITH_PARENT } from '../helpers/fixtures';

let available = false;
beforeAll(async () => {
    available = await isZoteroAvailable();
});

interface MetadataResponse {
    items?: Array<Record<string, any>>;
}

interface SearchResultItem {
    item: Record<string, any>;
    attachments: Array<Record<string, any>>;
}

describe('metadata search with EPUB-only items', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('returns a regular item whose only attachment is an EPUB, with readable attachment info', async () => {
        // Resolve the parent item and its title from the EPUB attachment fixture.
        const attachmentRes = await post<MetadataResponse>('/beaver/library/metadata', {
            item_ids: [`${EPUB_WITH_PARENT.library_id}-${EPUB_WITH_PARENT.zotero_key}`],
        });
        const parentKey = attachmentRes.items?.[0]?.parentItem;
        expect(parentKey, 'EPUB fixture must have a parent item').toBeTruthy();

        const parentRes = await post<MetadataResponse>('/beaver/library/metadata', {
            item_ids: [`${EPUB_WITH_PARENT.library_id}-${parentKey}`],
        });
        const parentTitle = parentRes.items?.[0]?.title;
        expect(parentTitle, 'parent item must have a title').toBeTruthy();

        const searchRes = await post<{ items?: SearchResultItem[] }>('/beaver/search/metadata', {
            title_query: parentTitle,
            limit: 10,
        });
        const match = searchRes.items?.find(
            (r) => r.item?.zotero_key === parentKey
                && r.item?.library_id === EPUB_WITH_PARENT.library_id,
        );
        expect(match, `parent item "${parentTitle}" in metadata search results`).toBeTruthy();

        const epubInfo = match!.attachments.find(
            (a) => a.attachment_id === `${EPUB_WITH_PARENT.library_id}-${EPUB_WITH_PARENT.zotero_key}`,
        );
        expect(epubInfo, 'EPUB attachment info on search result').toBeTruthy();
        expect(epubInfo).toMatchObject({
            content_kind: 'epub',
            status: 'readable',
        });
    }, 30_000);
});

describe('in-document attachment search stays PDF-only', () => {
    beforeEach((ctx) => skipIfNoZotero(ctx, available));

    it('rejects an EPUB attachment with not_pdf and a content-type message', async () => {
        const res = await searchAttachment(NON_PDF, 'the');
        expect(res.error_code).toBe('not_pdf');
        expect(res.error).toContain('supported for PDF attachments only');
        expect(res.error).toContain('application/epub+zip');
        expect(res.total_matches).toBe(0);
        expect(res.pages).toEqual([]);
    });

    it('still searches PDF attachments without error', async () => {
        const res = await searchAttachment(SMALL_PDF, 'the', undefined, { timeout: 60_000 });
        expect(res.error_code ?? null).toBeNull();
        expect(res.error ?? null).toBeNull();
        expect(res.total_pages).toBeGreaterThan(0);
    }, 60_000);
});

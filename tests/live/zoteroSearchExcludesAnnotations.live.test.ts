/**
 * Live coverage for the annotation exclusion in zotero_search
 * (`/beaver/library/search`).
 *
 * zotero_search has no annotation result shape, so annotation items must be
 * dropped from the result set before counting/paginating. This was refactored
 * to an itemTypeID SQL filter (`filterOutAnnotationItemIds`); these tests
 * confirm a real annotation that matches the search conditions never appears
 * in zotero_search results, while it is still discoverable via find_annotations
 * (proving exclusion — not a non-matching query — is what removed it).
 *
 * Prerequisites:
 *   - Dev build running against Zotero (npm start) with the dev-only
 *     /beaver/test/annotation-create endpoint registered.
 *   - Authenticated, with a synced user library.
 *   - The configured PDF attachment fixture is present and has cached page
 *     geometry for headless annotation creation.
 *
 * Run: npm run test:live -- zoteroSearchExcludesAnnotations
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CoordOrigin } from '../../react/types/citations';
import { NORMAL_PDF, type AttachmentFixture } from '../helpers/fixtures';
import { isZoteroAvailable, skipIfNoZotero } from '../helpers/zoteroAvailability';
import { post } from '../helpers/zoteroHttpClient';

let available = false;
let createdItemIds: string[] = [];

beforeAll(async () => {
    available = await isZoteroAvailable();
});

beforeEach((ctx) => {
    skipIfNoZotero(ctx, available);
    createdItemIds = [];
});

afterEach(async () => {
    if (!available || createdItemIds.length === 0) return;
    await post('/beaver/delete-items', { item_ids: createdItemIds });
    createdItemIds = [];
});

interface AnnotationCreateResponse {
    ok: boolean;
    reference?: { library_id: number; zotero_key: string };
    error?: string;
}

interface SearchResultItem {
    item_id?: string;
    result_type?: string;
}

interface SearchResponse {
    items: SearchResultItem[];
    total_count: number;
    error?: string | null;
    error_code?: string | null;
    warnings?: string[];
}

interface FindAnnotationsResponse {
    annotations: Array<{ annotation_id: string }>;
    total_count: number;
    error?: string | null;
}

function uniqueLabel(): string {
    return `search-excl-live-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function createHighlight(
    attachment: AttachmentFixture,
    text: string,
): Promise<string> {
    const response = await post<AnnotationCreateResponse>(
        '/beaver/test/annotation-create',
        {
            library_id: attachment.library_id,
            zotero_key: attachment.zotero_key,
            type: 'highlight',
            input: {
                pageIndex: 0,
                boxes: [{ l: 10, t: 20, r: 110, b: 50, coord_origin: CoordOrigin.TOPLEFT }],
                text,
                comment: text,
                color: 'yellow',
            },
        },
        { timeout: 30000 },
    );

    expect(response.ok, response.error).toBe(true);
    expect(response.reference).toBeTruthy();
    const id = `${response.reference!.library_id}-${response.reference!.zotero_key}`;
    createdItemIds.push(id);
    return id;
}

async function search(body: Record<string, unknown>): Promise<SearchResponse> {
    return post<SearchResponse>('/beaver/library/search', body, { timeout: 30000 });
}

async function findAnnotations(body: Record<string, unknown>): Promise<FindAnnotationsResponse> {
    return post<FindAnnotationsResponse>('/beaver/library/find-annotations', body, { timeout: 30000 });
}

describe('zotero_search excludes annotation items', () => {
    it('drops a matching annotation that find_annotations still returns', async () => {
        const label = uniqueLabel();
        const annotationId = await createHighlight(NORMAL_PDF, `${label} body`);

        // The annotation exists and matches the text — find_annotations sees it.
        const found = await findAnnotations({ text_contains: label, limit: 10 });
        expect(found.error).toBeFalsy();
        expect(found.annotations.map(a => a.annotation_id)).toContain(annotationId);

        // The same matching annotation must be filtered out of zotero_search.
        // include_children:true so child annotations reach the post-search
        // exclusion filter rather than being dropped by the noChildren clause.
        const searchAll = await search({
            library_id: NORMAL_PDF.library_id,
            item_category: 'all',
            include_children: true,
            conditions: [{ field: 'annotationText', operator: 'contains', value: label }],
            limit: 25,
        });

        expect(searchAll.error).toBeFalsy();
        expect(searchAll.items.map(i => i.item_id)).not.toContain(annotationId);
        expect(searchAll.total_count).toBe(0);
    }, 60000);

    it('keeps regular items while excluding annotations under item_category all', async () => {
        const response = await search({
            library_id: NORMAL_PDF.library_id,
            item_category: 'all',
            include_children: true,
            conditions: [{ field: 'itemType', operator: 'is', value: 'annotation' }],
            limit: 25,
        });

        // Explicit itemType condition routes through the exclusion filter; an
        // annotation-only search therefore returns nothing returnable.
        expect(response.error).toBeFalsy();
        expect(response.items.every(i => i.result_type !== 'annotation')).toBe(true);
    }, 30000);
});

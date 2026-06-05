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

interface FindAnnotationsResponse {
    annotations: Array<{
        annotation_id: string;
        annotation_type: string | null;
        text: string | null;
        comment: string | null;
        color: string | null;
        author: string | null;
        attachment_id: string | null;
        date_added?: string | null;
        date_modified?: string | null;
    }>;
    total_count: number;
    note?: string | null;
    error?: string | null;
    error_code?: string | null;
}

function uniqueLabel(): string {
    return `find-annotations-live-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function itemID(ref: { library_id: number; zotero_key: string }): string {
    return `${ref.library_id}-${ref.zotero_key}`;
}

async function createHighlight(
    attachment: AttachmentFixture,
    body: { text: string; comment: string; color: string },
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
                ...body,
            },
        },
        { timeout: 30000 },
    );

    expect(response.ok, response.error).toBe(true);
    expect(response.reference).toBeTruthy();
    const id = itemID(response.reference!);
    createdItemIds.push(id);
    return id;
}

async function findAnnotations(body: Record<string, unknown>): Promise<FindAnnotationsResponse> {
    return post<FindAnnotationsResponse>('/beaver/library/find-annotations', body, { timeout: 30000 });
}

describe('find_annotations live endpoint', () => {
    it('filters by attachment, text, comment, color, type, and author', async () => {
        const label = uniqueLabel();
        const annotationId = await createHighlight(NORMAL_PDF, {
            text: `${label} text`,
            comment: `${label} comment`,
            color: 'red',
        });

        const response = await findAnnotations({
            attachment_id: `${NORMAL_PDF.library_id}-${NORMAL_PDF.zotero_key}`,
            text_contains: label,
            comment_contains: 'comment',
            color: 'red',
            annotation_type: 'highlight',
            author: 'Beaver',
            limit: 10,
        });

        expect(response.error).toBeFalsy();
        expect(response.total_count).toBeGreaterThanOrEqual(1);
        expect(response.annotations.map(a => a.annotation_id)).toContain(annotationId);
        const created = response.annotations.find(a => a.annotation_id === annotationId)!;
        expect(created.annotation_type).toBe('highlight');
        expect(created.color?.toLowerCase()).toBe('#ff6666');
        expect(created.author).toBe('Beaver');
        expect(created.date_added).toBeTruthy();
        expect(created.date_modified).toBeTruthy();
    }, 45000);

    it('paginates after sorting by date added', async () => {
        const label = uniqueLabel();
        const first = await createHighlight(NORMAL_PDF, {
            text: `${label} first`,
            comment: label,
            color: 'yellow',
        });
        const second = await createHighlight(NORMAL_PDF, {
            text: `${label} second`,
            comment: label,
            color: 'yellow',
        });

        const pageOne = await findAnnotations({
            text_contains: label,
            sort_by: 'date_added',
            sort_order: 'desc',
            limit: 1,
            offset: 0,
        });
        const pageTwo = await findAnnotations({
            text_contains: label,
            sort_by: 'date_added',
            sort_order: 'desc',
            limit: 1,
            offset: 1,
        });

        expect(pageOne.error).toBeFalsy();
        expect(pageTwo.error).toBeFalsy();
        expect(pageOne.total_count).toBeGreaterThanOrEqual(2);
        expect(pageOne.annotations[0]?.annotation_id).toBe(second);
        expect(pageTwo.annotations[0]?.annotation_id).toBe(first);
    }, 60000);

    it('returns structured errors for invalid library and invalid color', async () => {
        const missingLibrary = await findAnnotations({ library_id: 999999, text_contains: uniqueLabel() });
        expect(missingLibrary.error_code).toBe('library_not_found');
        expect(missingLibrary.annotations).toEqual([]);

        const invalidColor = await findAnnotations({ color: 'pink', limit: 1 });
        expect(invalidColor.error_code).toBe('invalid_color');
        expect(invalidColor.annotations).toEqual([]);
    }, 30000);
});

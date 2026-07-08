/**
 * Live coverage for the find_annotations handler (`/beaver/library/find-annotations`).
 *
 * Exercises both internal code paths of `handleFindAnnotationsRequest`:
 *   - the SQL "DB path" used when only color/type/author/attachment filters are
 *     set (no text/comment/tag/modified_in_last), and
 *   - the Zotero.Search "native path" used when a text/comment/tag/modified
 *     filter is present.
 * Plus serializer fields (author, date_added, date_modified, color hex), sort
 * orders, pagination, group-library access, and every validation error code.
 *
 * Prerequisites:
 *   - Dev build running against Zotero (npm start) with the dev-only
 *     /beaver/test/annotation-create endpoint registered.
 *   - Authenticated, with a synced user library and group library.
 *   - The configured PDF attachment fixtures are present and have cached
 *     page geometry for headless annotation creation.
 *
 * Run: npm run test:live -- findAnnotations
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CoordOrigin } from '../../react/types/citations';
import { GROUP_LIB_PDF, NORMAL_PDF, PARENT_ITEM, type AttachmentFixture } from '../helpers/fixtures';
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
        tags?: string[];
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

function itemID(ref: { library_id: number; library_ref?: string | null; zotero_key: string }): string {
    // Handlers emit portable ids ("u-KEY" / "g<groupID>-KEY") when the library
    // maps, so compare in the same grammar the response rows use.
    return `${ref.library_ref ?? ref.library_id}-${ref.zotero_key}`;
}

function attachmentId(attachment: AttachmentFixture): string {
    return `${attachment.library_id}-${attachment.zotero_key}`;
}

async function createHighlight(
    attachment: AttachmentFixture,
    body: { text: string; comment: string; color: string; tags?: string[] },
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

async function createNote(
    attachment: AttachmentFixture,
    body: { comment: string; color: string; tags?: string[] },
): Promise<string> {
    const response = await post<AnnotationCreateResponse>(
        '/beaver/test/annotation-create',
        {
            library_id: attachment.library_id,
            zotero_key: attachment.zotero_key,
            type: 'note',
            input: {
                notePosition: {
                    page_index: 0,
                    side: 'right',
                    x: 50,
                    y: 50,
                    coord_origin: CoordOrigin.TOPLEFT,
                },
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

describe('find_annotations native search path', () => {
    it('filters by attachment, text, comment, color, type, and author', async () => {
        const label = uniqueLabel();
        const annotationId = await createHighlight(NORMAL_PDF, {
            text: `${label} text`,
            comment: `${label} comment`,
            color: 'red',
        });

        const response = await findAnnotations({
            attachment_id: attachmentId(NORMAL_PDF),
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

    it('filters by tag', async () => {
        const label = uniqueLabel();
        const tag = `tag-${label}`;
        const tagged = await createHighlight(NORMAL_PDF, {
            text: `${label} tagged`,
            comment: label,
            color: 'green',
            tags: [tag],
        });
        const untagged = await createHighlight(NORMAL_PDF, {
            text: `${label} untagged`,
            comment: label,
            color: 'green',
        });

        const response = await findAnnotations({ tag, limit: 25 });

        expect(response.error).toBeFalsy();
        const ids = response.annotations.map(a => a.annotation_id);
        expect(ids).toContain(tagged);
        expect(ids).not.toContain(untagged);
    }, 60000);

    it('matches annotations modified within the given window', async () => {
        const label = uniqueLabel();
        const annotationId = await createHighlight(NORMAL_PDF, {
            text: `${label} recent`,
            comment: label,
            color: 'blue',
        });

        const response = await findAnnotations({
            text_contains: label,
            modified_in_last: '1 year',
            limit: 10,
        });

        expect(response.error).toBeFalsy();
        expect(response.annotations.map(a => a.annotation_id)).toContain(annotationId);
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
});

describe('find_annotations DB path (no native search filter)', () => {
    it('filters by attachment and color', async () => {
        const label = uniqueLabel();
        const red = await createHighlight(NORMAL_PDF, { text: `${label} red`, comment: label, color: 'red' });
        const yellow = await createHighlight(NORMAL_PDF, { text: `${label} yellow`, comment: label, color: 'yellow' });

        const response = await findAnnotations({
            attachment_id: attachmentId(NORMAL_PDF),
            color: 'red',
            limit: 50,
        });

        expect(response.error).toBeFalsy();
        const ids = response.annotations.map(a => a.annotation_id);
        expect(ids).toContain(red);
        expect(ids).not.toContain(yellow);
        expect(response.annotations.every(a => a.color?.toLowerCase() === '#ff6666')).toBe(true);
    }, 60000);

    it('filters by annotation type and serializes a note', async () => {
        const label = uniqueLabel();
        const note = await createNote(NORMAL_PDF, { comment: `${label} note`, color: 'blue' });
        const highlight = await createHighlight(NORMAL_PDF, { text: `${label} hl`, comment: label, color: 'blue' });

        const response = await findAnnotations({
            attachment_id: attachmentId(NORMAL_PDF),
            annotation_type: 'note',
            limit: 50,
        });

        expect(response.error).toBeFalsy();
        const ids = response.annotations.map(a => a.annotation_id);
        expect(ids).toContain(note);
        expect(ids).not.toContain(highlight);
        const created = response.annotations.find(a => a.annotation_id === note)!;
        expect(created.annotation_type).toBe('note');
        expect(created.comment).toContain(label);
        expect(created.text).toBeFalsy();
    }, 60000);

    it('accepts underline as a supported type', async () => {
        const response = await findAnnotations({
            attachment_id: attachmentId(NORMAL_PDF),
            annotation_type: 'underline',
            limit: 5,
        });
        expect(response.error).toBeFalsy();
        expect(response.error_code).toBeFalsy();
        expect(Array.isArray(response.annotations)).toBe(true);
    }, 30000);

    it('reverses order between reading_order asc and desc', async () => {
        const label = uniqueLabel();
        const first = await createHighlight(NORMAL_PDF, { text: `${label} a`, comment: label, color: 'magenta' });
        const second = await createHighlight(NORMAL_PDF, { text: `${label} b`, comment: label, color: 'magenta' });

        const asc = await findAnnotations({
            attachment_id: attachmentId(NORMAL_PDF),
            sort_by: 'reading_order',
            sort_order: 'asc',
            limit: 50,
        });
        const desc = await findAnnotations({
            attachment_id: attachmentId(NORMAL_PDF),
            sort_by: 'reading_order',
            sort_order: 'desc',
            limit: 50,
        });

        expect(asc.error).toBeFalsy();
        expect(desc.error).toBeFalsy();

        const ascIds = asc.annotations.map(a => a.annotation_id);
        const descIds = desc.annotations.map(a => a.annotation_id);
        expect(ascIds).toContain(first);
        expect(ascIds).toContain(second);

        // Same parent + identical geometry => the secondary itemID tiebreak in
        // the DB ORDER BY must flip when the sort direction flips.
        const ascFirstBeforeSecond = ascIds.indexOf(first) < ascIds.indexOf(second);
        const descFirstBeforeSecond = descIds.indexOf(first) < descIds.indexOf(second);
        expect(ascFirstBeforeSecond).toBe(!descFirstBeforeSecond);
    }, 60000);
});

describe('find_annotations pagination and empty results', () => {
    it('returns an empty page when offset exceeds the result set', async () => {
        const label = uniqueLabel();
        await createHighlight(NORMAL_PDF, { text: `${label} only`, comment: label, color: 'orange' });

        const response = await findAnnotations({ text_contains: label, offset: 5, limit: 10 });

        expect(response.error).toBeFalsy();
        expect(response.total_count).toBe(1);
        expect(response.annotations).toEqual([]);
    }, 45000);

    it('returns no matches without error for an unmatched filter', async () => {
        const response = await findAnnotations({ text_contains: uniqueLabel(), limit: 10 });

        expect(response.error).toBeFalsy();
        expect(response.error_code).toBeFalsy();
        expect(response.total_count).toBe(0);
        expect(response.annotations).toEqual([]);
    }, 30000);
});

describe('find_annotations group library', () => {
    it('finds annotations scoped to a group-library attachment', async () => {
        const label = uniqueLabel();
        const annotationId = await createHighlight(GROUP_LIB_PDF, {
            text: `${label} group`,
            comment: label,
            color: 'purple',
        });

        const response = await findAnnotations({
            library_id: GROUP_LIB_PDF.library_id,
            attachment_id: attachmentId(GROUP_LIB_PDF),
            text_contains: label,
            limit: 10,
        });

        expect(response.error).toBeFalsy();
        expect(response.annotations.map(a => a.annotation_id)).toContain(annotationId);
        const created = response.annotations.find(a => a.annotation_id === annotationId)!;
        // Rows emit the portable "g<groupID>-KEY" form; the fixture only knows
        // the device-local library id, so accept either grammar for this key.
        expect(created.attachment_id).toMatch(
            new RegExp(`^(g[1-9][0-9]*|${GROUP_LIB_PDF.library_id})-${GROUP_LIB_PDF.zotero_key}$`)
        );
    }, 60000);
});

describe('find_annotations error handling', () => {
    it('returns structured errors for invalid library and invalid color', async () => {
        const missingLibrary = await findAnnotations({ library_id: 999999, text_contains: uniqueLabel() });
        expect(missingLibrary.error_code).toBe('library_not_found');
        expect(missingLibrary.annotations).toEqual([]);

        const invalidColor = await findAnnotations({ color: 'pink', limit: 1 });
        expect(invalidColor.error_code).toBe('invalid_color');
        expect(invalidColor.annotations).toEqual([]);
    }, 30000);

    it('rejects malformed, missing, and non-attachment attachment ids', async () => {
        const malformed = await findAnnotations({ attachment_id: 'nodash' });
        expect(malformed.error_code).toBe('invalid_attachment_id');

        const missing = await findAnnotations({ attachment_id: '1-ZZZZZZZZ' });
        expect(missing.error_code).toBe('not_found');

        const regularItem = await findAnnotations({ attachment_id: attachmentId(PARENT_ITEM) });
        expect(regularItem.error_code).toBe('not_attachment');
    }, 30000);

    it('returns collection_not_found for an unknown collection', async () => {
        const response = await findAnnotations({ collection: `no-such-collection-${uniqueLabel()}` });
        expect(response.error_code).toBe('collection_not_found');
        expect(response.annotations).toEqual([]);
    }, 30000);

    it('returns invalid_modified_in_last for a malformed duration', async () => {
        const response = await findAnnotations({ modified_in_last: 'soon' });
        expect(response.error_code).toBe('invalid_modified_in_last');
        expect(response.annotations).toEqual([]);
    }, 30000);

    it('returns invalid_annotation_type for unsupported and unknown types', async () => {
        const unsupported = await findAnnotations({ annotation_type: 'image' });
        expect(unsupported.error_code).toBe('invalid_annotation_type');

        const unknown = await findAnnotations({ annotation_type: 'scribble' });
        expect(unknown.error_code).toBe('invalid_annotation_type');
    }, 30000);
});

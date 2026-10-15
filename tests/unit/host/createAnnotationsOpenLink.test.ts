/**
 * The open link (↗) of a create-annotations card: saved annotations open in
 * the reader at the annotation; before they exist, or once undone, the link
 * opens the attachment at the annotation's page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

declare const Zotero: any;

const { navigateToAnnotation, navigateToPage, notifyReferenceUnavailable, resolveLibraryRef } = vi.hoisted(() => ({
    navigateToAnnotation: vi.fn(),
    navigateToPage: vi.fn(),
    notifyReferenceUnavailable: vi.fn(),
    resolveLibraryRef: vi.fn(),
}));

vi.mock('../../../react/runtime/navigation', () => ({ openReader: vi.fn() }));
vi.mock('../../../react/utils/readerUtils', () => ({ navigateToAnnotation, navigateToPage }));
vi.mock('../../../react/utils/citationNavigation', () => ({ flashHighlightBoundingBoxes: vi.fn() }));
vi.mock('../../../react/utils/annotationUtils', () => ({
    BeaverTemporaryAnnotations: { cleanupAll: vi.fn() },
}));
vi.mock('../../../src/services/annotations/epub/epubAnnotationResolver', () => ({
    resolveEpubAnnotationTarget: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: () => 'pdf',
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({ resolveLibraryRef }));
vi.mock('../../../react/host/zotero/sourceActions', () => ({ notifyReferenceUnavailable }));

import { getCreateAnnotationsOpenLink } from '../../../react/host/zotero/components/createAnnotationsNavigation';

const attachmentRef = { library_id: 1, zotero_key: 'ATTACH01' };
const item = (clientItemId: string, pageIdx: number) => ({
    index: 0,
    client_item_id: clientItemId,
    title: 'Claim',
    loc_raw: '',
    loc: { kind: 'sentence', value: '', raw: '' },
    color: 'yellow',
    page_locations: [{ page_idx: pageIdx, boxes: [] }],
});
const proposed = { resolved_ref: attachmentRef, items: [item('a', 2), item('b', 6)] };
const createdB = { library_id: 1, zotero_key: 'ANNOT00B', client_item_id: 'b', index: 1, loc_raw: '' };

const attachment = { id: 42 };
const annotation = { key: 'ANNOT00B' };

beforeEach(() => {
    vi.clearAllMocks();
    resolveLibraryRef.mockImplementation((ref: any) => ref.library_id || null);
    (globalThis as any).Zotero = {
        Items: {
            getByLibraryAndKeyAsync: vi.fn(async (_lib: number, key: string) =>
                key === 'ATTACH01' ? attachment : key === 'ANNOT00B' ? annotation : false),
        },
    };
});

describe('create-annotations open link', () => {
    it('opens the attachment at the first proposed page before anything is saved', async () => {
        const link = getCreateAnnotationsOpenLink('highlight', proposed, undefined, false)!;
        expect(link.tooltip).toBe('Open in reader');

        await link.onClick();

        expect(navigateToAnnotation).not.toHaveBeenCalled();
        expect(navigateToPage).toHaveBeenCalledWith(42, 3);
    });

    it('opens the first saved annotation once applied, skipping items that failed', async () => {
        const link = getCreateAnnotationsOpenLink(
            'highlight',
            proposed,
            { resolved_ref: attachmentRef, created: [createdB] },
            true,
        )!;
        expect(link.tooltip).toBe('Open annotation');

        await link.onClick();

        expect(navigateToAnnotation).toHaveBeenCalledWith(annotation);
        expect(navigateToPage).not.toHaveBeenCalled();
    });

    it('falls back to the page when an undone annotation no longer exists', async () => {
        const gone = { ...createdB, zotero_key: 'DELETED1' };
        const link = getCreateAnnotationsOpenLink(
            'highlight',
            proposed,
            { resolved_ref: attachmentRef, created: [gone] },
            false,
        )!;
        expect(link.tooltip).toBe('Open in reader');

        await link.onClick();

        expect(navigateToPage).toHaveBeenCalledWith(42, 7);
    });

    it('offers no link when the action names no attachment and saved nothing', () => {
        expect(getCreateAnnotationsOpenLink('note', { items: [item('a', 0)] }, undefined, false)).toBeNull();
        expect(getCreateAnnotationsOpenLink('note', undefined, undefined, false)).toBeNull();
    });

    it('reports a library that is not on this computer', async () => {
        resolveLibraryRef.mockReturnValue(null);
        const link = getCreateAnnotationsOpenLink('highlight', proposed, undefined, false)!;

        await link.onClick();

        expect(notifyReferenceUnavailable).toHaveBeenCalledWith('item', 'library_unavailable');
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    contentKind: 'pdf' as string,
    attachment: { id: 5, libraryID: 1, key: 'ATTACH01' },
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    hasLibraryIdentity: vi.fn(() => true),
    libraryRefForLibraryID: vi.fn(() => 'u'),
    resolveLibraryRef: vi.fn(() => 1),
    resolveItemReference: vi.fn(async () => ({ status: 'found', item: mocks.attachment })),
}));
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    checkLibraryExcluded: vi.fn(() => null),
    getAttachmentFileStatus: vi.fn(),
    getDeferredToolPreference: vi.fn(),
    validateLibraryAccess: vi.fn(),
}));
vi.mock('../../../src/services/documentExtraction/attachmentResolution', () => ({
    getReadableContentKind: vi.fn(() => mocks.contentKind),
}));
vi.mock('../../../src/services/attachmentContentType', () => ({ canUseReaderContentType: vi.fn() }));
vi.mock('../../../src/utils/zoteroUtils', () => ({ shortItemTitle: vi.fn() }));
vi.mock('../../../src/utils/zoteroDataLoading', () => ({ getParentItemAsync: vi.fn() }));
vi.mock('../../../src/services/annotations/createAnnotation', () => ({
    createEpubHighlightAnnotation: vi.fn(),
    createEpubNoteAnnotation: vi.fn(),
    createNoteAnnotation: vi.fn(),
    createPdfHighlightForItem: vi.fn(),
    createSnapshotHighlightAnnotation: vi.fn(async () => ({ library_id: 1, zotero_key: 'SNAPANN1' })),
    createSnapshotNoteAnnotation: vi.fn(async () => ({ library_id: 1, zotero_key: 'SNAPNOT1' })),
    prepareSnapshotAnnotationDocument: vi.fn(async () => ({ doc: true })),
    highlightPageSpan: vi.fn(),
    EpubAnnotationError: class extends Error {},
    HighlightPageSpanError: class extends Error {},
    MissingPageGeometryError: class extends Error {},
    SnapshotAnnotationError: class extends Error {},
}));

import { executeCreateHighlightAnnotationsAction as executeHighlightsOverSocket } from '../../../src/services/agentDataProvider/actions/createHighlightAnnotations';
import { TimeoutError } from '../../../src/services/agentDataProvider/timeout';
import {
    executeCreateHighlightAnnotationsAction,
    executeCreateNoteAnnotationsAction,
} from '../../../src/services/manualActions/createAnnotationsActions';
import {
    createPdfHighlightForItem,
    createSnapshotHighlightAnnotation,
    createSnapshotNoteAnnotation,
} from '../../../src/services/annotations/createAnnotation';

const ref = { library_id: 1, zotero_key: 'ATTACH01' };

function item(index: number, extra: Record<string, unknown> = {}) {
    return {
        index,
        client_item_id: `c${index}`,
        loc_raw: `p${index}`,
        text: `Passage ${index}`,
        color: 'yellow',
        page_locations: [{ page_idx: 0, boxes: [[0, 0, 1, 1]] }],
        anchor_id: `a${index}`,
        ...extra,
    };
}

describe('applying a stored create-annotation action', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.contentKind = 'pdf';
    });

    it('creates highlights on a web snapshot', async () => {
        mocks.contentKind = 'snapshot';
        const result = await executeCreateHighlightAnnotationsAction({
            id: 'h1', proposed_data: { requested_ref: ref, resolved_ref: ref, items: [item(0)], tags: [] },
        } as any);
        expect(createSnapshotHighlightAnnotation).toHaveBeenCalledOnce();
        expect(result).toMatchObject({ total_created: 1, created: [{ zotero_key: 'SNAPANN1', client_item_id: 'c0' }] });
    });

    it('creates note annotations on a web snapshot', async () => {
        mocks.contentKind = 'snapshot';
        const result = await executeCreateNoteAnnotationsAction({
            id: 'n1', proposed_data: { requested_ref: ref, resolved_ref: ref, items: [item(0, { comment: 'Note' })], tags: [] },
        } as any);
        expect(createSnapshotNoteAnnotation).toHaveBeenCalledOnce();
        expect(result).toMatchObject({ total_created: 1, created: [{ zotero_key: 'SNAPNOT1' }] });
    });
});

describe('a create_highlight_annotations batch that reaches its deadline', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.contentKind = 'pdf';
    });

    const request = (items: unknown[]) => ({
        request_id: 'r1',
        action_type: 'create_highlight_annotations',
        action_data: { requested_ref: ref, resolved_ref: ref, items, tags: [] },
    } as any);

    it('keeps the annotations it created on record and lists the rest as timed out', async () => {
        const signal = { aborted: false };
        vi.mocked(createPdfHighlightForItem).mockImplementation(async (_attachment: any, entry: any) => {
            signal.aborted = true; // the deadline passes while the first highlight is written
            return { client_item_id: entry.client_item_id, index: entry.index, loc_raw: entry.loc_raw, library_id: 1, zotero_key: 'ANNOT001' } as any;
        });

        const response = await executeHighlightsOverSocket(request([item(0), item(1), item(2)]),
            { signal, timeoutSeconds: 25, startTime: Date.now() } as any);

        expect(response.success).toBe(true);
        expect(response.result_data).toMatchObject({
            total_created: 1,
            created: [{ zotero_key: 'ANNOT001' }],
            total_failed: 2,
            failed: [{ client_item_id: 'c1', error_code: 'timeout' }, { client_item_id: 'c2', error_code: 'timeout' }],
        });
        expect(createPdfHighlightForItem).toHaveBeenCalledOnce();
    });

    it('fails with a timeout when nothing was created yet', async () => {
        await expect(executeHighlightsOverSocket(request([item(0)]),
            { signal: { aborted: true }, timeoutSeconds: 25, startTime: Date.now() } as any))
            .rejects.toBeInstanceOf(TimeoutError);
        expect(createPdfHighlightForItem).not.toHaveBeenCalled();
    });
});

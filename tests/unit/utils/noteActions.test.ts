import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/utils/citationRenderers', () => ({
    renderToHTML: vi.fn(() => '<p>rendered</p>'),
}));

vi.mock('../../../react/utils/citationRenderContext', () => ({
    prepareCitationRenderContext: vi.fn().mockResolvedValue({
        citationDataMap: {},
        pageLabelsByAttachmentId: { 7: { 0: 'i' } },
    }),
}));

vi.mock('../../../react/store', () => ({
    store: {
        get: vi.fn(() => ''),
        set: vi.fn(),
    },
}));

vi.mock('../../../react/atoms/threads', () => ({
    currentThreadNameAtom: Symbol('currentThreadNameAtom'),
}));

import { renderToHTML } from '../../../react/utils/citationRenderers';
import { prepareCitationRenderContext } from '../../../react/utils/citationRenderContext';
import { saveStreamingNote } from '../../../react/utils/noteActions';
import { store } from '../../../react/store';

const mockRenderToHTML = vi.mocked(renderToHTML);
const mockPrepareCitationRenderContext = vi.mocked(prepareCitationRenderContext);

class MockNoteItem {
    libraryID?: number;
    parentKey?: string;
    key = 'NOTEKEY';
    setNote = vi.fn();
    saveTx = vi.fn(async () => 123);
}

describe('saveStreamingNote', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(store.set).mockClear();
        (globalThis as any).Zotero.Item = vi.fn(() => new MockNoteItem());
        mockRenderToHTML.mockReturnValue('<p>rendered</p>');
        mockPrepareCitationRenderContext.mockResolvedValue({
            citationDataMap: {},
            pageLabelsByAttachmentId: { 7: { 0: 'i' } },
        });
    });

    it('prepares render context before rendering', async () => {
        await saveStreamingNote({
            markdownContent: '<citation id="1-ABCD1234" loc="p1" />',
            title: 'Test',
            targetLibraryId: 1,
        });

        expect(mockPrepareCitationRenderContext).toHaveBeenCalledWith(
            '<citation id="1-ABCD1234" loc="p1" />',
            undefined,
        );
        expect(mockRenderToHTML).toHaveBeenCalledWith(
            '<citation id="1-ABCD1234" loc="p1" />',
            'markdown',
            {
                citationDataMap: {},
                pageLabelsByAttachmentId: { 7: { 0: 'i' } },
            },
        );
    });

    it('merges preloaded labels into explicit render context', async () => {
        const citationDataMap = { c1: { citation_id: 'c1', run_id: 'r1', parts: [] } as any };
        const preparedContext = {
            citationDataMap,
            pageLabelsByAttachmentId: {
                7: { 0: 'i' },
                8: { 1: '1' },
            },
        };
        mockPrepareCitationRenderContext.mockResolvedValue(preparedContext);

        await saveStreamingNote({
            markdownContent: '<citation id="1-ABCD1234" loc="p1" />',
            title: 'Test',
            targetLibraryId: 1,
            contextData: {
                citationDataMap,
                pageLabelsByAttachmentId: { 8: { 1: '1' } },
            },
        });

        expect(mockPrepareCitationRenderContext).toHaveBeenCalledWith(
            '<citation id="1-ABCD1234" loc="p1" />',
            {
                citationDataMap,
                pageLabelsByAttachmentId: { 8: { 1: '1' } },
            },
        );
        expect(mockRenderToHTML).toHaveBeenCalledWith(
            '<citation id="1-ABCD1234" loc="p1" />',
            'markdown',
            preparedContext,
        );
    });
});

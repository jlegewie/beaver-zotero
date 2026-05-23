import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/utils/citationRenderers', () => ({
    renderToHTML: vi.fn(() => '<p>rendered</p>'),
}));

vi.mock('../../../react/utils/pageLabels', () => ({
    preloadPageLabelsForContent: vi.fn().mockResolvedValue({ 7: { 0: 'i' } }),
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

vi.mock('../../../react/atoms/citations', () => ({
    mergePageLabelsByAttachmentIdAtom: Symbol('mergePageLabelsByAttachmentIdAtom'),
}));

import { renderToHTML } from '../../../react/utils/citationRenderers';
import { preloadPageLabelsForContent } from '../../../react/utils/pageLabels';
import { saveStreamingNote } from '../../../react/utils/noteActions';
import { store } from '../../../react/store';
import { mergePageLabelsByAttachmentIdAtom } from '../../../react/atoms/citations';

const mockRenderToHTML = vi.mocked(renderToHTML);
const mockPreloadPageLabelsForContent = vi.mocked(preloadPageLabelsForContent);

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
        mockPreloadPageLabelsForContent.mockResolvedValue({ 7: { 0: 'i' } });
    });

    it('preserves ambient render context when contextData is omitted', async () => {
        await saveStreamingNote({
            markdownContent: '<citation id="1-ABCD1234" loc="p1" />',
            title: 'Test',
            targetLibraryId: 1,
        });

        expect(mockRenderToHTML).toHaveBeenCalledWith(
            '<citation id="1-ABCD1234" loc="p1" />',
            'markdown',
            undefined,
        );
        expect(store.set).toHaveBeenCalledWith(mergePageLabelsByAttachmentIdAtom, { 7: { 0: 'i' } });
    });

    it('merges preloaded labels into explicit render context', async () => {
        const citationDataMap = { c1: { citation_id: 'c1', run_id: 'r1', parts: [] } as any };

        await saveStreamingNote({
            markdownContent: '<citation id="1-ABCD1234" loc="p1" />',
            title: 'Test',
            targetLibraryId: 1,
            contextData: {
                citationDataMap,
                pageLabelsByAttachmentId: { 8: { 1: '1' } },
            },
        });

        expect(mockRenderToHTML).toHaveBeenCalledWith(
            '<citation id="1-ABCD1234" loc="p1" />',
            'markdown',
            {
                citationDataMap,
                pageLabelsByAttachmentId: {
                    7: { 0: 'i' },
                    8: { 1: '1' },
                },
            },
        );
        expect(store.set).not.toHaveBeenCalledWith(mergePageLabelsByAttachmentIdAtom, expect.anything());
    });
});

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
import {
    buildProvenanceNoteHTML,
    createProvenanceNote,
    saveStreamingNote,
} from '../../../react/utils/noteActions';
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

describe('buildProvenanceNoteHTML', () => {
    it('includes marker, escaped reason, and a conversation link', () => {
        const html = buildProvenanceNoteHTML({
            reason: 'because <important> & useful',
            threadId: 'thread-1',
            runId: 'run-1',
        });

        expect(html).toContain('<strong>Added by Beaver</strong>');
        expect(html).toContain('because &lt;important&gt; &amp; useful');
        expect(html).toContain('zotero://beaver/thread/thread-1/run/run-1');
    });

    it('omits the conversation link when no thread ID is available', () => {
        const html = buildProvenanceNoteHTML({ reason: 'Imported from search' });

        expect(html).toContain('<strong>Added by Beaver</strong>');
        expect(html).not.toContain('zotero://beaver/thread/');
    });
});

describe('createProvenanceNote', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates a schema-wrapped child note', async () => {
        const note = new MockNoteItem();
        (globalThis as any).Zotero.Item = vi.fn(() => note);

        await createProvenanceNote(
            { library_id: 12, zotero_key: 'PARENTKEY' },
            { threadId: 'thread-1' },
        );

        expect(note.libraryID).toBe(12);
        expect(note.parentKey).toBe('PARENTKEY');
        expect(note.setNote).toHaveBeenCalledWith(expect.stringContaining('data-schema-version="9"'));
        expect(note.saveTx).toHaveBeenCalled();
    });
});

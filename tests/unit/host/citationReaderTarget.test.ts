/**
 * Where a citation click opens the cited document: where the caller asks, and
 * otherwise as Zotero's "Open PDFs in a new window" setting says, in a reader
 * tab by default.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Citation } from '@beaver/agent-core/types/citations';
import type { CitationReaderTarget } from '@beaver/agent-ui/host/types';

const {
    resolveItemReference, openReader, openNote, openNoteWindow, getContextWindow,
    getCurrentReaderAndWaitForView, waitForReaderView, flashHighlightBoundingBoxes,
} = vi.hoisted(() => ({
    resolveItemReference: vi.fn(),
    openReader: vi.fn(),
    openNote: vi.fn(),
    openNoteWindow: vi.fn(),
    getContextWindow: vi.fn(),
    getCurrentReaderAndWaitForView: vi.fn(),
    waitForReaderView: vi.fn(),
    flashHighlightBoundingBoxes: vi.fn(),
}));

vi.mock('../../../react/store', () => ({ store: { get: vi.fn(() => ({})), set: vi.fn() } }));
vi.mock('../../../src/utils/prefs', () => ({ getPref: vi.fn(() => false) }));
vi.mock('../../../react/utils/annotationUtils', () => ({
    BeaverTemporaryAnnotations: { cleanupAll: vi.fn(), addToTracking: vi.fn() },
    createBoundingBoxHighlights: vi.fn(),
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    resolveItemReference,
    libraryRefForLibraryID: vi.fn(),
}));
vi.mock('../../../react/host/zotero/sourceActions', () => ({
    launchExternalFile: vi.fn(),
    notifyReferenceUnavailable: vi.fn(),
    notifyTableOpenFailed: vi.fn(),
}));
vi.mock('../../../react/host/zotero/itemData', () => ({ getPageLabelsForItem: vi.fn(() => []) }));
vi.mock('../../../react/utils/sourceUtils', () => ({ revealSource: vi.fn(), openSource: vi.fn() }));
vi.mock('../../../react/utils/zoteroURI', () => ({ createZoteroURI: vi.fn(() => 'zotero://select/library/items/ATTACH01') }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getContextWindow }));
vi.mock('../../../react/runtime/navigation', () => ({
    AttachmentFileUnavailableError: class extends Error {},
    openReader,
    openNote,
    openNoteWindow,
}));
vi.mock('../../../react/utils/readerUtils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../react/utils/readerUtils')>()),
    getCurrentReaderAndWaitForView,
    waitForReaderView,
}));
vi.mock('../../../react/utils/citationNavigation', () => ({
    flashHighlightBoundingBoxes,
    presentTemporaryAnnotations: vi.fn(),
}));

import { activateCitation } from '../../../react/host/zotero/citationActivation';

const ownerDocument = {} as Document;
const pdfCitation: Citation = {
    citation_id: 'c',
    citation_type: 'attachment',
    content_kind: 'pdf',
    resolved_ref: { kind: 'zotero', library_id: 1, library_ref: 'u', zotero_key: 'ATTACH01' },
    locations: [{ part_id: 's1', page_idx: 3, boxes: [[1, 2, 3, 4]] }],
};

function itemOf(kind: 'attachment' | 'note') {
    return {
        id: 10,
        libraryID: 1,
        key: 'ATTACH01',
        parentItemID: null,
        loadAllData: vi.fn(),
        isAttachment: () => kind === 'attachment',
        isNote: () => kind === 'note',
        isAnnotation: () => false,
        isRegularItem: () => false,
    };
}

function activate(readerTarget?: CitationReaderTarget, metadata: Citation = pdfCitation) {
    return activateCitation({
        metadata,
        ...(readerTarget ? { readerTarget } : {}),
        isExternal: false,
        isExternalFile: false,
        externalFileKey: null,
        hasMappedItem: false,
        effectiveLibraryID: 1,
        effectiveItemKey: 'ATTACH01',
        effectiveLibraryRef: 'u',
        previewText: 'cited passage',
        ownerDocument,
    });
}

let openReaderInNewWindow = false;
const windowReader = { itemID: 10, type: 'pdf', navigate: vi.fn() };
const tabReader = { itemID: 10, type: 'pdf', navigate: vi.fn() };

describe('the reader a citation opens in', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolveItemReference.mockResolvedValue({ status: 'found', item: itemOf('attachment') });
        openReaderInNewWindow = false;
        vi.stubGlobal('Zotero', { Prefs: { get: vi.fn((pref: string) => pref === 'openReaderInNewWindow' && openReaderInNewWindow) } });
        openReader.mockResolvedValue(windowReader);
        getCurrentReaderAndWaitForView.mockResolvedValue(undefined);
    });

    it('opens the cited page in a separate reader window when the caller asks for one', async () => {
        await activate('window');
        expect(openReader).toHaveBeenCalledWith(10, { pageIndex: 3 }, { openInWindow: true, allowDuplicate: true });
        expect(getCurrentReaderAndWaitForView).not.toHaveBeenCalled();
        expect(waitForReaderView).toHaveBeenCalledWith(windowReader, true);
        expect(flashHighlightBoundingBoxes).toHaveBeenCalledWith(windowReader, expect.any(Array));
    });

    it('opens a separate reader window when Zotero opens PDFs in new windows, even when a tab shows the PDF', async () => {
        openReaderInNewWindow = true;
        getCurrentReaderAndWaitForView.mockResolvedValue(tabReader);
        await activate();
        expect(openReader).toHaveBeenCalledWith(10, { pageIndex: 3 }, { openInWindow: true, allowDuplicate: true });
        expect(flashHighlightBoundingBoxes).toHaveBeenCalledWith(windowReader, expect.any(Array));
    });

    it('highlights in the selected reader tab when it already shows the cited PDF', async () => {
        getCurrentReaderAndWaitForView.mockResolvedValue(tabReader);
        await activate();
        expect(openReader).not.toHaveBeenCalled();
        expect(flashHighlightBoundingBoxes).toHaveBeenCalledWith(tabReader, expect.any(Array));
    });

    it('opens a reader tab when the caller asks for one, whatever the Zotero setting', async () => {
        openReaderInNewWindow = true;
        getCurrentReaderAndWaitForView.mockResolvedValueOnce(undefined).mockResolvedValueOnce(tabReader);
        await activate('tab');
        expect(openReader).toHaveBeenCalledWith(10, { pageIndex: 3 }, {});
        expect(flashHighlightBoundingBoxes).toHaveBeenCalledWith(tabReader, expect.any(Array));
    });

    it('opens a cited note in its own window rather than a tab for a window target', async () => {
        resolveItemReference.mockResolvedValue({ status: 'found', item: itemOf('note') });
        await activate('window', { citation_id: 'n', citation_type: 'item', resolved_ref: pdfCitation.resolved_ref });
        expect(openNoteWindow).toHaveBeenCalledWith(10);
        expect(openNote).not.toHaveBeenCalled();
    });
});

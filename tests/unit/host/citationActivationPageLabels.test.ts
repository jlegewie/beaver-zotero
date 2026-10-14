/**
 * Temporary citation highlights shown in Zotero's reader carry the labels the
 * PDF declares, never the citation's printed labels.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createBoundingBoxHighlights: vi.fn(async () => []),
    getZoteroLocatorPageLabels: vi.fn(),
    reader: { itemID: 101, navigate: vi.fn() },
}));

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));
vi.mock('../../../react/runtime/windowRuntime', () => ({ getContextWindow: vi.fn() }));
vi.mock('../../../react/runtime/navigation', () => ({
    AttachmentFileUnavailableError: class extends Error {},
    openNote: vi.fn(),
    openReader: vi.fn(async () => mocks.reader),
}));
vi.mock('../../../react/store', () => ({ store: { get: vi.fn(() => ({})), set: vi.fn() } }));
vi.mock('../../../react/atoms/ui', () => ({
    isExternalReferenceDetailsDialogVisibleAtom: Symbol('dialog'),
    selectedExternalReferenceAtom: Symbol('selected'),
}));
vi.mock('../../../react/utils/sourceUtils', () => ({ revealSource: vi.fn() }));
vi.mock('../../../react/utils/zoteroURI', () => ({ createZoteroURI: vi.fn(() => 'zotero://select/library/items/ATTACH01') }));
vi.mock('../../../react/utils/readerUtils', () => ({
    getCurrentReaderAndWaitForView: vi.fn(async () => mocks.reader),
}));
vi.mock('../../../react/utils/annotationUtils', () => ({
    BeaverTemporaryAnnotations: { cleanupAll: vi.fn(async () => {}), addToTracking: vi.fn() },
    createBoundingBoxHighlights: mocks.createBoundingBoxHighlights,
}));
vi.mock('../../../react/utils/citationNavigation', () => ({
    flashHighlightBoundingBoxes: vi.fn(),
    presentTemporaryAnnotations: vi.fn(),
}));
vi.mock('../../../react/utils/epubVisualizer/epubCitationNavigation', () => ({ navigateToEpubCitation: vi.fn() }));
vi.mock('../../../react/utils/snapshotVisualizer/snapshotCitationNavigation', () => ({ navigateToSnapshotCitation: vi.fn() }));
vi.mock('../../../src/services/documentExtraction/pageLabels', () => ({
    getZoteroLocatorPageLabels: mocks.getZoteroLocatorPageLabels,
}));
vi.mock('../../../react/host/zotero/sourceActions', () => ({
    launchExternalFile: vi.fn(),
    notifyReferenceUnavailable: vi.fn(),
}));
vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn((key: string) => key === 'useTemporaryCitationAnnotations'),
}));
vi.mock('../../../react/utils/selectItem', () => ({ selectItemById: vi.fn() }));
vi.mock('../../../src/utils/zoteroItemHelpers', () => ({
    getBestPDFAttachmentAsync: vi.fn(),
    getBestReadableTextAttachmentAsync: vi.fn(),
}));
vi.mock('../../../src/utils/libraryIdentity', () => ({
    libraryRefForLibraryID: vi.fn(() => 'u'),
    resolveItemReference: vi.fn(async () => ({ status: 'found', item: attachment })),
}));
vi.mock('../../../src/utils/zoteroDataLoading', () => ({ getParentItemAsync: vi.fn() }));
vi.mock('../../../src/utils/attachmentFiles', () => ({ isPdfDocument: vi.fn(() => true) }));

const attachment = {
    id: 101,
    libraryID: 1,
    key: 'ATTACH01',
    loadAllData: vi.fn(async () => {}),
    isNote: () => false,
    isAnnotation: () => false,
    isRegularItem: () => false,
    isAttachment: () => true,
};

import { activateCitation } from '../../../react/host/zotero/citationActivation';

function activate(metadata: Record<string, unknown>) {
    return activateCitation({
        metadata: {
            citation_id: 'c1',
            content_kind: 'pdf',
            locations: [{ page_idx: 0, boxes: [[10, 20, 110, 50]] }],
            ...metadata,
        } as any,
        isExternal: false,
        isExternalFile: false,
        externalFileKey: null,
        hasMappedItem: false,
        effectiveLibraryID: 1,
        effectiveItemKey: 'ATTACH01',
        previewText: 'preview',
    } as any);
}

describe('citation activation page labels', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('labels temporary highlights with the declared label, not the citation\'s printed one', async () => {
        mocks.getZoteroLocatorPageLabels.mockResolvedValue({ 0: 'iv' });

        await activate({ page_labels: { 0: '1205' } });

        expect(mocks.getZoteroLocatorPageLabels).toHaveBeenCalledWith(attachment);
        expect(mocks.createBoundingBoxHighlights).toHaveBeenCalledWith(
            [expect.objectContaining({ pageIndex: 0, pageLabel: 'iv' })],
            'preview',
            expect.anything(),
            expect.anything(),
        );
    });

    it('falls back to the physical page when the PDF declares no label', async () => {
        mocks.getZoteroLocatorPageLabels.mockResolvedValue(null);

        await activate({ page_labels: { 0: '1205' } });

        expect(mocks.createBoundingBoxHighlights).toHaveBeenCalledWith(
            [expect.objectContaining({ pageIndex: 0, pageLabel: '1' })],
            'preview',
            expect.anything(),
            expect.anything(),
        );
    });
});

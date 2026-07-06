import { store } from '../../store';
import { pageLabelsByAttachmentIdAtom } from '../../atoms/citations';
import { externalReferenceMappingAtom } from '../../atoms/externalReferences';
import {
    isExternalReferenceDetailsDialogVisibleAtom,
    selectedExternalReferenceAtom,
} from '../../atoms/ui';
import {
    getCitationPages,
    getCitationBoundingBoxes,
    getContentKind,
    getSymbolicLocation,
} from '../../types/citations';
import { ZoteroItemReference } from '../../types/zotero';
import { revealSource } from '../../utils/sourceUtils';
import { createZoteroURI } from '../../utils/zoteroURI';
import { getCurrentReaderAndWaitForView } from '../../utils/readerUtils';
import {
    BeaverTemporaryAnnotations,
    createBoundingBoxHighlights,
} from '../../utils/annotationUtils';
import {
    flashHighlightBoundingBoxes,
    presentTemporaryAnnotations,
} from '../../utils/citationNavigation';
import { navigateToEpubCitation } from '../../utils/epubVisualizer/epubCitationNavigation';
import { navigateToSnapshotCitation } from '../../utils/snapshotVisualizer/snapshotCitationNavigation';
import { resolvePageLabelFromLabels } from '../../utils/pageLabels';
import { getPageLabelsForItem } from './itemData';
import { launchExternalFile, notifyReferenceUnavailable } from './sourceActions';
import { getPref } from '../../../src/utils/prefs';
import { logger } from '../../../src/utils/logger';
import { selectItemById } from '../../../src/utils/selectItem';
import {
    getBestPDFAttachmentAsync,
    getBestReadableTextAttachmentAsync,
} from '../../../src/utils/zoteroItemHelpers';
import { BEAVER_CITATION_ANNOTATION_AUTHOR } from '../../../src/constants/annotations';
import type { CitationActivation } from '../types';

/** Reveal the cited item in the library view. */
function revealInLibrary(libraryID: number, zoteroKey: string): void {
    revealSource({ library_id: libraryID, zotero_key: zoteroKey } as ZoteroItemReference);
}

/**
 * Zotero implementation of citation activation: navigate to / open the cited
 * location. Mirrors the citation click behavior across all content kinds (note,
 * annotation, text, EPUB, PDF) and reference types (external, external file).
 */
export async function activateCitation(activation: CitationActivation): Promise<void> {
    const {
        metadata,
        isExternal,
        isExternalFile,
        externalFileKey,
        externalSourceId,
        hasMappedItem,
        effectiveLibraryID,
        effectiveItemKey,
        previewText,
        ownerDocument,
    } = activation;

    const useTemporaryCitationAnnotations = getPref('useTemporaryCitationAnnotations') === true;
    logger('Citation activation: handle citation click');

    // External citations without Zotero mapping - open details dialog
    if (isExternal && !hasMappedItem) {
        logger('Citation activation: External citation - opening details dialog');
        if (externalSourceId) {
            const externalReference = store.get(externalReferenceMappingAtom)[externalSourceId];
            if (externalReference) {
                store.set(selectedExternalReferenceAtom, externalReference);
                store.set(isExternalReferenceDetailsDialogVisibleAtom, true);
            }
        }
        return;
    }

    // External-file citations: open the locally stored copy. There is no
    // reader navigation for external files, so page/sentence clicks just
    // launch the file; a missing local copy (file attached on another
    // computer) is a quiet no-op.
    if (isExternalFile) {
        logger(`Citation activation: External file citation (ext-${externalFileKey})`);
        if (!externalFileKey) return;
        await launchExternalFile(externalFileKey);
        return;
    }

    // Cleanup any existing temporary annotations
    await BeaverTemporaryAnnotations.cleanupAll();

    if (!effectiveLibraryID || !effectiveItemKey) {
        logger('Citation activation: No valid item reference');
        return;
    }

    logger(`Citation activation: Zotero Item (${effectiveLibraryID}, ${effectiveItemKey})`);
    const item = await Zotero.Items.getByLibraryAndKeyAsync(effectiveLibraryID, effectiveItemKey);

    if (!item) {
        logger(`Citation activation: Failed to get Zotero item (${effectiveLibraryID}, ${effectiveItemKey})`);
        notifyReferenceUnavailable('item');
        return;
    }

    await item.loadAllData();

    const contentKind = getContentKind(metadata);
    const symbolicLocation = getSymbolicLocation(metadata);

    // Handle note links using Zotero.Notes.open()
    if (item.isNote()) {
        logger(`Citation activation: Note Link (${item.id})`);
        if (typeof Zotero.Notes?.open === 'function') {
            await Zotero.Notes.open(item.id, undefined);
        } else {
            await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
        }
        return;
    }

    // Handle annotation citations: open the parent attachment in the
    // reader and navigate via annotationID
    if (item.isAnnotation()) {
        const parentAttachment = item.parentItem;
        if (!parentAttachment || !parentAttachment.isAttachment()) {
            logger(`Citation activation: Annotation ${item.id} has no parent attachment`);
            return;
        }
        try {
            let reader = await getCurrentReaderAndWaitForView(undefined, true);
            if (!reader || reader.itemID !== parentAttachment.id) {
                reader = await Zotero.Reader.open(parentAttachment.id);
                await new Promise((resolve) => setTimeout(resolve, 300));
                reader = await getCurrentReaderAndWaitForView(undefined, true);
            }
            if (reader) {
                setTimeout(() => {
                    reader.navigate({ annotationID: item.key });
                }, 100);
            }
        } catch (error) {
            logger('Citation activation: Failed to open annotation: ' + error);
        }
        return;
    }

    if (contentKind === 'text') {
        // Resolved text citations should normally point at the attachment;
        // this keeps older or incomplete regular-item metadata navigable.
        const target = item.isAttachment()
            ? item
            : await getBestReadableTextAttachmentAsync(item);
        if (!target) {
            revealInLibrary(item.libraryID, item.key);
            return;
        }
        const filePath = await target.getFilePathAsync();
        if (filePath) {
            if (symbolicLocation?.content_kind === 'text') {
                const lineEnd = symbolicLocation.line_end ?? symbolicLocation.line;
                logger(
                    `Citation activation: Opening text file at lines ${symbolicLocation.line}-${lineEnd}: ${filePath}`,
                );
            } else {
                logger(`Citation activation: Opening text file: ${filePath}`);
            }
            Zotero.launchFile(filePath);
        } else {
            await selectItemById(target.id);
        }
        return;
    }

    if (contentKind === 'epub') {
        // EPUB locator model: agent-facing "page N" is the 1-based spine
        // section ordinal; the symbolic location (when present) carries the
        // precise section href / anchor / sentence text.
        const epubSymbolicLocation = symbolicLocation?.content_kind === 'epub'
            ? symbolicLocation
            : undefined;
        const sectionOrdinals = getCitationPages(metadata);
        const hasEpubLocator = !!epubSymbolicLocation || sectionOrdinals.length > 0;
        logger(`Citation activation: EPUB citation (symbolic: ${!!epubSymbolicLocation}, sections: ${sectionOrdinals.length})`);

        if (item.isRegularItem() && !hasEpubLocator) {
            revealInLibrary(item.libraryID, item.key);
            return;
        }

        const outcome = await navigateToEpubCitation({
            item,
            symbolicLocation: epubSymbolicLocation,
            sectionOrdinal: sectionOrdinals[0],
            searchText: metadata?.preview || undefined,
            previewText,
            useTemporaryAnnotations: useTemporaryCitationAnnotations,
            ownerDocument,
        });
        logger(`Citation activation: EPUB navigation outcome: ${outcome}`);
        if (outcome === 'failed') {
            revealInLibrary(item.libraryID, item.key);
        }
        return;
    }

    if (contentKind === 'snapshot') {
        // Snapshot locator model: the symbolic location carries the cited
        // selector / anchor / passage text. There is no section/page navigation
        // (the reader is a continuous scroll view), so a regular item with no
        // symbolic locator just reveals in the library.
        const snapshotSymbolicLocation = symbolicLocation?.content_kind === 'snapshot'
            ? symbolicLocation
            : undefined;
        const hasSnapshotLocator = !!snapshotSymbolicLocation || !!(metadata?.preview);
        logger(`Citation activation: snapshot citation (symbolic: ${!!snapshotSymbolicLocation})`);

        if (item.isRegularItem() && !hasSnapshotLocator) {
            revealInLibrary(item.libraryID, item.key);
            return;
        }

        const outcome = await navigateToSnapshotCitation({
            item,
            symbolicLocation: snapshotSymbolicLocation,
            searchText: metadata?.preview || undefined,
            previewText,
            useTemporaryAnnotations: useTemporaryCitationAnnotations,
            ownerDocument,
        });
        logger(`Citation activation: snapshot navigation outcome: ${outcome}`);
        if (outcome === 'failed') {
            revealInLibrary(item.libraryID, item.key);
        }
        return;
    }

    if (contentKind !== 'pdf') {
        logger(`Citation activation: Non-PDF citation (${contentKind})`);
        if (item.isRegularItem()) {
            revealInLibrary(item.libraryID, item.key);
            return;
        }
        if (item.isAttachment()) {
            try {
                await Zotero.Reader.open(item.id);
            } catch (error) {
                logger(`Citation activation: Failed to open non-PDF attachment: ${error}`);
                await selectItemById(item.id);
            }
            return;
        }
        revealInLibrary(item.libraryID, item.key);
        return;
    }

    // Get locator data before regular-item handling. Some citations are
    // resolved to parent items even though the raw tag includes page
    // locators; those should navigate to the item's PDF attachment.
    const boundingBoxData = getCitationBoundingBoxes(metadata);
    const pages = getCitationPages(metadata);
    const hasPdfLocator = boundingBoxData.length > 0 || pages.length > 0;
    let pdfItem = item;

    // Handle regular items
    if (item.isRegularItem()) {
        if (hasPdfLocator) {
            const attachment = await getBestPDFAttachmentAsync(item);
            const isPdfAttachment = !!attachment && (
                attachment.isPDFAttachment?.() ||
                attachment.attachmentContentType === 'application/pdf'
            );
            if (isPdfAttachment) {
                logger(`Citation activation: Regular item locator resolved to PDF attachment (${attachment.id})`);
                pdfItem = attachment;
            } else {
                logger(`Citation activation: Regular item has locator but no PDF attachment (${item.id})`);
                revealInLibrary(item.libraryID, item.key);
                return;
            }
        } else {
            logger(`Citation activation: Selecting regular item (${item.id})`);
            revealInLibrary(item.libraryID, item.key);
            return;
        }
    }

    // Handle file links (computed lazily: rendering never needs the URI)
    const itemUri = createZoteroURI(item);
    if (itemUri.startsWith('file:///')) {
        const filePath = itemUri.replace('file:///', '');
        logger(`Citation activation: File Link (${filePath})`);
        Zotero.launchFile(filePath);
        return;
    }

    logger(`Citation activation: Citation Location (boundingBoxData.length: ${boundingBoxData.length}, pages.length: ${pages.length})`);

    if (pdfItem.isAttachment() && boundingBoxData.length == 0 && pages.length == 0) {
        logger(`Citation activation: Selecting attachment (${pdfItem.id})`);
        await selectItemById(pdfItem.id);
        return;
    }

    try {
        let reader = await getCurrentReaderAndWaitForView(undefined, true);
        logger(`Citation activation: Current Reader (${reader?.itemID})`);

        // Check if we need to open or switch to the correct PDF
        if (!reader || reader.itemID !== pdfItem.id) {
            logger(`Citation activation: Opening PDF in reader or switching to the correct PDF`);

            // Determine the page to open
            let pageIndex = 1;
            if (boundingBoxData.length > 0) {
                pageIndex = boundingBoxData[0].page;
            } else if (pages.length > 0) {
                pageIndex = pages[0];
            }

            // Open the PDF at page
            logger(`Citation activation: Opening item ${pdfItem.id} at page ${pageIndex}`);
            reader = await Zotero.Reader.open(pdfItem.id, { pageIndex: pageIndex - 1 });

            // Wait for reader to initialize (should already be done by getCurrentReaderAndWaitForView)
            await new Promise(resolve => setTimeout(resolve, 300));
            reader = await getCurrentReaderAndWaitForView(undefined, true);
        }

        // Handle the three scenarios
        if (boundingBoxData.length > 0) {
            const loadedPageLabels = getPageLabelsForItem(pdfItem, store.get(pageLabelsByAttachmentIdAtom));
            const highlightLocations = boundingBoxData.map(({ page, bboxes, pageLabel }) => ({
                pageIndex: page - 1,
                boxes: bboxes,
                pageLabel: pageLabel ?? resolvePageLabelFromLabels(loadedPageLabels, page),
            }));

            if (useTemporaryCitationAnnotations) {
                logger(`Citation activation: Highlighting bounding boxes with temporary annotations`);
                const annotationReferences = await createBoundingBoxHighlights(
                    highlightLocations,
                    previewText,
                    BEAVER_CITATION_ANNOTATION_AUTHOR,
                    { authorName: BEAVER_CITATION_ANNOTATION_AUTHOR },
                );
                if (reader) {
                    presentTemporaryAnnotations(reader, annotationReferences, {
                        ownerDocument,
                        logContext: 'CitationActivation',
                    });
                } else {
                    // Keep created annotations tracked for cleanup even
                    // when the reader handle is unavailable.
                    BeaverTemporaryAnnotations.addToTracking(annotationReferences);
                }
            } else {
                logger(`Citation activation: Flashing highlight for bounding boxes`);
                if (reader) {
                    await flashHighlightBoundingBoxes(reader, highlightLocations);
                }
            }
        } else if (pages.length > 0) {
            logger(`Citation activation: Navigating to page ${pages[0]}`);
            // Scenario 2: With pages only - navigate to page
            if (reader) {
                reader.navigate({ pageIndex: pages[0] - 1 });
            }
        }
        // Scenario 3: No locators - PDF is already open, nothing more needed

    } catch (error) {
        logger('Citation activation: Failed to handle citation click: ' + error);

        // Fallback: try the URI-based approach from the loaded item
        try {
            const fallbackUri = createZoteroURI(item);
            if (fallbackUri.includes('zotero://')) {
                Zotero.getMainWindow().location.href = fallbackUri;
            }
        } catch {
            // No usable fallback URI; nothing else to do.
        }
    }
}

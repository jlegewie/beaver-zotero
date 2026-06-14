import React from 'react';
import Tooltip from '../ui/Tooltip';
import { useAtomValue, useSetAtom } from 'jotai';
import { pageLabelsByAttachmentIdAtom } from '../../atoms/citations';
import { getPref } from '../../../src/utils/prefs';
import { createZoteroURI } from '../../utils/zoteroURI';
import {
    getCitationPages,
    getCitationBoundingBoxes,
    getContentKind,
    getSymbolicLocation,
} from '../../types/citations';
import { selectItemById } from '../../../src/utils/selectItem';
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
import { logger } from '../../../src/utils/logger';
import { externalReferenceMappingAtom } from '../../atoms/externalReferences';
import { useCitationMarker } from '../../hooks/useCitationMarker';
import { ZoteroItemReference } from '../../types/zotero';
import { getHost } from '../../host';
import { resolvePageLabelFromLabels, translatePageNumberToLabelFromLabels } from '../../utils/pageLabels';
import { getBestPDFAttachmentAsync, getBestReadableTextAttachmentAsync } from '../../../src/utils/zoteroItemHelpers';
import { BEAVER_CITATION_ANNOTATION_AUTHOR } from '../../../src/constants/annotations';
import { getPageLocator } from '../../utils/citationGrammar';
import { useCitationViewModel } from '../citations/useCitationViewModel';
import { getPageLabelsForItem } from '../../host/zotero/itemData';
import {
    isExternalReferenceDetailsDialogVisibleAtom,
    selectedExternalReferenceAtom
} from '../../atoms/ui';
import { Icon, LibraryIcon, PdfIcon, GlobalSearchIcon, NoteIcon, HighlighterIcon, TextAlignLeftIcon, ExternalLinkIcon } from '../icons/icons';
import {
    buildZoteroCitationLinkHTML,
    isLinkCitationItem,
} from '../../../src/utils/zoteroLinkCitation';
const TOOLTIP_WIDTH = '250px';
export const BEAVER_ANNOTATION_TEXT = BEAVER_CITATION_ANNOTATION_AUTHOR;

/**
 * Props for ZoteroCitation component.
 * 
 * Supported citation tag formats from LLM:
 *   <citation id="libraryID-itemKey"/>           - Zotero item reference
 *   <citation id="..." loc="page5"/>             - Zotero item with page reference
 *   <citation id="..." loc="s25"/>               - Zotero item with sentence/record ID
 *   <citation external_id="..."/>                - external reference
 * Legacy item_id/att_id/page attrs are still accepted by preprocessing.
 * 
 * Note: Props are passed from HTML attributes after sanitization,
 * so values may have 'user-content-' prefix added by rehype-sanitize.
 */
interface ZoteroCitationProps {
    dataLibraryId?: string | number;
    dataZoteroKey?: string;
    dataExternalId?: string;
    dataExternalSource?: string;
    dataExtKey?: string;
    dataLoc?: string;
    dataLocKind?: string;
    dataLocValue?: string;
    dataRequestedCitationKey?: string;
    dataResolvedCitationKey?: string;
    dataConsecutive?: boolean | string;
    dataAdjacent?: boolean | string;
    dataInvalidReason?: string;
    dataRawIdentity?: string;
    dataIdentityAttr?: string;
    [key: string]: unknown;
    // Rendering options
    exportRendering?: boolean;
    children?: React.ReactNode;
}

const ZoteroCitation: React.FC<ZoteroCitationProps> = (props) => {
    const { exportRendering = false } = props;

    // Derive the render-ready view model. This is client-agnostic: it reads only
    // self-contained citation metadata (citation v2) and shared atoms, with the
    // one host-specific concern (legacy page-label fallback) delegated to the
    // citation host. Zotero data access below is confined to the click/export
    // paths, which are inherently host-specific.
    const vm = useCitationViewModel(props as Record<string, unknown>);
    const {
        metadata: citationMetadata,
        isExternal,
        isExternalFile,
        externalFileKey,
        markerKey,
        displayState,
        isStreaming,
        isInvalid,
        libraryID,
        itemKey,
        requestedRef,
        externalSourceId,
        mappedZoteroItem,
        effectiveLibraryID,
        effectiveItemKey,
        consecutive,
        citation,
        previewText,
        pageLabels,
        pagesDisplay,
        pages,
    } = vm;

    // Atoms still needed for the Zotero-specific click/export handling below.
    const externalReferenceMap = useAtomValue(externalReferenceMappingAtom);
    const labelsByAttachmentId = useAtomValue(pageLabelsByAttachmentIdAtom);

    // For opening external reference details dialog
    const setIsDetailsVisible = useSetAtom(isExternalReferenceDetailsDialogVisibleAtom);
    const setSelectedReference = useSetAtom(selectedExternalReferenceAtom);

    // Get the citation format preference
    const authorYearFormat = getPref("citationFormat") !== "numeric";

    // Get or assign numeric marker using base key (same item = same marker)
    // Uses markerKey (without sid/page) so all citations to the same item share a marker
    const numericMarker = useCitationMarker(markerKey, exportRendering);

    // Render as soon as we have an identifier; citationMetadata may arrive later.
    // 'error' state means no valid identifier was found - don't render.
    if (displayState === 'error') return null;

    // Click handler for navigating to the cited item/location
    const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        const ownerDocument = e.currentTarget.ownerDocument;
        const useTemporaryCitationAnnotations = getPref("useTemporaryCitationAnnotations") === true;
        logger('ZoteroCitation: Handle citation click');

        if (isStreaming) {
            logger('ZoteroCitation: Citation metadata not available yet - streaming');
            return;
        }
        
        if (isInvalid) {
            logger('ZoteroCitation: Citation is invalid - cannot navigate');
            return;
        }
        
        // External citations without Zotero mapping - open details dialog
        if (isExternal && !mappedZoteroItem) {
            logger('ZoteroCitation: External citation - opening details dialog');
            if (externalSourceId) {
                const externalReference = externalReferenceMap[externalSourceId];
                if (externalReference) {
                    setSelectedReference(externalReference);
                    setIsDetailsVisible(true);
                }
            }
            return;
        }

        // External-file citations: open the locally stored copy. There is no
        // reader navigation for external files, so page/sentence clicks just
        // launch the file; a missing local copy (file attached on another
        // computer) is a quiet no-op.
        if (isExternalFile) {
            logger(`ZoteroCitation: External file citation (ext-${externalFileKey})`);
            if (!externalFileKey) return;
            try {
                const record = await Zotero.Beaver?.db?.getExternalFileByKey(externalFileKey);
                const path = record?.storedPath ?? null;
                if (path && (await IOUtils.exists(path).catch(() => false))) {
                    Zotero.launchFile(path);
                } else {
                    logger(`ZoteroCitation: External file ext-${externalFileKey} has no local copy`);
                }
            } catch (error) {
                logger(`ZoteroCitation: Failed to open external file: ${error}`, 2);
            }
            return;
        }
        
        // Cleanup any existing temporary annotations
        await BeaverTemporaryAnnotations.cleanupAll();
        
        // Use the already-computed identity (no need to re-parse from DOM)
        if (!effectiveLibraryID || !effectiveItemKey) {
            logger('ZoteroCitation: No valid item reference');
            return;
        }

        logger(`ZoteroCitation: Zotero Item (${effectiveLibraryID}, ${effectiveItemKey})`);
        const item = await Zotero.Items.getByLibraryAndKeyAsync(effectiveLibraryID, effectiveItemKey);

        if (!item) {
            logger(`ZoteroCitation: Failed to get Zotero item (${libraryID}, ${itemKey})`);
            return;
        }

        await item.loadAllData();

        const contentKind = getContentKind(citationMetadata);
        const symbolicLocation = getSymbolicLocation(citationMetadata);

        // Handle note links using Zotero.Notes.open()
        if (item.isNote()) {
            logger(`ZoteroCitation: Note Link (${item.id})`);
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
                logger(`ZoteroCitation: Annotation ${item.id} has no parent attachment`);
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
                logger('ZoteroCitation: Failed to open annotation: ' + error);
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
                getHost().navigation?.revealInLibrary({ library_id: item.libraryID, zotero_key: item.key } as ZoteroItemReference);
                return;
            }
            const filePath = await target.getFilePathAsync();
            if (filePath) {
                if (symbolicLocation?.content_kind === 'text') {
                    const lineEnd = symbolicLocation.line_end ?? symbolicLocation.line;
                    logger(
                        `ZoteroCitation: Opening text file at lines ${symbolicLocation.line}-${lineEnd}: ${filePath}`,
                    );
                } else {
                    logger(`ZoteroCitation: Opening text file: ${filePath}`);
                }
                getHost().navigation?.launchFile(filePath);
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
            const sectionOrdinals = getCitationPages(citationMetadata);
            const hasEpubLocator = !!epubSymbolicLocation || sectionOrdinals.length > 0;
            logger(`ZoteroCitation: EPUB citation (symbolic: ${!!epubSymbolicLocation}, sections: ${sectionOrdinals.length})`);

            if (item.isRegularItem() && !hasEpubLocator) {
                getHost().navigation?.revealInLibrary({ library_id: item.libraryID, zotero_key: item.key } as ZoteroItemReference);
                return;
            }

            const outcome = await navigateToEpubCitation({
                item,
                symbolicLocation: epubSymbolicLocation,
                sectionOrdinal: sectionOrdinals[0],
                searchText: citationMetadata?.preview || undefined,
                previewText,
                useTemporaryAnnotations: useTemporaryCitationAnnotations,
                ownerDocument,
            });
            logger(`ZoteroCitation: EPUB navigation outcome: ${outcome}`);
            if (outcome === 'failed') {
                getHost().navigation?.revealInLibrary({ library_id: item.libraryID, zotero_key: item.key } as ZoteroItemReference);
            }
            return;
        }

        if (contentKind !== 'pdf') {
            logger(`ZoteroCitation: Non-PDF citation (${contentKind})`);
            if (item.isRegularItem()) {
                getHost().navigation?.revealInLibrary({ library_id: item.libraryID, zotero_key: item.key } as ZoteroItemReference);
                return;
            }
            if (item.isAttachment()) {
                try {
                    await Zotero.Reader.open(item.id);
                } catch (error) {
                    logger(`ZoteroCitation: Failed to open non-PDF attachment: ${error}`);
                    await selectItemById(item.id);
                }
                return;
            }
            getHost().navigation?.revealInLibrary({ library_id: item.libraryID, zotero_key: item.key } as ZoteroItemReference);
            return;
        }

        // Get locator data before regular-item handling. Some citations are
        // resolved to parent items even though the raw tag includes page
        // locators; those should navigate to the item's PDF attachment.
        const boundingBoxData = getCitationBoundingBoxes(citationMetadata);
        const pages = getCitationPages(citationMetadata);
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
                    logger(`ZoteroCitation: Regular item locator resolved to PDF attachment (${attachment.id})`);
                    pdfItem = attachment;
                } else {
                    logger(`ZoteroCitation: Regular item has locator but no PDF attachment (${item.id})`);
                    getHost().navigation?.revealInLibrary({ library_id: item.libraryID, zotero_key: item.key } as ZoteroItemReference);
                    return;
                }
            } else {
                logger(`ZoteroCitation: Selecting regular item (${item.id})`);
                // await selectItemById(item.id);
                getHost().navigation?.revealInLibrary({ library_id: item.libraryID, zotero_key: item.key } as ZoteroItemReference);
                return;
            }
        }

        // Handle file links (computed lazily: rendering never needs the URI)
        const itemUri = createZoteroURI(item);
        if (itemUri.startsWith('file:///')) {
            const filePath = itemUri.replace('file:///', '');
            logger(`ZoteroCitation: File Link (${filePath})`);
            getHost().navigation?.launchFile(filePath);
            return;
        }

        // // Handle attachment links
        // if (!item.isAttachment()) {
        //     logger(`ZoteroCitation: Not an attachment (${item.id})`);
        //     return;
        // }

        logger(`ZoteroCitation: Citation Location (boundingBoxData.length: ${boundingBoxData.length}, pages.length: ${pages.length})`);

        // Handle regular items
        if (pdfItem.isAttachment() && boundingBoxData.length == 0 && pages.length == 0) {
            logger(`ZoteroCitation: Selecting attachment (${pdfItem.id})`);
            await selectItemById(pdfItem.id);
            return;
        }

        try {
            let reader = await getCurrentReaderAndWaitForView(undefined, true);
            logger(`ZoteroCitation: Current Reader (${reader?.itemID})`);
            
            // Check if we need to open or switch to the correct PDF
            if (!reader || reader.itemID !== pdfItem.id) {
                logger(`ZoteroCitation: Opening PDF in reader or switching to the correct PDF`);

                // Determine the page to open
                let pageIndex = 1;
                if (boundingBoxData.length > 0) {
                    pageIndex = boundingBoxData[0].page;
                } else if (pages.length > 0) {
                    pageIndex = pages[0];
                }

                // Open the PDF at page
                logger(`ZoteroCitation: Opening item ${pdfItem.id} at page ${pageIndex}`);
                reader = await Zotero.Reader.open(pdfItem.id, { pageIndex: pageIndex - 1 });

                // Wait for reader to initialize (should already be done by getCurrentReaderAndWaitForView)
                await new Promise(resolve => setTimeout(resolve, 300));
                reader = await getCurrentReaderAndWaitForView(undefined, true);
            }

            // Handle the three scenarios
            if (boundingBoxData.length > 0) {
                const loadedPageLabels = getPageLabelsForItem(pdfItem, labelsByAttachmentId);
                const highlightLocations = boundingBoxData.map(({ page, bboxes, pageLabel }) => ({
                    pageIndex: page - 1,
                    boxes: bboxes,
                    pageLabel: pageLabel ?? resolvePageLabelFromLabels(loadedPageLabels, page),
                }));

                if (useTemporaryCitationAnnotations) {
                    logger(`ZoteroCitation: Highlighting bounding boxes with temporary annotations`);
                    const annotationReferences = await createBoundingBoxHighlights(
                        highlightLocations,
                        previewText,
                        BEAVER_ANNOTATION_TEXT,
                        { authorName: BEAVER_CITATION_ANNOTATION_AUTHOR },
                    );
                    if (reader) {
                        presentTemporaryAnnotations(reader, annotationReferences, {
                            ownerDocument,
                            logContext: 'ZoteroCitation',
                        });
                    } else {
                        // Keep created annotations tracked for cleanup even
                        // when the reader handle is unavailable.
                        BeaverTemporaryAnnotations.addToTracking(annotationReferences);
                    }
                } else {
                    logger(`ZoteroCitation: Flashing highlight for bounding boxes`);
                    if (reader) {
                        await flashHighlightBoundingBoxes(reader, highlightLocations);
                    }
                }
            } else if (pages.length > 0) {
                logger(`ZoteroCitation: Navigating to page ${pages[0]}`);
                // Scenario 2: With pages only - navigate to page
                if (reader) {
                    reader.navigate({ pageIndex: pages[0] - 1 });
                }
            }
            // Scenario 3: No locators - PDF is already open, nothing more needed
            
        } catch (error) {
            logger('ZoteroCitation: Failed to handle citation click: ' + error);
            
            // Fallback: try the URI-based approach from the loaded item
            try {
                const fallbackUri = createZoteroURI(item);
                if (fallbackUri.includes('zotero://')) {
                    getHost().navigation?.openExternalUrl(fallbackUri);
                }
            } catch {
                // No usable fallback URI; nothing else to do.
            }
        }
    };

    // Format for display
    let displayText = '';
    if (authorYearFormat) {
        if (isStreaming || isInvalid) {
            // We don't know the author/year string yet, or citation is invalid. Render a subtle placeholder.
            displayText = '?';
        } else {
            displayText = consecutive
                ? (pages.length > 0 ? `p.${pagesDisplay}` : 'Ibid')
                : (pages.length > 0 ? `${citation}, p.${pagesDisplay}` : citation);
        }
    } else {
        // Numeric markers should be stable and independent of citationMetadata.
        // If key is missing (invalid/malformed citation) or invalid, show placeholder.
        displayText = (markerKey && !isInvalid) ? numericMarker : '?';
    }

    // Rendering for export to Zotero note (using CSL JSON for citations)
    if (exportRendering) {
        displayText = authorYearFormat ? ` (${displayText})` : ` [${displayText}]`;

        // External citations cannot be exported as proper Zotero citations
        if (isExternal && !mappedZoteroItem) {
            if (externalSourceId) {
                const externalReference = externalReferenceMap[externalSourceId];
                if (externalReference && externalReference.url) {
                    return (
                        <span>
                            (
                            <a href={externalReference.url} target="_blank" rel="noopener noreferrer">{citation}</a>
                            )
                        </span>
                    );
                }
            }
            return (<span>{`(${citation})`}</span>);
        }

        // External-file citations export as plain filename text (no Zotero
        // item to format, excluded from the bibliography). Preserve the cited
        // page/section locator so the export is as specific as the chat view.
        if (isExternalFile) {
            const locatorSuffix = pages.length > 0 ? `, p.${pagesDisplay}` : '';
            return (<span>{`(${citation}${locatorSuffix})`}</span>);
        }

        // For Zotero citations, use proper CSL format
        if (!effectiveLibraryID || !effectiveItemKey) return null;
        try {
            const item = Zotero.Items.getByLibraryAndKey(effectiveLibraryID, effectiveItemKey);
            if (!item) return null;
            if (isLinkCitationItem(item)) {
                const html = buildZoteroCitationLinkHTML(item);
                return <span dangerouslySetInnerHTML={{ __html: html }} />;
            }
            const itemData = Zotero.Utilities.Item.itemToCSLJSON(item.parentItem || item);
            const startPage = pages.length > 0 ? pages[0] : undefined;
            // Fallback: use page prop directly when metadata doesn't provide pages
            const requestedPage = requestedRef ? getPageLocator(requestedRef) : undefined;
            const loadedLabels = getPageLabelsForItem(item, labelsByAttachmentId);
            const exportLabels = loadedLabels ?? citationMetadata?.page_labels;
            // Zotero note clicks use the CSL locator as a PDF page label.
            // When labels are available, store the visible label for the physical page.
            const navLocator = startPage
                ? resolvePageLabelFromLabels(exportLabels, startPage)
                : (requestedPage ? translatePageNumberToLabelFromLabels(exportLabels, requestedPage) : undefined);
            const citationObj = {
                citationItems: [{
                    uris: [Zotero.URI.getItemURI(item.parentItem || item)],
                    itemData: itemData,
                    locator: navLocator,
                    // label: 'p.'
                }],
                properties: {}
            };
            const formatted = Zotero.EditorInstanceUtilities.formatCitation(citationObj);
            // Use dangerouslySetInnerHTML because formatCitation() returns HTML
            // (e.g., "(<span class="citation-item">Author, 2024</span>)").
            return (
                <span
                    className="citation"
                    data-citation={encodeURIComponent(JSON.stringify(citationObj))}
                    dangerouslySetInnerHTML={{ __html: formatted }}
                />
            );
        } catch (e) {
            logger(`ZoteroCitation: Item not loaded for ${effectiveLibraryID}/${effectiveItemKey}: ${e}`);
            return null;
        }
    }

    // Determine the CSS class based on citation type and state
    const isNoteCitation = citationMetadata?.citation_type === 'note';
    const isAnnotationCitation = citationMetadata?.citation_type === 'annotation';
    const isEpubCitation = getContentKind(citationMetadata) === 'epub';
    const hasEpubSymbolicLocator = isEpubCitation
        && getSymbolicLocation(citationMetadata)?.content_kind === 'epub';
    const isTextCitation = getContentKind(citationMetadata) === 'text';
    const symbolicLocationForDisplay = getSymbolicLocation(citationMetadata);
    const textLineLocation = isTextCitation && symbolicLocationForDisplay?.content_kind === 'text'
        ? symbolicLocationForDisplay
        : undefined;
    const hasBoundingBoxes = !isNoteCitation && !isAnnotationCitation && !!citationMetadata && getCitationBoundingBoxes(citationMetadata).length > 0;
    const hasLocator = !isNoteCitation && !isAnnotationCitation && (pages.length > 0 || hasBoundingBoxes || hasEpubSymbolicLocator);
    const citationClassBase = isExternal && !mappedZoteroItem
        ? "zotero-citation external-citation"
        : (hasLocator || isAnnotationCitation) && !isExternalFile
        ? "zotero-citation with-locator"
        : "zotero-citation";
    const citationClass = isStreaming
        ? `${citationClassBase} streaming`
        : isInvalid
        ? `${citationClassBase} invalid`
        : citationClassBase;
    const showPreviewText = previewText && previewText !== citation;

    const citationElement = (
        <span 
            onClick={(isStreaming || isInvalid) ? undefined : handleClick}
            className={citationClass}
            data-pages={pages}
            data-item-key={itemKey}
            data-library-id={libraryID}
        >
            {displayText}
        </span>
    );

    const citationPreview = (
        <span className="block" style={{ overflow: 'hidden' }}>
            <span className="px-3 py-15 display-flex flex-row border-bottom-quinary gap-2">
                <span className="font-color-primary text-sm" style={{ minWidth: 0, wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                    {citation}
                </span>
                <span className="flex-1" />
                {pages && pages.length > 0 && pages[0] && (
                    <span className="font-color-secondary text-sm" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                        {isEpubCitation ? `Section ${pageLabels[0]}` : `Page ${pageLabels[0]}`}
                    </span>
                )}
                {(!pages || pages.length === 0) && textLineLocation && (
                    <span className="font-color-secondary text-sm" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                        {textLineLocation.line_end && textLineLocation.line_end !== textLineLocation.line
                            ? `Lines ${textLineLocation.line}–${textLineLocation.line_end}`
                            : `Line ${textLineLocation.line}`}
                    </span>
                )}
            </span>
            {showPreviewText && (
                <span className="font-color-secondary text-sm px-3 py-15 block" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                    {previewText}
                </span>
            )}
            {isExternal && !mappedZoteroItem && (
                <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                    <span className="display-flex flex-row items-center gap-15">
                        <Icon icon={GlobalSearchIcon} className="font-color-secondary" />
                        <span className="text-sm font-color-secondary">
                            View details
                        </span>
                    </span>
                </span>
            )}
            {isExternalFile && (
                <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                    <span className="display-flex flex-row items-center gap-15">
                        <Icon icon={ExternalLinkIcon} className="font-color-secondary scale-90" />
                        <span className="text-sm font-color-secondary">
                            Opens external file
                        </span>
                    </span>
                </span>
            )}
            {isNoteCitation && !isExternalFile && (!isExternal || !!mappedZoteroItem) && (
                <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                    <span className="display-flex flex-row items-center gap-15">
                        <Icon icon={NoteIcon} className="font-color-secondary" />
                        <span className="text-sm font-color-secondary">
                            Opens note
                        </span>
                    </span>
                </span>
            )}
            {isAnnotationCitation && !isExternalFile && (!isExternal || !!mappedZoteroItem) && (
                <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                    <span className="display-flex flex-row items-center gap-15">
                        <Icon icon={HighlighterIcon} className="font-color-secondary" />
                        <span className="text-sm font-color-secondary">
                            Opens annotation in PDF
                        </span>
                    </span>
                </span>
            )}
            {hasLocator && !isExternalFile && (!isExternal || !!mappedZoteroItem) && (
                <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                    <span className="display-flex flex-row items-center gap-15">
                        <Icon icon={PdfIcon} className="font-color-secondary" />
                        <span className="text-sm font-color-secondary">
                            {isEpubCitation
                                ? (pages[0] != null ? `Opens EPUB at section ${pageLabels[0]}` : 'Opens EPUB at cited passage')
                                : hasBoundingBoxes
                                    ? (pages[0] != null ? `Highlights passage on page ${pageLabels[0]}` : 'Highlights passage in PDF')
                                    : (pages[0] != null ? `Opens PDF on page ${pageLabels[0]}` : 'Opens PDF at location')}
                        </span>
                    </span>
                </span>
            )}
            {isTextCitation && !isExternalFile && !isNoteCitation && !isAnnotationCitation && (!isExternal || !!mappedZoteroItem) && (
                <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                    <span className="display-flex flex-row items-center gap-15">
                        <Icon icon={TextAlignLeftIcon} className="font-color-secondary scale-90" />
                        <span className="text-sm font-color-secondary">
                            Opens text file (external application)
                        </span>
                    </span>
                </span>
            )}
            {!hasLocator && !isExternalFile && !isTextCitation && !isNoteCitation && !isAnnotationCitation && (!isExternal || !!mappedZoteroItem) && (
                <span className={`px-3 py-15 block ${showPreviewText ? 'border-top-quinary' : ''}`}>
                    <span className="display-flex flex-row items-center gap-15">
                        <Icon icon={LibraryIcon} className="font-color-secondary" />
                        <span className="text-sm font-color-secondary">
                            Reveals item in library
                        </span>
                    </span>
                </span>
            )}
        </span>
    )

    // Return the citation with tooltip and click handler
    // - Streaming state: no tooltip (metadata not available yet)
    // - Invalid state: simple error tooltip
    // - Ready state: show tooltip with preview
    return (
        <>
            {exportRendering ?
                citationElement
            :
                isStreaming ?
                    citationElement
                :
                isInvalid ?
                    <Tooltip
                        content="Invalid citation"
                        width="104px"
                        singleLine
                    >
                        {citationElement}
                    </Tooltip>
                :
                    <Tooltip
                        content={previewText}
                        customContent={citationPreview}
                        width={TOOLTIP_WIDTH}
                        padding={false}
                    >
                        {citationElement}
                    </Tooltip>
            }
        </>
    );

};

export default ZoteroCitation;

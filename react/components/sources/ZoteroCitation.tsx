import React, { useState, useEffect } from 'react';
import Tooltip from '../ui/Tooltip';
import { useAtomValue } from 'jotai';
import { citationDataAtom } from '../../atoms/citations';
import { getPref } from '../../../src/utils/prefs';
import { parseZoteroURI } from '../../utils/zoteroURI';
import { getCitationFromItem, getReferenceFromItem } from '../../utils/sourceUtils';
import { createZoteroURI } from '../../utils/zoteroURI';
import { getCitationPages, getCitationBoundingBoxes, toZoteroRectFromBBox } from '../../types/citations';
import { formatNumberRanges } from '../../utils/stringUtils';
import { getCurrentReader } from '../../utils/readerUtils';
import { BeaverTemporaryAnnotations } from '../../utils/annotationUtils';
import { ZoteroItemReference } from '../../types/zotero';
import { logger } from '../../../src/utils/logger';

const TOOLTIP_WIDTH = '250px';
export const BEAVER_ANNOTATION_TEXT = 'Beaver Citation';

// Define prop types for the component
interface ZoteroCitationProps {
    id: string;           // Format: "libraryID-itemKey" (and 'user-content-' from sanitization)
    cid: string;
    pages?: string;       // Format: "3-6,19"
    consecutive?: boolean;
    children?: React.ReactNode;
    exportRendering?: boolean;
}

const ZoteroCitation: React.FC<ZoteroCitationProps> = ({ 
    id: unique_key,
    cid: citationId,
    consecutive = false,
    children,
    exportRendering = false
}) => {
    // Get the sources from atom state
    const citationsData = useAtomValue(citationDataAtom);

    // Get the citation format preference
    const authorYearFormat = getPref("citationFormat") !== "numeric";

    if (!unique_key || !citationId) return null;
    
    // Parse the id to get libraryID and itemKey
    unique_key = unique_key.replace('user-content-', '');
    const [libraryIDString, itemKey] = unique_key.includes('-') ? unique_key.split('-') : [unique_key, unique_key];
    const libraryID = parseInt(libraryIDString) || 1;

    // Find the attachmentCitation in the available sources
    const attachmentCitation = citationsData.find(a => a.citation_id === citationId);

    // Get citation data
    let formatted_citation = '';
    let citation = '';
    let url = '';
    let previewText = '';

    // If we have a attachmentCitation, use it
    if (attachmentCitation) {
        formatted_citation = attachmentCitation.formatted_citation || '';
        citation = attachmentCitation.citation || '';
        url = attachmentCitation.url || '';
        previewText = attachmentCitation.preview
            ? `"${attachmentCitation.preview}"`
            : formatted_citation || '';
    // Fallback: get the Zotero item and create the citation data
    } else {
        // Get the Zotero item
        const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
        if (!item) {
            logger('ZoteroCitation: Failed to format citation for id: ' + unique_key);
            return null;
        }

        // Get the citation data
        citation = getCitationFromItem(item);
        formatted_citation = getReferenceFromItem(item);
        url = createZoteroURI(item);
    }
    
    // Add the URL to open the PDF/Note
    const pages = getCitationPages(attachmentCitation);

    const firstPage = pages ? pages[0] : null;
    url = firstPage ? `${url}?page=${firstPage}` : url;
    
        // Create temporary annotations for bounding boxes
    const createBoundingBoxHighlights = async (boundingBoxData: any[], item: Zotero.Item) => {
        if (boundingBoxData.length === 0) return [];
        
        try {
            const reader = getCurrentReader();
            if (!reader || !reader._internalReader) {
                logger('ZoteroCitation: No active reader found for creating bounding box highlights');
                return [];
            }

            // Wait for reader initialization
            await reader._initPromise;

            const tempAnnotations: any[] = [];
            const annotationReferences: ZoteroItemReference[] = [];
            
            // Group bounding boxes by page
            const pageGroups = new Map<number, any[][]>();
            for (const { page, bboxes } of boundingBoxData) {
                if (!pageGroups.has(page)) {
                    pageGroups.set(page, []);
                }
                pageGroups.get(page)!.push(bboxes);
            }
            
            // Create one annotation per page with combined rects
            for (const [page, allBboxesOnPage] of pageGroups) {
                const pageIndex = page - 1; // Convert to 0-based index

                // Get the exact viewport used by the reader for this page
                const pageView = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer._pages[pageIndex];
                const viewBox = pageView.viewport.viewBox; // [xMin, yMin, xMax, yMax]
                const viewBoxLL: [number, number] = [viewBox[0], viewBox[1]];
                
                // Combine all bboxes on this page
                const combinedBboxes = allBboxesOnPage.flat();
                const rects = combinedBboxes.map(b => toZoteroRectFromBBox(b, viewBoxLL));
                
                // Create unique IDs for the temporary annotation
                const tempId = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const tempKey = `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                
                // Create properly structured annotation object matching Zotero.Annotations.toJSON() output
                const tempAnnotation = {
                    // Core identification
                    id: tempId,
                    key: tempKey,
                    libraryID: reader._item.libraryID,
                    
                    // Required annotation properties
                    type: 'highlight',
                    color: '#00bbff', // Blue highlight
                    sortIndex: `${pageIndex.toString().padStart(5, '0')}|000000|00000`,
                    position: {
                        pageIndex: pageIndex,
                        rects: rects
                    },
                    
                    // Critical properties to prevent crashes - MUST be present
                    tags: [],
                    comment: '',
                    text: `${BEAVER_ANNOTATION_TEXT}${page ? ` (Page ${page})` : ''}`,
                    authorName: 'Beaver',
                    pageLabel: '',
                    isExternal: false,
                    readOnly: false,
                    lastModifiedByUser: '',
                    dateModified: new Date().toISOString(),
                    
                    // Backup annotation properties
                    annotationType: 'highlight',
                    annotationAuthorName: 'Beaver',
                    annotationText: `${BEAVER_ANNOTATION_TEXT}${page ? ` (Page ${page})` : ''}`,
                    annotationComment: '',
                    annotationColor: '#00bbff',
                    annotationPageLabel: '',
                    annotationSortIndex: `${pageIndex.toString().padStart(5, '0')}|000000|00000`,
                    annotationPosition: JSON.stringify({
                        pageIndex: pageIndex,
                        rects: rects
                    }),
                    annotationIsExternal: false,
                    
                    // Mark as temporary so it doesn't get saved to database
                    isTemporary: true
                };
                
                tempAnnotations.push(tempAnnotation);
                
                // Create reference for tracking
                annotationReferences.push({
                    zotero_key: tempId,
                    library_id: reader._item.libraryID
                });
            }
            
            // Add temporary annotations directly to reader display (no database save)
            if (tempAnnotations.length > 0) {
                reader._internalReader.setAnnotations(
                    Components.utils.cloneInto(tempAnnotations, reader._iframeWindow)
                );
            }
            
            return annotationReferences;
        } catch (error) {
            logger('ZoteroCitation: Failed to create bounding box highlights: ' + error);
            return [];
        }
    };

    // Enhanced click handler with bounding box support
    const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        logger('ZoteroCitation: Handle citation click');
        
        // Cleanup any existing temporary annotations
        await BeaverTemporaryAnnotations.cleanupAll();
        
        // Get the item key and library ID from the data attributes or URL
        let itemKey: string | null = (e.target as HTMLElement).dataset.itemKey || null;
        let libraryID: number | null = parseInt((e.target as HTMLElement).dataset.libraryId || '0');
        
        // Fallback: parse the URL if the data attributes are not set
        if (!libraryID || !itemKey) {
            ({ libraryID, itemKey } = parseZoteroURI(url));
        }
        if (!libraryID || !itemKey) return;

        // Get the item
        logger(`ZoteroCitation: Zotero Item (${libraryID}, ${itemKey})`);
        const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
        if (!item) {
            logger(`ZoteroCitation: Failed to get Zotero item (${libraryID}, ${itemKey})`);
            return;
        }

        // Handle note links
        if (item.isNote()) {
            logger(`ZoteroCitation: Note Link (${item.id})`);
            await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
            return;
        }

        // Handle file links
        if (url.startsWith('file:///')) {
            const filePath = url.replace('file:///', '');
            logger(`ZoteroCitation: File Link (${filePath})`);
            Zotero.launchFile(filePath);
            return;
        }

        // // Handle attachment links
        // if (!item.isAttachment()) {
        //     logger(`ZoteroCitation: Not an attachment (${item.id})`);
        //     return;
        // }

        // Get bounding box data from citation
        const boundingBoxData = getCitationBoundingBoxes(attachmentCitation);
        const pages = getCitationPages(attachmentCitation);
        logger(`ZoteroCitation: Citation Location (boundingBoxData.length: ${boundingBoxData.length}, pages.length: ${pages.length})`);

        try {
            let reader = getCurrentReader();
            logger(`ZoteroCitation: Current Reader (${reader?.itemID})`);
            
            // Check if we need to open or switch to the correct PDF
            if (!reader || reader.itemID !== item.id) {
                logger(`ZoteroCitation: Opening PDF in reader or switching to the correct PDF`);

                // Determine the page to open
                let pageIndex = 0;
                if (boundingBoxData.length > 0) {
                    pageIndex = boundingBoxData[0].page;
                } else if (pages.length > 0) {
                    pageIndex = pages[0];
                }

                // Open the PDF at page
                logger(`ZoteroCitation: Opening PDF at page ${pageIndex}`);
                reader = await Zotero.Reader.open(item.id, { pageIndex: pageIndex - 1 });

                // Wait for reader to initialize
                if (reader && reader._initPromise) {
                    await reader._initPromise;
                }
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            // Handle the three scenarios
            if (boundingBoxData.length > 0) {
                logger(`ZoteroCitation: Highlighting bounding boxes`);
                // Scenario 1: With bounding boxes - create temporary highlights
                const annotationReferences = await createBoundingBoxHighlights(boundingBoxData, item);
                BeaverTemporaryAnnotations.addToTracking(annotationReferences);
                const annotationIds = annotationReferences.map(reference => reference.zotero_key);
                // Navigate to the first annotation if created successfully
                if (annotationIds.length > 0 && reader) {
                    // Small delay to ensure annotation is rendered
                    setTimeout(() => {
                        reader.navigate({annotationID: annotationIds[0]});
                    }, 100);
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
            
            // Fallback: try to use the original URL-based approach
            if (url.includes('zotero://')) {
                window.location.href = url;
            }
        }
    };

    // Cleanup effect for when component unmounts or citation changes
    useEffect(() => {
        return () => {
            // Cleanup temporary annotations when component unmounts
            if (BeaverTemporaryAnnotations.getCount() > 0) {
                logger('ZoteroCitation: cleanupTemporaryAnnotations');
                BeaverTemporaryAnnotations.cleanupAll().catch(logger);
            }
        };
    }, [citationId]);

    // Format for display
    let displayText = '';
    if (authorYearFormat) {
        displayText = consecutive
            ? (pages.length > 0 ? `p.${formatNumberRanges(pages)}` : 'Ibid')
            : (pages.length > 0 ? `${citation}, p.${formatNumberRanges(pages)}` : citation);
    } else {
        displayText = attachmentCitation?.numericCitation || citation;
    }
    if (exportRendering) {
        displayText = authorYearFormat ? ` (${displayText})` : ` [${displayText}]`;
    }

    // Rendering for export to Zotero note (using CSL JSON for citations)
    /*if (exportRendering) {
        const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
        if (!item) return null;
        const itemData = Zotero.Utilities.Item.itemToCSLJSON(item.parentItem || item);
        const citation = {
            citationItems: [{
                uris: [Zotero.URI.getItemURI(item.parentItem || item)],
                itemData: itemData,
                locator: pages || null
            }],
            properties: {}
        };
        const formatted = Zotero.EditorInstanceUtilities.formatCitation(citation);
        return (
            <span
                className="citation" 
                data-citation={encodeURIComponent(JSON.stringify(citation))}
            >
                {formatted}
            </span>
        );
    }*/

    const citationElement = (
        <span 
            onClick={handleClick} 
            className="zotero-citation"
            data-pages={pages}
            data-item-key={itemKey}
            data-library-id={libraryID}
        >
            {displayText}
        </span>
    );

    const citationPreview = (
        <div>
            <div className="px-3 py-15 display-flex flex-row border-bottom-quinary">
                <div className="font-color-primary text-sm">{citation}</div>
                <div className="flex-1"/>
                {pages && pages.length > 0 && pages[0] &&
                    <div className="font-color-secondary text-sm">Page {pages[0]}</div>
                }
                
            </div>
            <div className="font-color-secondary text-sm px-3 py-15">
                {previewText}
            </div>
        </div>
    )
    
    // Return the citation with tooltip and click handler
    return (
        <>
            {exportRendering ?
                citationElement
            :
                // <Tooltip content={formatted_citation} width={TOOLTIP_WIDTH}>
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
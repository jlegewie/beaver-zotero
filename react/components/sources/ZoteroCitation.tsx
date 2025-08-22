import React, { useState, useEffect } from 'react';
import Tooltip from '../ui/Tooltip';
import { useAtomValue } from 'jotai';
import { citationDataAtom } from '../../atoms/citations';
import { getPref } from '../../../src/utils/prefs';
import { parseZoteroURI } from '../../utils/zoteroURI';
import { getCitationFromItem, getReferenceFromItem } from '../../utils/sourceUtils';
import { createZoteroURI } from '../../utils/zoteroURI';
import { getCitationPages, getCitationBoundingBoxes, bboxesToZoteroRects } from '../../types/citations';
import { formatNumberRanges } from '../../utils/stringUtils';
import { getCurrentReader } from '../../utils/readerUtils';

const TOOLTIP_WIDTH = '250px';
export const BEAVER_ANNOTATION_TEXT = 'Beaver Citation';

// Track temporary annotations globally to ensure cleanup
let currentTemporaryAnnotations: string[] = [];

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

    // If we have a attachmentCitation, use it
    if (attachmentCitation) {
        formatted_citation = attachmentCitation.formatted_citation || '';
        citation = attachmentCitation.citation || '';
        url = attachmentCitation.url || '';
    // Fallback: get the Zotero item and create the citation data
    } else {
        // Get the Zotero item
        const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
        if (!item) {
            console.log('Failed to format citation for id:', unique_key);
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
    
    // Cleanup function for temporary annotations
    const cleanupTemporaryAnnotations = async () => {
        if (currentTemporaryAnnotations.length === 0) return;
        
        try {
            const reader = getCurrentReader();
            if (reader && reader._internalReader) {
                await reader._internalReader.unsetAnnotations(
                    Components.utils.cloneInto(currentTemporaryAnnotations, reader._iframeWindow)
                );
            }
        } catch (error) {
            console.error('Failed to cleanup temporary annotations:', error);
        }
        
        currentTemporaryAnnotations = [];
    };

    // Create temporary annotations for bounding boxes
    const createBoundingBoxHighlights = async (boundingBoxData: any[], item: Zotero.Item) => {
        if (boundingBoxData.length === 0) return [];
        
        try {
            const reader = getCurrentReader();
            if (!reader || !reader._internalReader) {
                console.warn('No active reader found for creating bounding box highlights');
                return [];
            }

            const annotationIds: string[] = [];
            
            for (const { page, bboxes } of boundingBoxData) {
                const pageIndex = page - 1; // Convert to 0-based index
                const rects = bboxesToZoteroRects(bboxes);
                
                // Create highlight annotation for this page
                const tempHighlight = await reader._internalReader._annotationManager.addAnnotation(
                    Components.utils.cloneInto({
                        type: 'highlight',
                        color: '#00bbff', // blue highlight
                        sortIndex: `${pageIndex.toString().padStart(5, '0')}|000000|00000`,
                        position: {
                            pageIndex: pageIndex,
                            rects: rects
                        },
                        authorName: 'Beaver',
                        text: BEAVER_ANNOTATION_TEXT
                    }, reader._iframeWindow)
                );
                
                if (tempHighlight && tempHighlight.id) {
                    annotationIds.push(tempHighlight.id);
                }
            }
            
            return annotationIds;
        } catch (error) {
            console.error('Failed to create bounding box highlights:', error);
            return [];
        }
    };

    // Enhanced click handler with bounding box support
    const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        
        // Get the item key and library ID from the data attributes or URL
        let itemKey: string | null = (e.target as HTMLElement).dataset.itemKey || null;
        let libraryID: number | null = parseInt((e.target as HTMLElement).dataset.libraryId || '0');
        
        // Fallback: parse the URL if the data attributes are not set
        if (!libraryID || !itemKey) {
            ({ libraryID, itemKey } = parseZoteroURI(url));
        }
        if (!libraryID || !itemKey) return;

        // Get the item
        const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
        if (!item) return;

        // Handle note links
        if (item.isNote()) {
            await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
            return;
        }

        // Handle file links
        if (url.startsWith('file:///')) {
            const filePath = url.replace('file:///', '');
            Zotero.launchFile(filePath);
            return;
        }

        // Cleanup any existing temporary annotations
        await cleanupTemporaryAnnotations();

        // Get bounding box data from citation
        const boundingBoxData = getCitationBoundingBoxes(attachmentCitation);
        const pages = getCitationPages(attachmentCitation);

        try {
            let reader = getCurrentReader();
            
            // Check if we need to open or switch to the correct PDF
            if (!reader || reader.itemID !== item.id) {
                // Open the PDF
                if (boundingBoxData.length > 0) {
                    // Open at the first page with bounding boxes
                    const firstPage = boundingBoxData[0].page;
                    reader = await Zotero.Reader.open(item.id, { pageIndex: firstPage - 1 });
                } else if (pages.length > 0) {
                    // Open at the first cited page
                    reader = await Zotero.Reader.open(item.id, { pageIndex: pages[0] - 1 });
                } else {
                    // Open without specific page
                    reader = await Zotero.Reader.open(item.id);
                }
                
                // Wait for reader to initialize
                if (reader && reader._initPromise) {
                    await reader._initPromise;
                }
            }

            // Handle the three scenarios
            if (boundingBoxData.length > 0) {
                // Scenario 1: With bounding boxes - create temporary highlights
                const annotationIds = await createBoundingBoxHighlights(boundingBoxData, item);
                currentTemporaryAnnotations = annotationIds;
                
                // Navigate to the first annotation if created successfully
                if (annotationIds.length > 0 && reader) {
                    // Small delay to ensure annotation is rendered
                    setTimeout(() => {
                        reader.navigate({annotationID: annotationIds[0]});
                    }, 100);
                }
            } else if (pages.length > 0) {
                // Scenario 2: With pages only - navigate to page
                if (reader) {
                    reader.navigate({ pageIndex: pages[0] - 1 });
                }
            }
            // Scenario 3: No locators - PDF is already open, nothing more needed
            
        } catch (error) {
            console.error('Failed to handle citation click:', error);
            
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
            if (currentTemporaryAnnotations.length > 0) {
                console.log('cleanupTemporaryAnnotations');
                cleanupTemporaryAnnotations().catch(console.error);
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
    
    // Return the citation with tooltip and click handler
    return (
        <>
            {exportRendering ?
                citationElement
            :
                <Tooltip content={formatted_citation} width={TOOLTIP_WIDTH}>
                    {citationElement}
                </Tooltip>
            }
        </>
    );

};

export default ZoteroCitation;
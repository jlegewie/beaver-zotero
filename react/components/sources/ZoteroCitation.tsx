import React, { useEffect, useMemo } from 'react';
import Tooltip from '../ui/Tooltip';
import { useAtomValue } from 'jotai';
import { citationDataMapAtom } from '../../atoms/citations';
import { getPref } from '../../../src/utils/prefs';
import { parseZoteroURI } from '../../utils/zoteroURI';
import { createZoteroURI } from '../../utils/zoteroURI';
import { getCitationPages, getCitationBoundingBoxes, isExternalCitation, isZoteroCitation } from '../../types/citations';
import { formatNumberRanges } from '../../utils/stringUtils';
import { selectItemById } from '../../../src/utils/selectItem';
import { getCurrentReaderAndWaitForView } from '../../utils/readerUtils';
import { BeaverTemporaryAnnotations } from '../../utils/annotationUtils';
import { createBoundingBoxHighlights } from '../../utils/annotationUtils';
import { logger } from '../../../src/utils/logger';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../atoms/externalReferences';
import { useFallbackCitation } from '../../hooks/useFallbackCitation';

const TOOLTIP_WIDTH = '250px';
export const BEAVER_ANNOTATION_TEXT = 'Beaver Citation';

// Define prop types for the component
interface ZoteroCitationProps {
    id?: string;           // Format: "libraryID-itemKey" (and 'user-content-' from sanitization) - for Zotero citations
    cid: string;           // Citation ID
    external_id?: string;  // External source ID for external reference citations
    pages?: string;        // Format: "3-6,19"
    consecutive?: boolean;
    adjacent?: boolean;   // True when consecutive AND only whitespace between citations
    children?: React.ReactNode;
    exportRendering?: boolean;
}

const ZoteroCitation: React.FC<ZoteroCitationProps> = ({ 
    id: unique_key,
    cid: citationId,
    external_id,
    consecutive = false,
    adjacent = false,
    children,
    exportRendering = false
}) => {
    // Get citation data maps
    const citationDataMap = useAtomValue(citationDataMapAtom);
    const externalReferenceToZoteroItem = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferenceMap = useAtomValue(externalReferenceMappingAtom);

    // Parse the id to get libraryID and itemKey (memoized to avoid recalculation)
    const { libraryID, itemKey, cleanKey } = useMemo(() => {
        if (!unique_key) return { libraryID: 1, itemKey: '', cleanKey: '' };
        const cleanKey = unique_key.replace('user-content-', '');
        const [libraryIDString, itemKey] = cleanKey.includes('-') 
            ? cleanKey.split('-') 
            : [cleanKey, cleanKey];
        return { 
            libraryID: parseInt(libraryIDString) || 1, 
            itemKey, 
            cleanKey 
        };
    }, [unique_key]);

    // Get attachment citation data from map
    const citationMetadata = citationId ? citationDataMap[citationId] : undefined;
    
    // Load fallback citation data when citation metadata is not available
    const fallbackCitation = useFallbackCitation({
        cleanKey,
        libraryID,
        itemKey,
        citationMetadataId: citationMetadata?.citation_id
    });

    // Determine if this is an external citation
    const isExternal = citationMetadata ? isExternalCitation(citationMetadata) : !!external_id;

    // For external citations, check if they map to a Zotero item
    // By subscribing to the atom directly, this will automatically re-render when mappings are added
    const mappedZoteroItem = isExternal && citationMetadata && isExternalCitation(citationMetadata)
        ? externalReferenceToZoteroItem[citationMetadata.external_source_id!]
        : undefined;
    
    // Get the citation format preference
    const authorYearFormat = getPref("citationFormat") !== "numeric";

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

    // Memoize derived citation data to avoid recalculation on every render
    const { formatted_citation, citation, url, previewText, pages } = useMemo(() => {
        let formatted_citation = '';
        let citation = '';
        let url = '';
        let previewText = '';

        if (citationMetadata) {
            if (isExternalCitation(citationMetadata)) {
                // External citation - use metadata directly
                citation = citationMetadata.author_year || '';
                formatted_citation = citationMetadata.formatted_citation || citation;
                previewText = citationMetadata.preview
                    ? `"${citationMetadata.preview}"`
                    : formatted_citation;
                
                // If mapped to Zotero item, try to get URL
                if (mappedZoteroItem) {
                    const item = Zotero.Items.getByLibraryAndKey(mappedZoteroItem.library_id, mappedZoteroItem.zotero_key);
                    if (item) {
                        url = createZoteroURI(item);
                    }
                }
            } else if (isZoteroCitation(citationMetadata)) {
                // Zotero citation with metadata
                formatted_citation = citationMetadata.formatted_citation || '';
                citation = citationMetadata.citation || '';
                url = citationMetadata.url || '';
                previewText = citationMetadata.preview
                    ? `"${citationMetadata.preview}"`
                    : formatted_citation || '';
            }
        } else if (fallbackCitation) {
            if (fallbackCitation.loading) {
                // Show loading state
                formatted_citation = '?';
                citation = '?';
                url = '';
                previewText = 'Loading citation data...';
            } else {
                formatted_citation = fallbackCitation.formatted_citation;
                citation = fallbackCitation.citation;
                url = fallbackCitation.url;
                previewText = formatted_citation;
            }
        }
        
        const pages = [...new Set(getCitationPages(citationMetadata))];
        const firstPage = pages.length > 0 ? pages[0] : null;
        const finalUrl = firstPage ? `${url}?page=${firstPage}` : url;

        return { formatted_citation, citation, url: finalUrl, previewText, pages };
    }, [citationMetadata, fallbackCitation]);


    // Zotero citations need an id/cid; external citations intentionally omit the Zotero id
    if ((!unique_key || !citationId) && !isExternal) return null;

    // Hide adjacent fallback citations (identical and immediately next to each other)
    if (adjacent && !citationMetadata) return null;

    // Enhanced click handler with bounding box support
    const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        logger('ZoteroCitation: Handle citation click');
        
        // Check if this is an external citation without a Zotero mapping
        if (isExternal && !mappedZoteroItem) {
            logger('ZoteroCitation: External citation without Zotero mapping - no action');
            return;
        }
        
        // Cleanup any existing temporary annotations
        await BeaverTemporaryAnnotations.cleanupAll();
        
        // Get the item key and library ID from the data attributes or URL
        let currentItemKey: string | null = (e.target as HTMLElement).dataset.itemKey || null;
        let currentLibraryID: number | null = parseInt((e.target as HTMLElement).dataset.libraryId || '0');
        
        // Fallback: use the component's libraryID and itemKey
        if (!currentLibraryID || !currentItemKey) {
            if (libraryID && itemKey) {
                currentLibraryID = libraryID;
                currentItemKey = itemKey;
            } else if (url) {
                // Parse the URL if the data attributes are not set
                ({ libraryID: currentLibraryID, itemKey: currentItemKey } = parseZoteroURI(url));
            }
        }
        
        if (!currentLibraryID || !currentItemKey) return;

        // Get the item
        // TODO: Use currentItemKey or itemKey???
        logger(`ZoteroCitation: Zotero Item (${currentLibraryID}, ${currentItemKey})`);
        const item = await Zotero.Items.getByLibraryAndKeyAsync(currentLibraryID, currentItemKey);
        // logger(`ZoteroCitation: Zotero Item (${libraryID}, ${itemKey})`);
        // const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);

        if (!item) {
            logger(`ZoteroCitation: Failed to get Zotero item (${currentLibraryID}, ${currentItemKey})`);
            return;
        }

        // Handle note links
        if (item.isNote()) {
            logger(`ZoteroCitation: Note Link (${item.id})`);
            await Zotero.getActiveZoteroPane().openNoteWindow(item.id);
            return;
        }

        // Handle regular items
        if (item.isRegularItem()) {
            logger(`ZoteroCitation: Selecting regular item (${item.id})`);
            await selectItemById(item.id);
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
        const boundingBoxData = getCitationBoundingBoxes(citationMetadata);
        const pages = getCitationPages(citationMetadata);
        logger(`ZoteroCitation: Citation Location (boundingBoxData.length: ${boundingBoxData.length}, pages.length: ${pages.length})`);

        // Handle regular items
        if (item.isAttachment() && boundingBoxData.length == 0 && pages.length == 0) {
            logger(`ZoteroCitation: Selecting attachment (${item.id})`);
            await selectItemById(item.id);
            return;
        }

        try {
            let reader = await getCurrentReaderAndWaitForView();
            logger(`ZoteroCitation: Current Reader (${reader?.itemID})`);
            
            // Check if we need to open or switch to the correct PDF
            if (!reader || reader.itemID !== item.id) {
                logger(`ZoteroCitation: Opening PDF in reader or switching to the correct PDF`);

                // Determine the page to open
                let pageIndex = 1;
                if (boundingBoxData.length > 0) {
                    pageIndex = boundingBoxData[0].page;
                } else if (pages.length > 0) {
                    pageIndex = pages[0];
                }

                // Open the PDF at page
                logger(`ZoteroCitation: Opening item ${item.id} at page ${pageIndex}`);
                reader = await Zotero.Reader.open(item.id, { pageIndex: pageIndex - 1 });

                // Wait for reader to initialize (should already be done by getCurrentReaderAndWaitForView)
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            // Handle the three scenarios
            if (boundingBoxData.length > 0) {
                logger(`ZoteroCitation: Highlighting bounding boxes`);
                // Scenario 1: With bounding boxes - create temporary highlights
                const annotationReferences = await createBoundingBoxHighlights(boundingBoxData, previewText, BEAVER_ANNOTATION_TEXT);
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
                Zotero.getMainWindow().location.href = url;
            }
        }
    };

    // Format for display
    let displayText = '';
    if (authorYearFormat) {
        displayText = consecutive
            ? (pages.length > 0 ? `p.${formatNumberRanges(pages)}` : 'Ibid')
            : (pages.length > 0 ? `${citation}, p.${formatNumberRanges(pages)}` : citation);
    } else {
        displayText = citationMetadata?.numericCitation || citation;
    }

    // Rendering for export to Zotero note (using CSL JSON for citations)
    if (exportRendering) {
        displayText = authorYearFormat ? ` (${displayText})` : ` [${displayText}]`;

        // External citations cannot be exported as proper Zotero citations
        if (isExternal && !mappedZoteroItem) {
            if (citationMetadata?.external_source_id) {
                const externalReference = externalReferenceMap[citationMetadata.external_source_id];
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
        
        const libraryIDToUse = libraryID || mappedZoteroItem?.library_id;
        const itemKeyToUse = itemKey || mappedZoteroItem?.zotero_key;

        // For Zotero citations, use proper CSL format
        if (!libraryIDToUse || !itemKeyToUse) return null;
        const item = Zotero.Items.getByLibraryAndKey(libraryIDToUse, itemKeyToUse);
        if (!item) return null;
        const itemData = Zotero.Utilities.Item.itemToCSLJSON(item.parentItem || item);
        const startPage = Array.isArray(pages) ? pages[0] : pages; 
        const navLocator = startPage ? String(startPage) : undefined;
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
        return (
            <span
                className="citation" 
                data-citation={encodeURIComponent(JSON.stringify(citationObj))}
            >
                {formatted}
            </span>
        );
    }

    // Determine the CSS class based on citation type
    const citationClass = isExternal && !mappedZoteroItem
        ? "zotero-citation external-citation"
        : "zotero-citation";

    const citationElement = (
        <span 
            onClick={handleClick} 
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
            <span className="px-3 py-15 display-flex flex-row border-bottom-quinary">
                <span className="font-color-primary text-sm" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                    {citation}
                </span>
                <span className="flex-1" />
                {pages && pages.length > 0 && pages[0] && (
                    <span className="font-color-secondary text-sm">Page {pages[0]}</span>
                )}
            </span>
            <span className="font-color-secondary text-sm px-3 py-15 block" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                {previewText}
            </span>
            {isExternal && !mappedZoteroItem && (
                <span className="px-3 py-15 text-xs font-color-tertiary border-top-quinary block">
                    External reference
                </span>
            )}
        </span>
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

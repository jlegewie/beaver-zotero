import React, { useState, useEffect, useMemo } from 'react';
import Tooltip from '../ui/Tooltip';
import { useAtomValue, useSetAtom } from 'jotai';
import { citationDataMapAtom, fallbackCitationCacheAtom } from '../../atoms/citations';
import { getPref } from '../../../src/utils/prefs';
import { parseZoteroURI } from '../../utils/zoteroURI';
import { getDisplayNameFromItem, getReferenceFromItem } from '../../utils/sourceUtils';
import { createZoteroURI } from '../../utils/zoteroURI';
import { getCitationPages, getCitationBoundingBoxes, toZoteroRectFromBBox, isExternalCitation, isZoteroCitation } from '../../types/citations';
import { formatNumberRanges } from '../../utils/stringUtils';
import { selectItemById } from '../../../src/utils/selectItem';
import { getCurrentReaderAndWaitForView } from '../../utils/readerUtils';
import { getPageViewportInfo, applyRotationToBoundingBox } from '../../utils/pdfUtils';
import { BeaverTemporaryAnnotations } from '../../utils/annotationUtils';
import { ZoteroItemReference } from '../../types/zotero';
import { logger } from '../../../src/utils/logger';
import { loadFullItemDataWithAllTypes } from '../../../src/utils/zoteroUtils';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../atoms/externalReferences';

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
    // const citationDataMap = {};
    const externalReferenceToZoteroItem = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferenceMap = useAtomValue(externalReferenceMappingAtom);

    // Fallback citation cache (persists across component mounts via Jotai)
    const fallbackCache = useAtomValue(fallbackCitationCacheAtom);
    const setFallbackCache = useSetAtom(fallbackCitationCacheAtom);
    
    // Fallback citation data (when citation metadata is not available)
    // We track the key to prevent showing stale data when reusing the component
    const [fallbackDataState, setFallbackDataState] = useState<{
        key: string;
        data: {
            formatted_citation: string;
            citation: string;
            url: string;
            loading: boolean;
        } | null;
    }>({ key: '', data: null });

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

    // Derived fallback citation that is valid only for the current key
    // Check atom cache first (sync) to avoid flicker on remount
    const fallbackCitation = useMemo(() => {
        if (fallbackDataState.key === cleanKey && fallbackDataState.data) {
            return fallbackDataState.data;
        }
        // Check Jotai atom cache for instant access on remount
        const cached = fallbackCache[cleanKey];
        if (cached) {
            return { ...cached, loading: false };
        }
        return null;
    }, [fallbackDataState, cleanKey, fallbackCache]);

    // Get attachment citation data from map
    const citationMetadata = citationId ? citationDataMap[citationId] : undefined;

    // Determine if this is an external citation
    const isExternal = citationMetadata ? isExternalCitation(citationMetadata) : !!external_id;

    // For external citations, check if they map to a Zotero item
    // By subscribing to the atom directly, this will automatically re-render when mappings are added
    const mappedZoteroItem = isExternal && citationMetadata && isExternalCitation(citationMetadata)
        ? externalReferenceToZoteroItem[citationMetadata.external_source_id!]
        : undefined;
    
    // Get the citation format preference
    const authorYearFormat = getPref("citationFormat") !== "numeric";

    // if (!citationId) return null;
            
    // // Parse the id to get libraryID and itemKey (for Zotero citations)
    // let libraryID: number | undefined;
    // let itemKey: string | undefined;
    
    // if (unique_key) {
    //     const cleanKey = unique_key.replace('user-content-', '');
    //     const [libraryIDString, key] = cleanKey.includes('-') ? cleanKey.split('-') : [cleanKey, cleanKey];
    //     libraryID = parseInt(libraryIDString) || 1;
    //     itemKey = key;
    // } else if (citationMetadata && isZoteroCitation(citationMetadata)) {
    //     libraryID = citationMetadata.library_id;
    //     itemKey = citationMetadata.zotero_key;
    // } else if (mappedZoteroItem) {
    //     // Use the mapped Zotero item for external citations
    //     libraryID = mappedZoteroItem.library_id;
    //     itemKey = mappedZoteroItem.zotero_key;
    // }

    // // Fallback citation data (when citation metadata is not available)
    // const [fallbackCitation, setFallbackCitation] = useState<{
    //     formatted_citation: string;
    //     citation: string;
    //     url: string;
    //     loading: boolean;
    // } | null>(null);

    // Load fallback citation data when citation metadata is not available
    const citationMetadataId = citationMetadata?.citation_id;
    useEffect(() => {
        // Skip if we have citationMetadata or already have fallback (from atom cache or local state)
        if (citationMetadataId || fallbackCitation || !itemKey) return;
        
        let cancelled = false;
        
        const loadFallbackCitation = async () => {
            setFallbackDataState({ 
                key: cleanKey,
                data: { formatted_citation: '', citation: '', url: '', loading: true }
            });
            
            try {
                const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);
                if (cancelled) return;
                
                if (!item) {
                    logger('ZoteroCitation: Failed to format citation for id: ' + cleanKey);
                    setFallbackDataState({ key: cleanKey, data: null });
                    return;
                }

                await loadFullItemDataWithAllTypes([item]);
                if (cancelled) return;

                const parentItem = item.parentItem;
                const itemToCite = item.isNote() ? item : parentItem || item;
                
                const citation = getDisplayNameFromItem(itemToCite);
                const formatted_citation = getReferenceFromItem(itemToCite);
                const url = createZoteroURI(item);

                // Cache the result in Jotai atom for future mounts
                setFallbackCache(prev => ({ ...prev, [cleanKey]: { formatted_citation, citation, url } }));

                setFallbackDataState({
                    key: cleanKey,
                    data: {
                        formatted_citation,
                        citation,
                        url,
                        loading: false
                    }
                });
            } catch (error) {
                if (cancelled) return;
                logger('ZoteroCitation: Error loading fallback citation: ' + error);
                setFallbackDataState({ key: cleanKey, data: null });
            }
        };

        loadFallbackCitation();

        // Cleanup to prevent setting state after unmount
        return () => { cancelled = true; };
    // Note: fallbackCitation intentionally excluded from deps
    // because we only want to load once when it's initially null
    }, [citationMetadataId, libraryID, itemKey, cleanKey, setFallbackCache]);

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
                formatted_citation = citationMetadata.preview || citation;
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
    
        // Create temporary annotations for bounding boxes
    const createBoundingBoxHighlights = async (boundingBoxData: any[], item: Zotero.Item) => {
        if (boundingBoxData.length === 0) return [];
        
        try {
            const reader = await getCurrentReaderAndWaitForView();
            if (!reader || !reader._internalReader) {
                logger('ZoteroCitation: No active reader found for creating bounding box highlights');
                return [];
            }

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

                // Get viewport info directly from PDF document (no need for rendered page)
                const { viewBox, rotation, width, height } = await getPageViewportInfo(reader, pageIndex);
                const viewBoxLL: [number, number] = [viewBox[0], viewBox[1]];
                
                // Combine all bboxes on this page and apply rotation transformation only if rotated
                const combinedBboxes = allBboxesOnPage.flat();
                const rects = rotation !== 0
                    ? combinedBboxes
                        .map(b => applyRotationToBoundingBox(b, rotation, width, height))
                        .map(b => toZoteroRectFromBBox(b, viewBoxLL))
                    : combinedBboxes.map(b => toZoteroRectFromBBox(b, viewBoxLL));
                
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
                    text: previewText,
                    authorName: 'Beaver',
                    pageLabel: page.toString(),
                    isExternal: false,
                    readOnly: false,
                    lastModifiedByUser: '',
                    dateModified: new Date().toISOString(),
                    
                    // Backup annotation properties
                    annotationType: 'highlight',
                    annotationAuthorName: 'Beaver',
                    annotationText: `${BEAVER_ANNOTATION_TEXT}`,
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

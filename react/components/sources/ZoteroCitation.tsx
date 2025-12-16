import React, { useEffect, useMemo } from 'react';
import Tooltip from '../ui/Tooltip';
import { useAtomValue } from 'jotai';
import { citationDataByCitationKeyAtom } from '../../atoms/citations';
import { getPref } from '../../../src/utils/prefs';
import { createZoteroURI } from '../../utils/zoteroURI';
import { 
    getCitationPages, 
    getCitationBoundingBoxes, 
    isExternalCitation, 
    isZoteroCitation, 
    parseItemReference 
} from '../../types/citations';
import { formatNumberRanges } from '../../utils/stringUtils';
import { selectItemById } from '../../../src/utils/selectItem';
import { getCurrentReaderAndWaitForView } from '../../utils/readerUtils';
import { BeaverTemporaryAnnotations } from '../../utils/annotationUtils';
import { createBoundingBoxHighlights } from '../../utils/annotationUtils';
import { logger } from '../../../src/utils/logger';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../atoms/externalReferences';
import { useCitationMarker } from '../../hooks/useCitationMarker';

const TOOLTIP_WIDTH = '250px';
export const BEAVER_ANNOTATION_TEXT = 'Beaver Citation';

/**
 * Citation display state - explicit FSM for citation lifecycle.
 * 
 * States:
 * - 'streaming': Tag parsed, waiting for metadata (shows "?")
 * - 'ready': Metadata available, fully rendered
 * - 'invalid': Citation could not be resolved (shows "?" with error tooltip)
 * - 'error': No identifier found (returns null)
 */
type CitationDisplayState = 'streaming' | 'ready' | 'invalid' | 'error';

/**
 * Props for ZoteroCitation component.
 * 
 * Supported citation tag formats from LLM:
 *   <citation item_id="libraryID-itemKey"/>      - parent item reference
 *   <citation att_id="libraryID-itemKey"/>       - attachment reference
 *   <citation att_id="..." sid="..."/>           - attachment with sentence ID
 *   <citation external_id="..."/>                - external reference
 * 
 * Note: Props are passed from HTML attributes after sanitization,
 * so values may have 'user-content-' prefix added by rehype-sanitize.
 */
interface ZoteroCitationProps {
    // Primary identifiers (mutually exclusive, one should be present)
    item_id?: string;      // Format: "libraryID-itemKey" - parent item reference
    att_id?: string;       // Format: "libraryID-itemKey" - attachment reference
    external_id?: string;  // External source ID for external references
    
    // Optional modifiers
    sid?: string;          // Sentence ID for location within attachment
    
    // Citation key for metadata lookup (injected by preprocessCitations)
    // Format: "zotero:{library_id}-{zotero_key}" or "external:{external_source_id}"
    citation_key?: string;
    
    // Display modifiers (set by preprocessCitations)
    consecutive?: boolean; // True when same item cited multiple times in sequence
    adjacent?: boolean;    // True when consecutive AND only whitespace between
    
    // Rendering options
    exportRendering?: boolean;
    children?: React.ReactNode;
}

const ZoteroCitation: React.FC<ZoteroCitationProps> = ({ 
    item_id,
    att_id,
    external_id,
    citation_key: citationKeyProp,
    consecutive = false,
    adjacent = false,
    exportRendering = false
}) => {
    // Get citation data maps
    const citationDataByCitationKey = useAtomValue(citationDataByCitationKeyAtom);
    const externalReferenceToZoteroItem = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferenceMap = useAtomValue(externalReferenceMappingAtom);

    // =========================================================================
    // IDENTITY RESOLUTION - Simplified using citation_key
    // =========================================================================
    // 
    // citation_key is injected by preprocessCitations and serves as the
    // single source of truth for both metadata lookup and marker assignment.
    //
    const identity = useMemo(() => {
        // citation_key is the canonical identifier (e.g., "zotero:1-ABC123" or "external:xyz")
        const citationKey = citationKeyProp || '';
        
        // Look up citation metadata via citation_key
        let metadata = citationKey 
            ? citationDataByCitationKey[citationKey] 
            : undefined;
        
        // Fallback lookup for invalid citations with unparseable identifiers
        // These are stored under "invalid:{raw_id_value}" in citationDataByCitationKeyAtom
        if (!metadata) {
            const rawIdValue = (att_id || item_id || external_id || '').replace('user-content-', '');
            if (rawIdValue) {
                const fallbackKey = `invalid:${rawIdValue}`;
                metadata = citationDataByCitationKey[fallbackKey];
            }
        }
        
        // Debug logging for citation matching (level 5 = verbose/trace)
        if (citationKey && !metadata) {
            logger(`ZoteroCitation: No metadata for key "${citationKey}" (available: ${Object.keys(citationDataByCitationKey).length} keys)`, 5);
        } else if (!citationKey) {
            logger(`ZoteroCitation: No citation_key (att_id=${att_id}, item_id=${item_id}, external_id=${external_id})`, 5);
        }
        
        // Parse Zotero reference from props (att_id takes priority)
        // Used for click handling and display even before metadata arrives
        const zoteroRef = parseItemReference(att_id) || parseItemReference(item_id);
        
        // Determine citation type
        const isExternal = metadata 
            ? isExternalCitation(metadata) 
            : (!!external_id && !zoteroRef) || citationKey.startsWith('external:');
        
        // Determine display state (FSM)
        const hasIdentifier = !!(citationKey || zoteroRef || external_id);
        let displayState: CitationDisplayState;
        if (!hasIdentifier) {
            displayState = 'error';
        } else if (!metadata) {
            displayState = 'streaming';
        } else if (metadata.invalid) {
            displayState = 'invalid';
        } else {
            displayState = 'ready';
        }
        
        return {
            metadata,
            zoteroRef,
            isExternal,
            citationKey,
            displayState,
            // Convenience accessors
            libraryID: zoteroRef?.libraryID ?? metadata?.library_id ?? 0,
            itemKey: zoteroRef?.itemKey ?? metadata?.zotero_key ?? '',
            hasIdentifier
        };
    }, [citationKeyProp, citationDataByCitationKey, att_id, item_id, external_id]);

    // Destructure for easier access
    const { 
        metadata: citationMetadata, 
        isExternal, 
        citationKey,
        displayState,
        libraryID,
        itemKey
    } = identity;

    // For external citations, check if they map to a Zotero item
    const mappedZoteroItem = isExternal && citationMetadata && isExternalCitation(citationMetadata)
        ? externalReferenceToZoteroItem[citationMetadata.external_source_id!]
        : undefined;
    
    // Get the citation format preference
    const authorYearFormat = getPref("citationFormat") !== "numeric";

    // Use display state for rendering decisions
    const isStreaming = displayState === 'streaming';
    const isInvalid = displayState === 'invalid';

    // Get or assign numeric marker using the thread-scoped atom (resets when thread changes)
    const numericMarker = useCitationMarker(citationKey);

    // Cleanup effect for when component unmounts or citation changes
    useEffect(() => {
        return () => {
            // Cleanup temporary annotations when component unmounts
            if (BeaverTemporaryAnnotations.getCount() > 0) {
                logger('ZoteroCitation: cleanupTemporaryAnnotations');
                BeaverTemporaryAnnotations.cleanupAll().catch(logger);
            }
        };
    }, [citationKey]);

    // Derive citation display data from metadata
    // When metadata is not available (streaming), values are empty and component shows inactive "?"
    const { formatted_citation, citation, url, previewText, pages } = useMemo(() => {
        // No metadata yet - return empty values (component will show inactive state)
        if (!citationMetadata) {
            return { formatted_citation: '', citation: '', url: '', previewText: '', pages: [] };
        }

        let formatted_citation = '';
        let citation = '';
        let url = '';
        let previewText = '';

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
        
        const pages = [...new Set(getCitationPages(citationMetadata))];
        const firstPage = pages.length > 0 ? pages[0] : null;
        const finalUrl = firstPage ? `${url}?page=${firstPage}` : url;

        return { formatted_citation, citation, url: finalUrl, previewText, pages };
    }, [citationMetadata, mappedZoteroItem]);


    // Render as soon as we have an identifier; citationMetadata may arrive later.
    // 'error' state means no valid identifier was found - don't render.
    if (displayState === 'error') return null;

    // Click handler for navigating to the cited item/location
    const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        logger('ZoteroCitation: Handle citation click');

        if (isStreaming) {
            logger('ZoteroCitation: Citation metadata not available yet - streaming');
            return;
        }
        
        if (isInvalid) {
            logger('ZoteroCitation: Citation is invalid - cannot navigate');
            return;
        }
        
        // External citations without Zotero mapping are not clickable
        if (isExternal && !mappedZoteroItem) {
            logger('ZoteroCitation: External citation without Zotero mapping - no action');
            return;
        }
        
        // Cleanup any existing temporary annotations
        await BeaverTemporaryAnnotations.cleanupAll();
        
        // Use the already-computed identity (no need to re-parse from DOM)
        if (!libraryID || !itemKey) {
            logger('ZoteroCitation: No valid item reference');
            return;
        }

        logger(`ZoteroCitation: Zotero Item (${libraryID}, ${itemKey})`);
        const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, itemKey);

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
        if (isStreaming || isInvalid) {
            // We don't know the author/year string yet, or citation is invalid. Render a subtle placeholder.
            displayText = '?';
        } else {
            displayText = consecutive
                ? (pages.length > 0 ? `p.${formatNumberRanges(pages)}` : 'Ibid')
                : (pages.length > 0 ? `${citation}, p.${formatNumberRanges(pages)}` : citation);
        }
    } else {
        // Numeric markers should be stable and independent of citationMetadata.
        // If key is missing (invalid/malformed citation) or invalid, show placeholder.
        displayText = (citationKey && !isInvalid) ? numericMarker : '?';
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

    // Determine the CSS class based on citation type and state
    const citationClassBase = isExternal && !mappedZoteroItem
        ? "zotero-citation external-citation"
        : "zotero-citation";
    const citationClass = isStreaming
        ? `${citationClassBase} streaming`
        : isInvalid
        ? `${citationClassBase} invalid`
        : citationClassBase;

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
                        content="Citation could not be resolved"
                        width={TOOLTIP_WIDTH}
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

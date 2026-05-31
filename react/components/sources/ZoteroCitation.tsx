import React, { useMemo } from 'react';
import Tooltip from '../ui/Tooltip';
import { useAtomValue, useSetAtom } from 'jotai';
import { citationDataByCitationKeyAtom, pageLabelsByAttachmentIdAtom, type PageLabelsByAttachmentId } from '../../atoms/citations';
import { getPref } from '../../../src/utils/prefs';
import { createZoteroURI } from '../../utils/zoteroURI';
import {
    getCitationPages,
    getCitationBoundingBoxes,
    isExternalCitation,
    isZoteroCitation,
} from '../../types/citations';
import { formatNumberRanges, formatPageRangesWithLabels } from '../../utils/stringUtils';
import { selectItemById } from '../../../src/utils/selectItem';
import { getCurrentReaderAndWaitForView } from '../../utils/readerUtils';
import {
    BeaverTemporaryAnnotations,
    createBoundingBoxHighlights,
    installTemporaryAnnotationDismissOnNextClick,
} from '../../utils/annotationUtils';
import { logger } from '../../../src/utils/logger';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../../atoms/externalReferences';
import { useCitationMarker } from '../../hooks/useCitationMarker';
import { ZoteroItemReference } from '../../types/zotero';
import { revealSource } from '../../utils/sourceUtils';
import { resolvePageLabelFromLabels, translatePageNumberToLabelFromLabels } from '../../utils/pageLabels';
import { getBestPDFAttachment, getBestPDFAttachmentAsync } from '../../../src/utils/zoteroItemHelpers';
import {
    baseCitationKey,
    CitationRef,
    getPageLocator,
    getResolvedRef,
    LocatorKind,
    requestedCitationKey,
} from '../../utils/citationGrammar';
import {
    isExternalReferenceDetailsDialogVisibleAtom,
    selectedExternalReferenceAtom
} from '../../atoms/ui';
import { Icon, LibraryIcon, PdfIcon, GlobalSearchIcon, NoteIcon, HighlighterIcon } from '../icons/icons';
import { BEAVER_CITATION_ANNOTATION_AUTHOR } from '../../../src/constants/annotations';

const TOOLTIP_WIDTH = '250px';
export const BEAVER_ANNOTATION_TEXT = BEAVER_CITATION_ANNOTATION_AUTHOR;

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

type CitationPropsModel =
    | { ok: true; ref: CitationRef; requestedKey: string; consecutive: boolean; adjacent: boolean }
    | { ok: false; requestedKey: string; rawIdentity?: string; reason?: string; consecutive: boolean; adjacent: boolean };

function propValue(props: Record<string, unknown>, camel: string, kebab: string): string | undefined {
    const value = props[camel] ?? props[kebab];
    if (value == null || value === false) return undefined;
    return String(value);
}

function propBool(props: Record<string, unknown>, camel: string, kebab: string): boolean {
    const value = props[camel] ?? props[kebab];
    return value === true || value === 'true';
}

export function readCitationProps(props: Record<string, unknown>): CitationPropsModel {
    const consecutive = propBool(props, 'dataConsecutive', 'data-consecutive');
    const adjacent = propBool(props, 'dataAdjacent', 'data-adjacent');
    const requestedKey = propValue(props, 'dataRequestedCitationKey', 'data-requested-citation-key') || '';
    const rawIdentity = propValue(props, 'dataRawIdentity', 'data-raw-identity');
    const invalidReason = propValue(props, 'dataInvalidReason', 'data-invalid-reason');
    if (invalidReason) {
        return { ok: false, requestedKey, rawIdentity, reason: invalidReason, consecutive, adjacent };
    }

    const libraryIDRaw = propValue(props, 'dataLibraryId', 'data-library-id');
    const zoteroKey = propValue(props, 'dataZoteroKey', 'data-zotero-key');
    const externalId = propValue(props, 'dataExternalId', 'data-external-id');
    const externalSource = propValue(props, 'dataExternalSource', 'data-external-source');
    const locRaw = propValue(props, 'dataLoc', 'data-loc');
    const locKind = propValue(props, 'dataLocKind', 'data-loc-kind');
    const locValue = propValue(props, 'dataLocValue', 'data-loc-value');
    const loc = locRaw
        ? { kind: (locKind || 'unknown') as LocatorKind, value: locValue || locRaw, raw: locRaw }
        : undefined;

    if (libraryIDRaw && zoteroKey) {
        const libraryID = Number(libraryIDRaw);
        if (Number.isInteger(libraryID) && libraryID > 0) {
            const ref: CitationRef = { kind: 'zotero', library_id: libraryID, zotero_key: zoteroKey, ...(loc ? { loc } : {}) };
            return { ok: true, ref, requestedKey: requestedKey || requestedCitationKey(ref), consecutive, adjacent };
        }
    }
    if (externalId) {
        const ref: CitationRef = {
            kind: 'external',
            external_id: externalId,
            ...(externalSource ? { source: externalSource } : {}),
            ...(loc ? { loc } : {}),
        };
        return { ok: true, ref, requestedKey: requestedKey || requestedCitationKey(ref), consecutive, adjacent };
    }

    return { ok: false, requestedKey, rawIdentity, reason: invalidReason || 'missing_identity', consecutive, adjacent };
}

function getPageLabelsForItem(
    item: Zotero.Item,
    labelsByAttachmentId: PageLabelsByAttachmentId,
): Record<number, string> | null {
    const attachment = item.isAttachment()
        ? item
        : getBestPDFAttachment(item);
    if (!attachment) return null;
    return labelsByAttachmentId[attachment.id] ?? null;
}

const ZoteroCitation: React.FC<ZoteroCitationProps> = (props) => {
    const { exportRendering = false } = props;
    const parsedProps = useMemo(() => readCitationProps(props as Record<string, unknown>), [props]);
    const { consecutive } = parsedProps;
    // Get citation data maps
    const citationDataByCitationKey = useAtomValue(citationDataByCitationKeyAtom);
    const externalReferenceToZoteroItem = useAtomValue(externalReferenceItemMappingAtom);
    const externalReferenceMap = useAtomValue(externalReferenceMappingAtom);
    const labelsByAttachmentId = useAtomValue(pageLabelsByAttachmentIdAtom);
    
    // For opening external reference details dialog
    const setIsDetailsVisible = useSetAtom(isExternalReferenceDetailsDialogVisibleAtom);
    const setSelectedReference = useSetAtom(selectedExternalReferenceAtom);

    // =========================================================================
    // IDENTITY RESOLUTION - Using normalized citation keys for lookup and markers
    // =========================================================================
    // 
    // data-requested-citation-key is injected by preprocessCitations for metadata lookup.
    // It includes sid/page for unique identification of citation instances.
    // 
    // For marker assignment, we use a base key (item-only) so that all citations
    // to the same item get the same marker number.
    //
    const identity = useMemo(() => {
        const citationKey = parsedProps.requestedKey || '';
        
        let metadata = citationKey 
            ? citationDataByCitationKey[citationKey] 
            : undefined;

        if (!metadata && parsedProps.ok) {
            metadata = citationDataByCitationKey[baseCitationKey(parsedProps.ref)];
        }

        if (!metadata) {
            const rawIdentity = parsedProps.ok ? undefined : parsedProps.rawIdentity;
            if (rawIdentity) {
                metadata = citationDataByCitationKey[`invalid:${rawIdentity}`];
            }
        }

        let markerKey = parsedProps.ok ? baseCitationKey(parsedProps.ref) : '';
        const resolvedRef = metadata ? getResolvedRef(metadata) : null;
        if (resolvedRef) {
            markerKey = baseCitationKey(resolvedRef);
        }

        const displayRef = resolvedRef ?? (parsedProps.ok ? parsedProps.ref : null);
        const zoteroRef = displayRef?.kind === 'zotero'
            ? { libraryID: displayRef.library_id, itemKey: displayRef.zotero_key }
            : null;
        const externalSourceId = displayRef?.kind === 'external'
            ? displayRef.external_id
            : metadata?.external_source_id;
        
        // Determine citation type
        const isExternal = metadata 
            ? isExternalCitation(metadata) 
            : displayRef?.kind === 'external' || citationKey.startsWith('external:');
        
        // Determine display state (FSM)
        const hasIdentifier = parsedProps.ok || !!citationKey || (!parsedProps.ok && !!parsedProps.rawIdentity);
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
            citationKey,     // Full key for metadata lookup
            markerKey,       // Base key for marker assignment
            displayState,
            // Convenience accessors
            libraryID: zoteroRef?.libraryID ?? metadata?.library_id ?? 0,
            itemKey: zoteroRef?.itemKey ?? metadata?.zotero_key ?? '',
            hasIdentifier,
            requestedRef: parsedProps.ok ? parsedProps.ref : null,
            resolvedRef,
            externalSourceId,
        };
    }, [parsedProps, citationDataByCitationKey]);

    // Destructure for easier access
    const { 
        metadata: citationMetadata, 
        isExternal, 
        citationKey,
        markerKey,
        displayState,
        libraryID,
        itemKey,
        requestedRef,
        resolvedRef,
        externalSourceId
    } = identity;

    // For external citations, check if they map to a Zotero item
    const mappedZoteroItem = isExternal && externalSourceId
        ? externalReferenceToZoteroItem[externalSourceId]
        : undefined;
    
    // Compute effective libraryID and itemKey (accounting for mapped external citations)
    const effectiveLibraryID = libraryID || mappedZoteroItem?.library_id || 0;
    const effectiveItemKey = itemKey || mappedZoteroItem?.zotero_key || '';
    
    // Get the citation format preference
    const authorYearFormat = getPref("citationFormat") !== "numeric";
    // Whether page locators should be rendered using the PDF's page labels
    // (e.g., Roman numerals for front matter) instead of raw page numbers.
    const usePageLabels = getPref("usePageLabels") !== false;

    // Use display state for rendering decisions
    const isStreaming = displayState === 'streaming';
    const isInvalid = displayState === 'invalid';

    // Get or assign numeric marker using base key (same item = same marker)
    // Uses markerKey (without sid/page) so all citations to the same item share a marker
    const numericMarker = useCitationMarker(markerKey, exportRendering);

    // Derive citation display data from metadata
    // When metadata is not available (streaming), values are empty and component shows inactive "?"
    const { formatted_citation, citation, url, previewText, rawPages } = useMemo(() => {
        // No metadata yet - return empty values (component will show inactive state)
        if (!citationMetadata) {
            return {
                formatted_citation: '',
                citation: '',
                url: '',
                previewText: '',
                rawPages: [] as number[]
            };
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
                try {
                    const item = Zotero.Items.getByLibraryAndKey(mappedZoteroItem.library_id, mappedZoteroItem.zotero_key);
                    if (item) {
                        url = createZoteroURI(item);
                    }
                } catch (e) {
                    logger(`ZoteroCitation: Item not loaded for ${mappedZoteroItem.library_id}/${mappedZoteroItem.zotero_key}: ${e}`);
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

        // Strip URLs from formatted citation and preview text (they clutter the tooltip)
        const stripUrls = (s: string) => s.replace(/\s*https?:\/\/\S+/g, '').trim();
        // Convert <br> tags to newlines and strip any remaining HTML tags
        // (note previews arrive as HTML fragments and would otherwise render as literal markup)
        const stripHtml = (s: string) => s
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        formatted_citation = stripHtml(stripUrls(formatted_citation));
        previewText = stripHtml(stripUrls(previewText));

        const pages = [...new Set(getCitationPages(citationMetadata))];
        const firstPage = pages.length > 0 ? pages[0] : null;
        const finalUrl = firstPage ? `${url}?page=${firstPage}` : url;

        return {
            formatted_citation,
            citation,
            url: finalUrl,
            previewText,
            rawPages: pages
        };
    }, [citationMetadata, mappedZoteroItem]);

    // Resolve page labels separately so page-label preload updates don't force
    // the citation/preview/HTML-stripping work above to recompute.
    const isZoteroCitationMetadata = !!citationMetadata && isZoteroCitation(citationMetadata);
    const citationLibraryId = resolvedRef?.kind === 'zotero'
        ? resolvedRef.library_id
        : (isZoteroCitationMetadata ? citationMetadata!.library_id : undefined);
    const citationZoteroKey = resolvedRef?.kind === 'zotero'
        ? resolvedRef.zotero_key
        : (isZoteroCitationMetadata ? citationMetadata!.zotero_key : undefined);
    const { pageLabels, pagesDisplay, pages } = useMemo(() => {
        // Default labels: raw page numbers as strings.
        let pageLabels: string[] = rawPages.map((p) => String(p));

        if (usePageLabels && rawPages.length > 0) {
            const backendLabels = citationMetadata?.page_labels;
            if (backendLabels && Object.keys(backendLabels).length > 0) {
                pageLabels = rawPages.map((p) => resolvePageLabelFromLabels(backendLabels, p));
            } else if (citationLibraryId && citationZoteroKey) {
                try {
                    const item = Zotero.Items.getByLibraryAndKey(citationLibraryId, citationZoteroKey);
                    if (item && typeof item !== 'boolean') {
                        const loadedLabels = getPageLabelsForItem(item, labelsByAttachmentId);
                        pageLabels = rawPages.map((p) => resolvePageLabelFromLabels(loadedLabels, p));
                    }
                } catch (e) {
                    logger(`ZoteroCitation: Page label resolution failed: ${e}`);
                }
            }
        }

        const pagesDisplay = rawPages.length === 0
            ? ''
            : usePageLabels
                ? formatPageRangesWithLabels(rawPages, pageLabels)
                : formatNumberRanges(rawPages);

        return { pageLabels, pagesDisplay, pages: rawPages };
    }, [rawPages, usePageLabels, citationLibraryId, citationZoteroKey, labelsByAttachmentId, citationMetadata]);


    // Render as soon as we have an identifier; citationMetadata may arrive later.
    // 'error' state means no valid identifier was found - don't render.
    if (displayState === 'error') return null;

    // Click handler for navigating to the cited item/location
    const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        const ownerDocument = e.currentTarget.ownerDocument;
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
                    revealSource({ library_id: item.libraryID, zotero_key: item.key } as ZoteroItemReference);
                    return;
                }
            } else {
                logger(`ZoteroCitation: Selecting regular item (${item.id})`);
                // await selectItemById(item.id);
                revealSource({ library_id: item.libraryID, zotero_key: item.key } as ZoteroItemReference);
                return;
            }
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
                logger(`ZoteroCitation: Highlighting bounding boxes`);
                // Scenario 1: With bounding boxes - create temporary highlights
                const annotationReferences = await createBoundingBoxHighlights(
                    boundingBoxData.map(({ page, bboxes }) => ({
                        pageIndex: page - 1,
                        boxes: bboxes,
                    })),
                    previewText,
                    BEAVER_ANNOTATION_TEXT,
                    { authorName: BEAVER_CITATION_ANNOTATION_AUTHOR },
                );
                BeaverTemporaryAnnotations.addToTracking(annotationReferences);
                const annotationIds = annotationReferences.map(reference => reference.zotero_key);
                // Navigate to the first annotation if created successfully
                if (annotationIds.length > 0 && reader) {
                    installTemporaryAnnotationDismissOnNextClick(reader, {
                        ownerDocument,
                        logContext: 'ZoteroCitation',
                    });
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
        
        // For Zotero citations, use proper CSL format
        if (!effectiveLibraryID || !effectiveItemKey) return null;
        try {
            const item = Zotero.Items.getByLibraryAndKey(effectiveLibraryID, effectiveItemKey);
            if (!item) return null;
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
    const isNoteCitation = citationMetadata?.type === 'note';
    const isAnnotationCitation = citationMetadata?.type === 'annotation';
    const hasBoundingBoxes = !isNoteCitation && !isAnnotationCitation && !!citationMetadata && getCitationBoundingBoxes(citationMetadata).length > 0;
    const hasLocator = !isNoteCitation && !isAnnotationCitation && (pages.length > 0 || hasBoundingBoxes);
    const citationClassBase = isExternal && !mappedZoteroItem
        ? "zotero-citation external-citation"
        : (hasLocator || isAnnotationCitation)
        ? "zotero-citation with-locator"
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
                    <span className="font-color-secondary text-sm">Page {pageLabels[0]}</span>
                )}
            </span>
            <span className="font-color-secondary text-sm px-3 py-15 block" style={{ wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
                {previewText}
            </span>
            {isExternal && !mappedZoteroItem && (
                <span className="px-3 py-15 border-top-quinary block">
                    <span className="display-flex flex-row items-center gap-15">
                        <Icon icon={GlobalSearchIcon} className="font-color-secondary" />
                        <span className="text-sm font-color-secondary">
                            View details
                        </span>
                    </span>
                </span>
            )}
            {isNoteCitation && (!isExternal || !!mappedZoteroItem) && (
                <span className="px-3 py-15 border-top-quinary block">
                    <span className="display-flex flex-row items-center gap-15">
                        <Icon icon={NoteIcon} className="font-color-secondary" />
                        <span className="text-sm font-color-secondary">
                            Opens note
                        </span>
                    </span>
                </span>
            )}
            {isAnnotationCitation && (!isExternal || !!mappedZoteroItem) && (
                <span className="px-3 py-15 border-top-quinary block">
                    <span className="display-flex flex-row items-center gap-15">
                        <Icon icon={HighlighterIcon} className="font-color-secondary" />
                        <span className="text-sm font-color-secondary">
                            Opens annotation in PDF
                        </span>
                    </span>
                </span>
            )}
            {hasLocator && (!isExternal || !!mappedZoteroItem) && (
                <span className="px-3 py-15 border-top-quinary block">
                    <span className="display-flex flex-row items-center gap-15">
                        <Icon icon={PdfIcon} className="font-color-secondary" />
                        <span className="text-sm font-color-secondary">
                            {hasBoundingBoxes
                                ? (pages[0] != null ? `Highlights passage on page ${pageLabels[0]}` : 'Highlights passage in PDF')
                                : (pages[0] != null ? `Opens PDF on page ${pageLabels[0]}` : 'Opens PDF at location')}
                        </span>
                    </span>
                </span>
            )}
            {!hasLocator && !isNoteCitation && !isAnnotationCitation && (!isExternal || !!mappedZoteroItem) && (
                <span className="px-3 py-15 border-top-quinary block">
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

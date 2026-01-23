import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider, createStore } from 'jotai';
import { store } from '../store';
import MarkdownRenderer from '../components/messages/MarkdownRenderer';
import { Citation } from '../../src/services/CitationService';
import { citationDataMapAtom, citationKeyToMarkerAtom } from '../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../atoms/externalReferences';
import { CitationData, parseCitationAttributes, computeBaseCitationKeyFromAttrs } from '../types/citations';
import { CITATION_TAG_PATTERN } from '../utils/citationPreprocessing';
import { ZoteroItemReference } from '../types/zotero';
import { logger } from '../../src/utils/logger';
import { ExternalReference } from '../types/externalReferences';
import { formatExternalCitation } from '../atoms/externalReferences';

// Regex for citation syntax - matches self-closing (/>) and non-self-closing (>) with or without closing tag
const citationRegex = /<citation\s+([^>]+?)\s*(\/>|>(?:.*?<\/citation>)?)/g;
const attributeRegex = /(\w+)\s*=\s*"([^"]*)"/g;

/**
 * Parses attributes from a string
 * @param attrString String to parse attributes from
 * @returns Object containing parsed attributes
 */
function parseAttributes(attrString: string) {
    const attrs: Record<string, string> = {};
    attrString.replace(attributeRegex, (fullMatch, attrName, attrValue) => {
        attrs[attrName] = attrValue;
        return fullMatch;
    });
    return attrs;
}

/**
 * Extracts libraryID and itemKey from an id attribute value.
 * Format: "libraryID-itemKey" (may have 'user-content-' prefix from sanitization)
 * @param id - The raw id string from the citation attribute
 * @returns An object with libraryID and itemKey
 */
function parseItemReference(id: string): { libraryID: number; itemKey: string } {
    const cleanedId = id.replace('user-content-', '');
    const dashIndex = cleanedId.indexOf('-');
    if (dashIndex > 0) {
        const libraryIDString = cleanedId.substring(0, dashIndex);
        const itemKey = cleanedId.substring(dashIndex + 1);
        return { libraryID: parseInt(libraryIDString, 10) || 1, itemKey };
    }
    // Fallback for malformed reference
    return { libraryID: 1, itemKey: cleanedId };
}

/**
 * Get the Zotero item reference from citation attributes.
 * Priority: att_id > item_id (attachment_id is normalized to att_id)
 */
function getItemReferenceFromAttrs(attrs: Record<string, string>): { libraryID: number; itemKey: string } | null {
    // Normalize attachment_id to att_id
    const attId = attrs.att_id || attrs.attachment_id;
    if (attId) {
        return parseItemReference(attId);
    }
    if (attrs.item_id) {
        return parseItemReference(attrs.item_id);
    }
    return null;
}

/**
 * Preprocesses markdown content to replace note tags with headers and separators.
 * @param text Raw markdown text containing note tags
 * @returns Processed markdown with note tags replaced by headers/lines
 */
export function preprocessNoteContent(text: string): string {
    // Clean up backticks around complete citations (handles both /> and > endings)
    text = text.replace(/`(<citation[^>]*\/?>)`/g, '$1');

    // Remove note tags (keep content), add title as markdown header if present
    return text.replace(/(\s*)<note\s+([^>]*?)>(\s*)/g, (match, before, attrString, after) => {
        const attrs = parseAttributes(attrString);
        if (attrs.title) {
            return `\n\n---\n## ${attrs.title}\n\n`;
        }
        return before + '---\n' + after;
    }).replace(/<\/note>/g, '\n---');
}

/**
 * Converts markdown content to plain text
 * @param text Text to format
 * @param cslEngine CSL engine
 * @returns Formatted text
 */
export function renderToMarkdown(
    text: string
) : string {

    const externalReferenceMapping = store.get(externalReferenceMappingAtom);
    const externalItemMapping = store.get(externalReferenceItemMappingAtom);
    const citationMetadataMap = store.get(citationDataMapAtom);

    // Array of cited items
    const citedItems: Zotero.Item[] = [];
    const externalReferences: ExternalReference[] = [];

    // Preprocess note tags and clean up backticks
    text = preprocessNoteContent(text);

    // Format references
    const formattedContent = text.replace(citationRegex, (match: string, attrString: string): string => {
        // Parse the attributes
        const attrs = parseAttributes(attrString);
        
        // Get item reference from attributes (att_id, item_id, or external_id)
        let itemRef = getItemReferenceFromAttrs(attrs);
        const isExternalReference = !!attrs.external_id && !itemRef;
        const isExternalReferenceMappedToZoteroItem = isExternalReference && !!externalItemMapping[attrs.external_id];

        // 1. External reference (not mapped to Zotero) ---------------------------------------------------
        if (isExternalReference && !isExternalReferenceMappedToZoteroItem) {
            // Look up external reference data
            const externalRef = externalReferenceMapping[attrs.external_id];
            if (!externalRef) {
                logger(`renderToMarkdown: No external reference found for external_id: ${attrs.external_id}`);
                return '';
            }
            externalReferences.push(externalRef);
            // Use author_year from external reference
            const authorYear = formatExternalCitation(externalRef);
            return authorYear ? `(${authorYear})` : '';
        }

        // 2. External reference mapped to Zotero item ---------------------------------------------------
        if (isExternalReferenceMappedToZoteroItem) {
            const mappedZoteroItem = externalItemMapping[attrs.external_id];
            if (!mappedZoteroItem) {
                logger(`renderToMarkdown: No Zotero item found for external_id: ${attrs.external_id}`);
                return '';
            }
            // Use the mapped Zotero item
            itemRef = { libraryID: mappedZoteroItem.library_id, itemKey: mappedZoteroItem.zotero_key };
        }

        // 3. Zotero item ---------------------------------------------------
        if (!itemRef) {
            logger(`renderToMarkdown: Citation tag missing item reference: ${match}`);
            return '';
        }
        
        const { libraryID, itemKey } = itemRef;

        // Get the Zotero item
        const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
        if (!item) {
            logger(`renderToMarkdown: No Zotero item found for libraryID: ${libraryID}, itemKey: ${itemKey}`);
            return '';
        }
        
        // Item to cite
        const parent = item.parentItem;
        const itemToCite = item.isNote() ? item : (parent || item);

        // Add the item to the array of cited items
        citedItems.push(itemToCite);

        // Get the citation data
        let citation = '';
        if (itemToCite.isRegularItem()) {
            const citationObject: Citation = {id: itemToCite.id};
            if (attrs.page || attrs.pages) {
                citationObject.locator = attrs.page || attrs.pages;
                citationObject.label = 'p.';
            }
            citation = Zotero.Beaver?.citationService?.formatCitation([citationObject]) ?? '';
        } else if (itemToCite.isNote()) {
            citation = '(Note)';
        } else if (itemToCite.isAttachment()) {
            citation = '(File)';
        }
  
        // Format the citation with page locator if provided
        // return attrs.pages ? `${citation}, p. ${attrs.pages}` : citation; 
        return ' ' + citation; 
    }).replace('  (', ' (');

    // Format the bibliography
    let bibliography = (Zotero.Beaver?.citationService?.formatBibliography(citedItems) ?? '').replace(/\n/g, '\n\n');
    if (externalReferences.length > 0) {
        bibliography += externalReferences.map(reference => `${formatExternalCitation(reference)} (external reference)`).join('\n\n');
    }

    // Return the formatted content
    return citedItems.length > 0 || externalReferences.length > 0
        ? `${formattedContent.trim()}\n\n## Sources\n\n${bibliography}`
        : formattedContent;
}

export interface RenderContextData {
    citationDataMap?: Record<string, CitationData>;
    externalMapping?: Record<string, ZoteroItemReference | null>;
    externalReferencesMap?: Record<string, ExternalReference>;
}

/**
 * Converts markdown content to HTML string using the MarkdownRenderer component
 * @param content Markdown content to convert
 * @param className Optional class name to apply to the markdown (defaults to "markdown")
 * @param contextData Optional context data (citations, mappings) to populate store for static render
 * @returns HTML string representation of the markdown
 */
export function renderToHTML(
    content: string, 
    className: string = "markdown",
    contextData?: RenderContextData
): string {
    let renderStore = store;

    // Pre-calculate citation markers for static render to avoid React state updates during render.
    // This must happen before the render since effects don't run during renderToStaticMarkup.
    // Note: This only depends on content, not contextData, so we always calculate markers.
    const markerMap: Record<string, string> = {};
    let markerCount = 0;
    
    // Use the same regex as preprocessCitations to find citations in order
    const pattern = new RegExp(CITATION_TAG_PATTERN);
    
    let match;
    while ((match = pattern.exec(content)) !== null) {
        const attributesStr = match[1];
        const attrs = parseCitationAttributes(attributesStr);
        // Use base key (without sid/page) so all citations to the same item share a marker
        const citationKey = computeBaseCitationKeyFromAttrs(attrs);
        
        if (citationKey && !markerMap[citationKey]) {
            markerCount++;
            markerMap[citationKey] = markerCount.toString();
        }
    }

    // If context data is provided, we create a temporary store to ensure the data 
    // is available during the synchronous static render.
    if (contextData) {
        renderStore = createStore();
        
        if (contextData.citationDataMap) {
            renderStore.set(citationDataMapAtom, contextData.citationDataMap);
        }
        
        if (contextData.externalMapping) {
            renderStore.set(externalReferenceItemMappingAtom, contextData.externalMapping);
        }
        
        if (contextData.externalReferencesMap) {
            renderStore.set(externalReferenceMappingAtom, contextData.externalReferencesMap);
        }
    }

    // Set pre-calculated markers in the store (either ambient or isolated)
    if (Object.keys(markerMap).length > 0) {
        renderStore.set(citationKeyToMarkerAtom, markerMap);
    }

    // Create a React element using the existing MarkdownRenderer component
    // @ts-ignore createElement exists in React
    const markdownElement = React.createElement(MarkdownRenderer, {
        content,
        className,
        exportRendering: true,
        enableNoteBlocks: false
    });

    // Wrap in Jotai Provider to share state
    const wrappedElement = React.createElement(Provider, { store: renderStore }, markdownElement);

    // Render the React element to an HTML string
    return renderToStaticMarkup(wrappedElement);
}

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Provider, createStore } from 'jotai';
import { store } from '../store';
import MarkdownRenderer from '../components/messages/MarkdownRenderer';
import { Citation } from '../../src/services/CitationService';
import { citationsAtom, citationByKeyAtom, citationKeyToMarkerAtom, pageLabelsByAttachmentIdAtom, type PageLabelsByAttachmentId } from '../atoms/citations';
import { externalReferenceItemMappingAtom, externalReferenceMappingAtom } from '../atoms/externalReferences';
import { Citation as BeaverCitation } from '../types/citations';
import { CITATION_TAG_PATTERN } from '../utils/citationPreprocessing';
import { ZoteroItemReference } from '../types/zotero';
import { logger } from '../../src/utils/logger';
import { ExternalReference } from '../types/externalReferences';
import { formatExternalCitation } from '../atoms/externalReferences';
import {
    baseCitationKey,
    externalCompatKey,
    getRequestedRef,
    getResolvedRef,
    getPageLocator,
    normalizeCitationTag,
    parseRawCitationAttributes,
    requestedCitationKey,
} from './citationGrammar';

// Regex for citation syntax - matches self-closing (/>) and non-self-closing (>) with or without closing tag
const citationRegex = /<citation(?:\s+([^>]*?))?\s*(\/>|>(?:.*?<\/citation>)?)/g;
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

function getEarliestExistingMarker(markerMap: Record<string, string>, keys: string[]): string | undefined {
    const markers = keys
        .map((key) => markerMap[key])
        .filter((marker): marker is string => !!marker);
    if (markers.length === 0) return undefined;

    const numericMarkers = markers
        .map((marker) => parseInt(marker, 10))
        .filter((marker) => Number.isFinite(marker));
    if (numericMarkers.length === 0) return markers[0];

    return Math.min(...numericMarkers).toString();
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
    const citationByKey = store.get(citationByKeyAtom);

    // Array of cited items
    const citedItems: Zotero.Item[] = [];
    const externalReferences: ExternalReference[] = [];

    // Preprocess note tags and clean up backticks
    text = preprocessNoteContent(text);

    // Format references
    const formattedContent = text.replace(citationRegex, (match: string, attrString: string = ''): string => {
        const attrs = parseRawCitationAttributes(attrString);
        const normalized = normalizeCitationTag(attrs);
        if (!normalized.ok) {
            logger(`renderToMarkdown: Citation tag missing valid reference: ${match}`);
            return '';
        }

        let ref = normalized.ref;
        const externalId = ref.kind === 'external' ? ref.external_id : undefined;
        const isExternalReference = ref.kind === 'external';
        const isExternalReferenceMappedToZoteroItem = !!externalId && !!externalItemMapping[externalId];

        // 1. External reference (not mapped to Zotero) ---------------------------------------------------
        if (isExternalReference && !isExternalReferenceMappedToZoteroItem) {
            // Look up external reference data
            const externalRef = externalReferenceMapping[externalId!];
            if (!externalRef) {
                logger(`renderToMarkdown: No external reference found for external_id: ${externalId}`);
                return '';
            }
            externalReferences.push(externalRef);
            // Use author_year from external reference
            const authorYear = formatExternalCitation(externalRef);
            return authorYear ? `(${authorYear})` : '';
        }

        // 2. External reference mapped to Zotero item ---------------------------------------------------
        if (isExternalReferenceMappedToZoteroItem) {
            const mappedZoteroItem = externalItemMapping[externalId!];
            if (!mappedZoteroItem) {
                logger(`renderToMarkdown: No Zotero item found for external_id: ${externalId}`);
                return '';
            }
            ref = { kind: 'zotero', library_id: mappedZoteroItem.library_id, zotero_key: mappedZoteroItem.zotero_key, loc: ref.loc };
        }

        // 2b. External file (user-attached, non-Zotero) — no Zotero item or
        // bibliography entry; render the filename (+ page) inline so the
        // citation isn't silently dropped from copied Markdown/text.
        if (ref.kind === 'external_file') {
            const meta = citationByKey[requestedCitationKey(ref)] ?? citationByKey[baseCitationKey(ref)];
            const name = meta?.display_name || `ext-${ref.ext_key}`;
            const page = getPageLocator(ref);
            return page ? ` (${name}, p. ${page})` : ` (${name})`;
        }

        // 3. Zotero item ---------------------------------------------------
        if (ref.kind !== 'zotero') {
            // Unknown/future ref kind (e.g. another connected app's resource):
            // fall back to the cited display name rather than dropping it.
            const meta = citationByKey[requestedCitationKey(ref)] ?? citationByKey[baseCitationKey(ref)];
            const name = meta?.display_name;
            if (name) return ` (${name})`;
            logger(`renderToMarkdown: Citation tag missing item reference: ${match}`);
            return '';
        }
        
        const { library_id: libraryID, zotero_key: itemKey } = ref;

        // Get the Zotero item
        try {
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
                const rawPage = getPageLocator(ref);
                if (rawPage) {
                    citationObject.locator = rawPage;
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
        } catch (e) {
            logger(`renderToMarkdown: Item not loaded for libraryID: ${libraryID}, itemKey: ${itemKey}`);
            return '';
        } 
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
    citationDataMap?: Record<string, BeaverCitation>;
    externalMapping?: Record<string, ZoteroItemReference | null>;
    externalReferencesMap?: Record<string, ExternalReference>;
    pageLabelsByAttachmentId?: PageLabelsByAttachmentId;
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
    const aliasGroups: string[][] = [];
    while ((match = pattern.exec(content)) !== null) {
        const attributesStr = match[1] || '';
        const normalized = normalizeCitationTag(parseRawCitationAttributes(attributesStr));
        const citationKey = normalized.ok ? baseCitationKey(normalized.ref) : '';
        
        if (citationKey && !markerMap[citationKey]) {
            markerCount++;
            markerMap[citationKey] = markerCount.toString();
        }
    }

    if (contextData?.citationDataMap) {
        for (const citation of Object.values(contextData.citationDataMap)) {
            const keys: string[] = [];
            for (const ref of [getRequestedRef(citation), getResolvedRef(citation)]) {
                if (!ref) continue;
                keys.push(baseCitationKey(ref));
                if (ref.kind === 'external') keys.push(externalCompatKey(ref.external_id));
            }
            const uniqueKeys = [...new Set(keys.filter(Boolean))];
            if (uniqueKeys.length > 1) aliasGroups.push(uniqueKeys);
        }
        for (const keys of aliasGroups) {
            const existing = getEarliestExistingMarker(markerMap, keys);
            if (!existing) continue;
            for (const key of keys) markerMap[key] = existing;
        }
    }

    // If context data is provided, we create a temporary store to ensure the data 
    // is available during the synchronous static render.
    if (contextData) {
        renderStore = createStore();
        
        if (contextData.citationDataMap) {
            renderStore.set(citationsAtom, Object.values(contextData.citationDataMap));
        }
        
        if (contextData.externalMapping) {
            renderStore.set(externalReferenceItemMappingAtom, contextData.externalMapping);
        }
        
        if (contextData.externalReferencesMap) {
            renderStore.set(externalReferenceMappingAtom, contextData.externalReferencesMap);
        }

        if (contextData.pageLabelsByAttachmentId) {
            renderStore.set(pageLabelsByAttachmentIdAtom, contextData.pageLabelsByAttachmentId);
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

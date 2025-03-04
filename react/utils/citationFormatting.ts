import { ZoteroStyle } from "../../src/utils/citations";
import { Source } from "../types/sources";
import { createOpenPDFURL } from "./createOpenPDFURL";
import { getZoteroItem } from "./sourceUtils";
import { truncateText } from "./stringUtils";

// Constants
export const MAX_NOTE_TITLE_LENGTH = 20;
export const MAX_NOTE_CONTENT_LENGTH = 150;

// Interface for CSL Engine
interface CSLEngine {
    updateItems(ids: number[]): void;
    previewCitationCluster(
        citation: any,
        citationsPre: any[],
        citationsPost: any[],
        format: 'text' | 'html'
    ): string;
    free(): void;
}

/**
* Get a CSL engine instance for formatting citations
* @param style Citation style identifier
* @param locale Locale for the citation
* @returns CSL engine instance
*/
export function getCslEngine(style: string, locale: string): CSLEngine {
    const csl_style: ZoteroStyle = Zotero.Styles.get(style);
    return csl_style.getCiteProc(locale, 'text');
}

/**
 * Get an in-text citation for a Zotero item or array of items
 * @param items Zotero item or array of items
 * @param cslEngine Optional CSL engine (will be created if not provided)
 * @param style Citation style (used only if cslEngine not provided)
 * @param locale Locale (used only if cslEngine not provided)
 * @returns In-text citation
 */
export function getInTextCitation(
    items: Zotero.Item | Zotero.Item[],
    parentheses: boolean = true,
    cslEngine?: CSLEngine | null,
    style = 'http://www.zotero.org/styles/chicago-author-date',
    locale = 'en-US'
): string {
    // Format citation with CSL engine
    const engineToUse = cslEngine || getCslEngine(style, locale);
    const shouldFreeEngine = !cslEngine; // Free only if we created it

    // Format citation for each item
    const citationItems = Array.isArray(items) ? items.map(item => ({id: item.id})) : [{id: items.id}];
    const citation = {
        citationItems: citationItems,
        properties: { inText: true }
    };

    try {
        let citation_formatted = engineToUse.previewCitationCluster(citation, [], [], "text");
        citation_formatted = parentheses ? citation_formatted : citation_formatted.replace(/^\(|\)$/g, '');
        return citation_formatted
            .trim()
            .replace(/,$/, '')
            .replace(/”/g, '"')
            .replace(/“/g, '"')
            .replace(/,"$/, '"');
    } finally {
        if (shouldFreeEngine) {
            engineToUse.free();
        }
    }
}

/**
* Format an in-text citation for a Zotero item
* @param item Zotero item to format
* @param cslEngine Optional CSL engine (will be created if not provided)
* @param style Citation style (used only if cslEngine not provided)
* @param locale Locale (used only if cslEngine not provided)
* @returns Formatted in-text citation
*/
export function formatCitation(
    item: Zotero.Item, 
    cslEngine?: CSLEngine | null,
    style = 'http://www.zotero.org/styles/chicago-author-date',
    locale = 'en-US'
): string {
    // Return a note title for notes
    if (item.isNote()) {
        return `Note: ${truncateText(item.getNoteTitle(), MAX_NOTE_TITLE_LENGTH)}`;
    }
    
    // Format citation with CSL engine
    const citation = getInTextCitation(item, false, cslEngine, style, locale);
    return citation;
}

/**
* Format a full bibliographic reference for a Zotero item
* @param item Zotero item to format
* @param cslEngine Optional CSL engine (will be created if not provided)
* @param style Citation style (used only if cslEngine not provided) 
* @param locale Locale (used only if cslEngine not provided)
* @returns Formatted reference
*/
export function formatReference(
    item: Zotero.Item,
    cslEngine?: CSLEngine | null,
    style = 'http://www.zotero.org/styles/chicago-author-date',
    locale = 'en-US'
): string {
    // Return truncated note content for notes
    if (item.isNote()) {
        // @ts-ignore unescapeHTML exists
        return truncateText(Zotero.Utilities.unescapeHTML(item.getNote()), MAX_NOTE_CONTENT_LENGTH);
    }
    
    // Format reference with CSL engine
    const engineToUse = cslEngine || getCslEngine(style, locale);
    const shouldFreeEngine = !cslEngine; // Free only if we created it
    
    try {
        const reference = Zotero.Cite.makeFormattedBibliographyOrCitationList(engineToUse, [item], "text").trim();
        return reference;
    } finally {
        if (shouldFreeEngine) {
            engineToUse.free();
        }
    }
}

/**
* Format a citation and reference from a Zotero item
* @param item Zotero item to format
* @param cslEngine CSL engine
* @returns Formatted citation and reference
*/
export function citationDataFromItem(
    item: Zotero.Item,
    cslEngine?: CSLEngine | null,
    style = 'http://www.zotero.org/styles/chicago-author-date',
    locale = 'en-US'
) : { citation: string, reference: string, url: string } {
    const parent = item.parentItem;
    const itemToFormat = item.isNote() ? item : (parent || item);
    
    // Get the CSL engine
    const engineToUse = cslEngine || getCslEngine(style, locale);
    const shouldFreeEngine = !cslEngine;
    
    try {
        return {
            citation: formatCitation(itemToFormat, engineToUse),
            reference: formatReference(itemToFormat, engineToUse).replace(/\n/g, '<br />'),
            url: createOpenPDFURL(item)
        };
    } finally {
        if (shouldFreeEngine) {
            engineToUse.free();
        }
    }
}

/**
* Format a citation and reference from a source
* @param source Source to format
* @param cslEngine CSL engine
* @returns Formatted citation and reference
*/
export function citationDataFromSource(
    source: Source,
    cslEngine: CSLEngine
) : { citation: string, reference: string, url: string } | null {
    if (source.type === 'zotero_item') {
        // Get item and parent item
        const item = getZoteroItem(source);
        if(!item) return null;
        
        // Format citation and reference
        const { citation, reference, url } = citationDataFromItem(item, cslEngine);
        
        // Return formatted source
        return {
            citation: citation,
            reference: reference,
            url: url
        } ;
    }
    if (source.type === 'file') {
        return {
            citation: 'File',
            reference: source.filePath,
            url: `file://${source.filePath}`
        };
    }
    return null;
}
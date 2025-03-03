import { ZoteroStyle } from "../../src/utils/citations";
import { Source } from "../types/sources";
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
    const engineToUse = cslEngine || getCslEngine(style, locale);
    const shouldFreeEngine = !cslEngine; // Free only if we created it
    
    try {
        const citation = {
            citationItems: [{ id: item.id }],
            properties: { inText: true }
        };
        
        const citation_formatted = engineToUse.previewCitationCluster(citation, [], [], "text")
            .replace(/^\(|\)$/g, '') // Remove parentheses
            .trim()
            .replace(/,$/, '') // Remove trailing comma
            .replace(/"/g, '"')
            .replace(/"/g, '"')
            .replace(/,"$/, '"');
        
        return citation_formatted;
    } finally {
        if (shouldFreeEngine) {
            engineToUse.free();
        }
    }
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
export function citationFromItem(
    item: Zotero.Item,
    cslEngine: CSLEngine
) : { citation: string, reference: string } {
    const parent = item.parentItem;
    const itemToFormat = item.isNote() ? item : (parent || item);
    return {
        citation: formatCitation(itemToFormat, cslEngine),
        reference: formatReference(itemToFormat, cslEngine).replace(/\n/g, '<br />')
    };
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
) : { citation: string, reference: string } | null {
    if (source.type === 'zotero_item') {
        // Get item and parent item
        const item = getZoteroItem(source);
        if(!item) return null;
        
        // Format citation and reference
        const { citation, reference } = citationFromItem(item, cslEngine);
        
        // Return formatted source
        return {
            citation: citation,
            reference: reference,
        } ;
    }
    if (source.type === 'file') {
        return {
            citation: 'File',
            reference: source.filePath,
        };
    }
    return null;
}
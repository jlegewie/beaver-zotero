import { createOpenPDFURL } from "./createOpenPDFURL";
import { ZoteroSource, SourceWithCitations } from "../types/sources";
import { getPref } from "../../src/utils/prefs";


/**
* Interface representing a parsed citation
*/
interface Citation {
    id: string;
    libraryId: string;
    itemKey: string;
    locators: string[];
}

/**
* Interface for the parser output
*/
interface ParserOutput {
    text: string;
    citations: Citation[];
    sources: SourceWithCitations[];
}

/**
* Parses citation format and transforms them into properly formatted citations
* @param text Text containing citations in the format {{cite:DOC-ID|page_info}}
* @param sources Array of sources to use for citation formatting
* @returns Object containing transformed text, reference list, and parsed citations
*/
function parseCitations(
    text: string,
    sources: SourceWithCitations[] = []
): ParserOutput {
    const citations: Citation[] = [];
    const citedSources: SourceWithCitations[] = [];
    let lastSourceId: string = '';
    
    // Citation format
    const authorYearFormat = getPref("citationFormat") !== "numeric";

    // Regular expression to match the citation format
    const citationRegex = /\{\{cite:([^}]+)\}\}/g;
    
    // Process text and replace citations with markdown links
    const processedText = text.replace(citationRegex, (match, citationContent) => {
        // Split by semicolon to get individual document citations
        const docCitations = citationContent.split(';');
        const citationLinks: string[] = [];
        
        for (const docCitation of docCitations) {
            // Split by pipe to separate document ID from page info
            const parts = docCitation.split('|');
            const docId = parts[0];
            const pageInfo = parts.length > 1 ? parts[1] : null;
            
            // Extract libraryId and itemKey
            const idParts = docId.split('-');
            const libraryId = idParts[0];
            const itemKey = idParts[1];
            
            // Find the source in sources
            const source = sources.find(
                s => s.type === 'zotero_item' && 
                    (
                        (s as ZoteroSource).itemKey === itemKey ||
                        (s as ZoteroSource).childItemKeys.includes(itemKey)
                    ) &&
                    String((s as ZoteroSource).libraryID) === libraryId
            );
            
            // If source not found, skip this citation
            if (!source) continue;
            
            // Parse page numbers if they exist
            const pages: number[] = [];
            let pageString = '';
            
            if (pageInfo) {
                // Remove 'p' prefix and split by commas
                const pageRanges = pageInfo.replace(/^p/, '').split(',');
                pageString = pageInfo.replace(/^p/, '');
                
                for (const range of pageRanges) {
                    if (range.includes('-')) {
                        // Handle page range (e.g., "3-6")
                        const [start, end] = range.split('-').map(Number);
                        for (let i = start; i <= end; i++) {
                            pages.push(i);
                        }
                    } else {
                        // Handle single page
                        pages.push(Number(range));
                    }
                }
            }
            
            // Create Citation object
            const citation: Citation = {
                id: docId,
                libraryId,
                itemKey,
                locators: pages.map(page => page.toString())
            };
            
            citations.push(citation);
            citedSources.push(source);

            // Get the item from Zotero for citation formatting
            const item = Zotero.Items.getByLibraryAndKey(libraryId, itemKey);
            if (!item) continue;
            
            // Format citation using CSL
            // const parentItem = item.isNote() ? item : item?.parentItem;
            // const pageLocator = pageString ? pageString : null;
            // const cslCitation = {
            //     citationItems: [{ id: parentItem?.id || item.id, locator: pageLocator }],
            //     properties: { inText: true }
            // };
            
            // Create link URL using createOpenPDFURL
            const page = pages.length > 0 ? pages[0] : null;
            let url = createOpenPDFURL(item, page);
            if (item.isNote()) url = url.replace('open-pdf', 'open-note');
            
            // Label for the citation link
            let label = '';
            if (authorYearFormat) {
                label = lastSourceId === source.id
                    ? (page ? `p.${page}` : 'Ibid')
                    : (page ? `${source.citation}, p.${page}` : source.citation);
            } else {
                label = source.numericCitation;
            }

            // Create markdown link
            citationLinks.push(`[${label}](${url} "${source.reference}")`);

            // Update last source ID
            lastSourceId = source.id;
        }
        
        // Join multiple citations with commas
        if (citationLinks.length === 0) return match; // Return original if no valid citations
        return citationLinks.join(' ');
    });
        
    return {
        text: processedText,
        citations,
        sources: [...new Set(citedSources)].sort((a, b) => parseInt(a.numericCitation) - parseInt(b.numericCitation)) as SourceWithCitations[]
    };
}

// Export for use in other modules
export { parseCitations, Citation, ParserOutput };
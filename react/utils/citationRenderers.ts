import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownRenderer from '../components/MarkdownRenderer';
import { Citation } from '../../src/services/CitationService';

// Regex for citation syntax
const citationRegex = /<citation\s+([^>]+?)\s*(\/>|>.*?<\/citation>)/g;
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
 * Extracts libraryID and itemKey from the id attribute.
 * @param id - The raw id string from the citation.
 * @returns An object with libraryID and itemKey.
 */
function parseId(id: string): { libraryID: number; itemKey: string } {
    const cleanedId = id.replace('user-content-', '');
    const [libraryIDString, itemKey] = cleanedId.includes('-') ? cleanedId.split('-') : [cleanedId, cleanedId];
    const libraryID = parseInt(libraryIDString, 10) || 1;
    return { libraryID, itemKey };
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

    // Array of cited items
    const citedItems: Zotero.Item[] = [];    

    // Format references
    const formattedContent = text.replace(citationRegex, (match, attrString) => {
        // Parse the attributes
        const attrs = parseAttributes(attrString);
        if (!attrs.id) {
            console.warn("Citation tag missing 'id' attribute:", match);
            return '';
        }

        // Parse the id to get libraryID and itemKey
        const { libraryID, itemKey } = parseId(attrs.id);

        // Get the Zotero item
        const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
        if (!item) {
            console.warn(`No Zotero item found for libraryID: ${libraryID}, itemKey: ${itemKey}`);
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
            if (attrs.pages) {
                citationObject.locator = attrs.pages;
                citationObject.label = 'p.';
            }
            citation = Zotero.Beaver.citationService.formatCitation([citationObject]);
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
    const bibliography = Zotero.Beaver.citationService.formatBibliography(citedItems).replace(/\n/g, '\n\n');

    // Return the formatted content
    return `${formattedContent}\n## Sources\n\n${bibliography}`;
}

/**
 * Converts markdown content to HTML string using the MarkdownRenderer component
 * @param content Markdown content to convert
 * @param className Optional class name to apply to the markdown (defaults to "markdown")
 * @returns HTML string representation of the markdown
 */
export function renderToHTML(content: string, className: string = "markdown"): string {
    // Create a React element using the existing MarkdownRenderer component
    // @ts-ignore createElement exists in React
    const markdownElement = React.createElement(MarkdownRenderer, {
        content,
        className,
        exportRendering: true
    });

    // Render the React element to an HTML string
    return renderToStaticMarkup(markdownElement);
}
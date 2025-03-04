import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownRenderer from '../components/MarkdownRenderer';
import { citationDataFromItem } from './citationFormatting';
import { getPref } from '../../src/utils/prefs';

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
    text: string,
    style: string | null = null,
    locale: string | null = null
) : string {
    // Citation preferences
    style = style || getPref("citationStyle") || 'http://www.zotero.org/styles/chicago-author-date';
    locale = locale || getPref("citationLocale") || 'en-US';

    // Format citations for human-readable clipboard content
    let bibliography = '';
    
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

        // Get the citation data
        const { citation, reference, url } = citationDataFromItem(item, null, style, locale);

        // Format the citation
        bibliography += reference + '\n\n';
        return attrs.pages
            ? `(${citation}, p. ${attrs.pages})`
            : `(${citation})`; 
    });

    return `${formattedContent}\n\n## Sources\n\n${bibliography}`;
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
        className
    });

    // Render the React element to an HTML string
    return renderToStaticMarkup(markdownElement);
}
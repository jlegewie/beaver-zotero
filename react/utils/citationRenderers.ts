import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownRenderer from '../components/MarkdownRenderer';
import { citationDataFromItem } from './citationFormatting';
import { getPref } from '../../src/utils/prefs';

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
    let formattedContent = text;
    let bibliography = '';
    
    // Format references
    formattedContent = formattedContent.replace(
        /<citation\s+(?:[^>]*?)id="([^"]+)"(?:[^>]*?)(?:pages="([^"]+)")?(?:[^>]*?)\s*(?:\/>|>.*?<\/citation>)/g,
        (match, id, pages) => {
            // Parse the id to get libraryID and itemKey
            id = id.replace('user-content-', '');
            const [libraryIDString, itemKey] = id.includes('-') ? id.split('-') : [id, id];
            const libraryID = parseInt(libraryIDString) || 1;

            // Get the Zotero item
            const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
            if (!item) return '';

            // Get the citation data
            const { citation, reference, url } = citationDataFromItem(item, null, style, locale);

            // Format the citation
            bibliography += reference + '\n\n';
            return pages
                ? `(${citation}, p. ${pages})`
                : `(${citation})`;
        }
    );

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
/**
 * Plain-text extraction from Zotero note HTML.
 *
 * React-free so both bundles can use it: the React UI renders note previews in
 * chips, and the agent data provider needs the same text to describe a note to
 * a client that has no local Zotero.
 */

function unescapeHtml(text: string): string {
    // @ts-ignore unescapeHTML exists on Zotero.Utilities
    if (typeof Zotero !== 'undefined' && Zotero.Utilities?.unescapeHTML) {
        // @ts-ignore unescapeHTML exists on Zotero.Utilities
        return Zotero.Utilities.unescapeHTML(text);
    }

    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

/**
 * Flatten note HTML to plain text, turning block boundaries into newlines so
 * the caller can still tell where one paragraph ended and the next began.
 */
export function noteHtmlToPlainText(noteHtml: string): string {
    const htmlWithBreaks = (noteHtml || '')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/\s*(?:p|div|h[1-6]|li|blockquote|tr|table|ul|ol)\s*>/gi, '\n');
    return unescapeHtml(htmlWithBreaks.replace(/<[^>]*>/g, ''));
}

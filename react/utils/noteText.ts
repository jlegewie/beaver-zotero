import { truncateText } from './stringUtils';

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

export function noteHtmlToPlainText(noteHtml: string): string {
    const htmlWithBreaks = (noteHtml || '')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/\s*(?:p|div|h[1-6]|li|blockquote|tr|table|ul|ol)\s*>/gi, '\n');
    return unescapeHtml(htmlWithBreaks.replace(/<[^>]*>/g, ''));
}

export function getNoteContentPreviewText(
    noteHtml: string,
    noteTitle: string | undefined,
    maxLength: number
): string {
    let plainText = noteHtmlToPlainText(noteHtml);
    if (noteTitle && plainText.startsWith(noteTitle)) {
        plainText = plainText.substring(noteTitle.length);
    }
    plainText = plainText.trim().replace(/\s+/g, ' ');
    return truncateText(plainText, maxLength);
}

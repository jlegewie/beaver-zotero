function truncateText(text: string, maxLength: number): string {
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
}
import { noteHtmlToPlainText } from './noteHtml';

export { noteHtmlToPlainText };

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

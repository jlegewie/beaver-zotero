import { truncateText } from '@beaver/agent-ui/utils/stringUtils';
import { noteHtmlToPlainText } from '../../src/utils/noteHtml';

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

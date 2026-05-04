import { describe, expect, it } from 'vitest';
import { getNoteContentPreviewText, noteHtmlToPlainText } from '../../../react/utils/noteText';

describe('noteText', () => {
    it('converts Zotero note HTML to plain text', () => {
        expect(noteHtmlToPlainText('<p>Title &amp; intro</p><p>Body<br/>line</p>'))
            .toBe('Title & intro\nBody\nline\n');
    });

    it('strips note title after converting HTML to text', () => {
        const preview = getNoteContentPreviewText(
            '<p>Title</p><p>Body with <strong>markup</strong> &amp; entities</p>',
            'Title',
            200
        );

        expect(preview).toBe('Body with markup & entities');
    });

    it('truncates normalized preview text', () => {
        const preview = getNoteContentPreviewText(
            '<p>Title</p><p>One two three four</p>',
            'Title',
            7
        );

        expect(preview).toBe('One two...');
    });
});

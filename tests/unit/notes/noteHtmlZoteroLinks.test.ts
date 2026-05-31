import { describe, it, expect, vi } from 'vitest';

// Simulate the chrome HTML parser used by normalizeNoteHtml: it roundtrips
// note HTML and silently drops href attrs whose scheme is `zotero://`. The
// mock reproduces that href-dropping (and a representative attribute-shuffle)
// so the test exercises the preservation wrapper, not the real ProseMirror DOM.
vi.mock('../../../src/prosemirror/normalize', () => ({
    normalizeNoteHtml: vi.fn((html: string) =>
        html.replace(/<a\s+href="zotero:\/\/[^"]*"([^>]*)>/g, '<a$1>')
    ),
}));

import { normalizeNoteHtmlPreservingZoteroLinks } from '../../../src/utils/noteHtmlSimplifier';
import { normalizeNoteHtml } from '../../../src/prosemirror/normalize';

describe('normalizeNoteHtmlPreservingZoteroLinks', () => {
    it('keeps a zotero://select note link that normalization would strip', () => {
        const input = '<div data-schema-version="9"><p>See <a href="zotero://select/library/items/ABCD1234">My Note</a> here</p></div>';
        const result = normalizeNoteHtmlPreservingZoteroLinks(input);
        // The bare normalize drops the href; the wrapper restores it verbatim.
        expect(normalizeNoteHtml(input)).not.toContain('href="zotero://select/library/items/ABCD1234"');
        expect(result).toContain('<a href="zotero://select/library/items/ABCD1234">My Note</a>');
    });

    it('preserves multiple zotero anchors including group links and footers', () => {
        const input =
            '<div><p><a href="zotero://select/groups/42/items/KEY00001">Group Note</a></p>'
            + '<p><span style="color: rgb(170, 170, 170);">Created by Beaver · '
            + '<a href="zotero://beaver/thread/T1" rel="noopener noreferrer nofollow">Open Chat</a></span></p></div>';
        const result = normalizeNoteHtmlPreservingZoteroLinks(input);
        expect(result).toContain('<a href="zotero://select/groups/42/items/KEY00001">Group Note</a>');
        expect(result).toContain('<a href="zotero://beaver/thread/T1" rel="noopener noreferrer nofollow">Open Chat</a>');
    });

    it('leaves http(s) links to the underlying normalizer untouched', () => {
        const input = '<div><p><a href="https://example.com">x</a></p></div>';
        const result = normalizeNoteHtmlPreservingZoteroLinks(input);
        // http(s) anchors are not zotero://, so they pass through normalize as-is.
        expect(result).toContain('<a href="https://example.com">x</a>');
    });

    it('is a no-op for content without zotero links', () => {
        const input = '<div><p>plain text</p></div>';
        expect(normalizeNoteHtmlPreservingZoteroLinks(input)).toBe(input);
    });
});

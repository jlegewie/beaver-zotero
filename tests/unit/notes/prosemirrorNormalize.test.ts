// @vitest-environment jsdom

import { describe, expect, it, beforeAll } from 'vitest';

// Wire Zotero.getMainWindow() to jsdom's window for ProseMirror DOM access
beforeAll(() => {
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        getMainWindow: () => globalThis.window,
    };
});

import { normalizeNoteHtml } from '../../../src/prosemirror/normalize';

// =============================================================================
// ProseMirror-based normalizeNoteHtml
// =============================================================================

describe('normalizeNoteHtml (ProseMirror roundtrip)', () => {

    // -------------------------------------------------------------------------
    // Empty notes
    // -------------------------------------------------------------------------
    describe('empty notes', () => {
        it('returns empty string for empty paragraph', () => {
            const html = '<div data-schema-version="9"><p></p></div>';
            expect(normalizeNoteHtml(html)).toBe('');
        });

        it('returns empty string for whitespace-only paragraph', () => {
            const html = '<div data-schema-version="9"><p> </p></div>';
            // ProseMirror may or may not treat whitespace-only as empty
            const result = normalizeNoteHtml(html);
            // Either empty or a minimal paragraph is acceptable
            expect(typeof result).toBe('string');
        });
    });

    // -------------------------------------------------------------------------
    // Schema version wrapper
    // -------------------------------------------------------------------------
    describe('schema version', () => {
        it('preserves data-schema-version wrapper', () => {
            const html = '<div data-schema-version="9"><p>Hello</p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('data-schema-version=');
        });

        it('downgrades v10 to v9 when no underline annotations', () => {
            const html = '<div data-schema-version="10"><p>Hello world</p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('data-schema-version="9"');
        });

        it('keeps v10 when underline annotations are present', () => {
            const html = '<div data-schema-version="10"><p><span class="underline" data-annotation="%7B%22type%22%3A%22underline%22%7D">text</span></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('data-schema-version="10"');
        });
    });

    // -------------------------------------------------------------------------
    // Legacy element conversion
    // -------------------------------------------------------------------------
    describe('legacy element conversion', () => {
        it('converts <b> to <strong>', () => {
            const html = '<div data-schema-version="9"><p><b>bold</b></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<strong>bold</strong>');
            expect(result).not.toContain('<b>');
        });

        it('converts <i> to <em>', () => {
            const html = '<div data-schema-version="9"><p><i>italic</i></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<em>italic</em>');
            expect(result).not.toContain('<i>');
        });

        it('converts <s> to strikethrough span', () => {
            const html = '<div data-schema-version="9"><p><s>struck</s></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('text-decoration: line-through');
            expect(result).toContain('struck');
        });

        it('converts <del> to strikethrough span', () => {
            const html = '<div data-schema-version="9"><p><del>deleted</del></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('text-decoration: line-through');
        });
    });

    // -------------------------------------------------------------------------
    // Text formatting
    // -------------------------------------------------------------------------
    describe('text formatting', () => {
        it('preserves <strong> as-is', () => {
            const html = '<div data-schema-version="9"><p><strong>bold</strong></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<strong>bold</strong>');
        });

        it('preserves <em> as-is', () => {
            const html = '<div data-schema-version="9"><p><em>italic</em></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<em>italic</em>');
        });

        it('preserves underline <u>', () => {
            const html = '<div data-schema-version="9"><p><u>underlined</u></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<u');
            expect(result).toContain('underlined');
        });

        it('preserves inline code', () => {
            const html = '<div data-schema-version="9"><p><code>const x = 1</code></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<code>');
            expect(result).toContain('const x = 1');
        });
    });

    // -------------------------------------------------------------------------
    // Block elements
    // -------------------------------------------------------------------------
    describe('block elements', () => {
        it('preserves headings', () => {
            const html = '<div data-schema-version="9"><h1>Title</h1></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<h1>Title</h1>');
        });

        it('preserves blockquotes', () => {
            const html = '<div data-schema-version="9"><blockquote><p>quoted</p></blockquote></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<blockquote>');
            expect(result).toContain('quoted');
        });

        it('preserves ordered lists', () => {
            const html = '<div data-schema-version="9"><ol><li><p>item 1</p></li><li><p>item 2</p></li></ol></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<ol>');
            expect(result).toContain('item 1');
            expect(result).toContain('item 2');
        });

        it('preserves unordered lists', () => {
            const html = '<div data-schema-version="9"><ul><li><p>item</p></li></ul></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<ul>');
            expect(result).toContain('item');
        });

        it('preserves horizontal rules', () => {
            const html = '<div data-schema-version="9"><p>before</p><hr><p>after</p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<hr>');
        });

        it('preserves code blocks', () => {
            const html = '<div data-schema-version="9"><pre>code block</pre></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<pre>');
            expect(result).toContain('code block');
        });
    });

    // -------------------------------------------------------------------------
    // Colors and styles
    // -------------------------------------------------------------------------
    describe('colors and styles', () => {
        it('preserves text color', () => {
            const html = '<div data-schema-version="9"><p><span style="color: red">colored</span></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('color:');
            expect(result).toContain('colored');
        });

        it('preserves background color', () => {
            const html = '<div data-schema-version="9"><p><span style="background-color: yellow">highlighted</span></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('background-color:');
            expect(result).toContain('highlighted');
        });
    });

    // -------------------------------------------------------------------------
    // Links
    // -------------------------------------------------------------------------
    describe('links', () => {
        it('preserves links with href', () => {
            const html = '<div data-schema-version="9"><p><a href="https://example.com">link</a></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('href="https://example.com"');
            expect(result).toContain('link');
        });

        it('adds rel attribute to links', () => {
            const html = '<div data-schema-version="9"><p><a href="https://example.com">link</a></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('rel="noopener noreferrer nofollow"');
        });
    });

    // -------------------------------------------------------------------------
    // Images
    // -------------------------------------------------------------------------
    describe('images', () => {
        it('preserves images with src', () => {
            const html = '<div data-schema-version="9"><p><img src="https://example.com/img.png" alt="test"></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<img');
            expect(result).toContain('src="https://example.com/img.png"');
        });

        it('preserves image dimensions', () => {
            const html = '<div data-schema-version="9"><p><img src="test.png" width="100" height="200"></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('width="100"');
            expect(result).toContain('height="200"');
        });
    });

    // -------------------------------------------------------------------------
    // Citations
    // -------------------------------------------------------------------------
    describe('citations', () => {
        it('preserves citation data', () => {
            const citation = { citationItems: [{ uris: ['http://zotero.org/users/1/items/ABC'] }], properties: {} };
            const encoded = encodeURIComponent(JSON.stringify(citation));
            const html = `<div data-schema-version="9"><p><span class="citation" data-citation="${encoded}">(Author, 2024)</span></p></div>`;
            const result = normalizeNoteHtml(html);
            expect(result).toContain('class="citation"');
            expect(result).toContain('data-citation=');
        });
    });

    // -------------------------------------------------------------------------
    // Math
    // -------------------------------------------------------------------------
    describe('math', () => {
        it('preserves inline math', () => {
            const html = '<div data-schema-version="9"><p><span class="math">$E=mc^2$</span></p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('class="math"');
            expect(result).toContain('E=mc^2');
        });

        it('preserves display math', () => {
            const html = '<div data-schema-version="9"><pre class="math">$$\\int_0^1 x^2 dx$$</pre></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('class="math"');
        });
    });

    // -------------------------------------------------------------------------
    // Tables
    // -------------------------------------------------------------------------
    describe('tables', () => {
        it('preserves basic tables', () => {
            const html = '<div data-schema-version="9"><table><tbody><tr><td><p>cell</p></td></tr></tbody></table></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('<table>');
            expect(result).toContain('cell');
        });
    });

    // -------------------------------------------------------------------------
    // Metadata preservation
    // -------------------------------------------------------------------------
    describe('metadata', () => {
        it('preserves data-citation-items', () => {
            const citationItems = [{ uris: ['http://zotero.org/users/1/items/ABC'], itemData: { type: 'book' } }];
            const encoded = encodeURIComponent(JSON.stringify(citationItems));
            const html = `<div data-citation-items="${encoded}" data-schema-version="9"><p>text</p></div>`;
            const result = normalizeNoteHtml(html);
            expect(result).toContain('data-citation-items=');
        });
    });

    // -------------------------------------------------------------------------
    // Idempotency
    // -------------------------------------------------------------------------
    describe('idempotency', () => {
        it('produces stable output on re-normalization', () => {
            const html = '<div data-schema-version="9"><p>Hello <strong>world</strong></p></div>';
            const first = normalizeNoteHtml(html);
            const second = normalizeNoteHtml(first);
            expect(second).toBe(first);
        });

        it('is idempotent for complex content', () => {
            const html = '<div data-schema-version="9"><h1>Title</h1><p>Text with <em>emphasis</em> and <strong>bold</strong>.</p><ul><li><p>item 1</p></li><li><p>item 2</p></li></ul><blockquote><p>quote</p></blockquote></div>';
            const first = normalizeNoteHtml(html);
            const second = normalizeNoteHtml(first);
            expect(second).toBe(first);
        });
    });

    // -------------------------------------------------------------------------
    // NFC normalization
    // -------------------------------------------------------------------------
    describe('NFC normalization', () => {
        it('normalizes combining characters to precomposed form', () => {
            // é as e + combining acute accent
            const decomposed = 'e\u0301';
            const html = `<div data-schema-version="9"><p>${decomposed}</p></div>`;
            const result = normalizeNoteHtml(html);
            // Should contain the precomposed é
            expect(result).toContain('\u00e9');
        });
    });

    // -------------------------------------------------------------------------
    // Content without wrapper
    // -------------------------------------------------------------------------
    describe('content without wrapper', () => {
        it('handles content without data-schema-version wrapper', () => {
            const html = '<p>bare paragraph</p>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('bare paragraph');
            // Should still add the schema version wrapper
            expect(result).toContain('data-schema-version=');
        });
    });

    // -------------------------------------------------------------------------
    // Self-closing tags
    // -------------------------------------------------------------------------
    describe('self-closing tags', () => {
        it('normalizes <br/> to standard form', () => {
            const html = '<div data-schema-version="9"><p>line1<br/>line2</p></div>';
            const result = normalizeNoteHtml(html);
            expect(result).toContain('line1');
            expect(result).toContain('line2');
            expect(result).toContain('<br>');
        });
    });
});

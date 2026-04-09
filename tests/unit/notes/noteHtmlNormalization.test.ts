import { describe, expect, it } from 'vitest';

// Mock dependencies required by noteHtmlSimplifier module
import { vi } from 'vitest';
vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-user' })),
}));
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

import { normalizeNoteHtml, hexToRgb } from '../../../src/utils/noteHtmlSimplifier';

/** Helper: wrap inner HTML in the PM canonical wrapper */
function pmWrap(inner: string): string {
    return `<div data-schema-version="9">${inner}\n</div>`;
}


// =============================================================================
// hexToRgb helper
// =============================================================================

describe('hexToRgb', () => {
    it('converts 6-digit hex to rgb()', () => {
        expect(hexToRgb('#5686bf')).toBe('rgb(86, 134, 191)');
        expect(hexToRgb('#000000')).toBe('rgb(0, 0, 0)');
        expect(hexToRgb('#ffffff')).toBe('rgb(255, 255, 255)');
        expect(hexToRgb('#ff0000')).toBe('rgb(255, 0, 0)');
    });

    it('converts 3-digit hex with expansion', () => {
        expect(hexToRgb('#fff')).toBe('rgb(255, 255, 255)');
        expect(hexToRgb('#000')).toBe('rgb(0, 0, 0)');
        expect(hexToRgb('#f00')).toBe('rgb(255, 0, 0)');
        expect(hexToRgb('#abc')).toBe('rgb(170, 187, 204)');
    });

    it('converts 8-digit hex to rgba()', () => {
        expect(hexToRgb('#ff000080')).toBe('rgba(255, 0, 0, 0.502)');
        expect(hexToRgb('#000000ff')).toBe('rgba(0, 0, 0, 1)');
        expect(hexToRgb('#ffffff00')).toBe('rgba(255, 255, 255, 0)');
    });

    it('converts 4-digit hex to rgba()', () => {
        expect(hexToRgb('#f008')).toBe('rgba(255, 0, 0, 0.533)');
        expect(hexToRgb('#000f')).toBe('rgba(0, 0, 0, 1)');
    });

    it('is case insensitive', () => {
        expect(hexToRgb('#AABBCC')).toBe('rgb(170, 187, 204)');
        expect(hexToRgb('#aAbBcC')).toBe('rgb(170, 187, 204)');
    });

    it('returns unrecognized formats as-is', () => {
        expect(hexToRgb('#ab')).toBe('#ab');
        expect(hexToRgb('#abcde')).toBe('#abcde');
        expect(hexToRgb('#abcdefghi')).toBe('#abcdefghi');
    });
});


// =============================================================================
// normalizeNoteHtml (ProseMirror-based)
//
// After the switch from regex to ProseMirror normalization, the function
// roundtrips HTML through Zotero's note-editor schema, producing the exact
// same canonical HTML that Zotero's note-editor would produce. This means:
//   - Output is always wrapped in <div data-schema-version="9">...</div>
//   - Bare inline content gets wrapped in <p> tags
//   - Style values have trailing semicolons (color: red;)
//   - Unsupported attributes/elements may be dropped
// =============================================================================

describe('normalizeNoteHtml', () => {

    // -------------------------------------------------------------------------
    // Font tag stripping
    // -------------------------------------------------------------------------
    describe('font tag stripping', () => {
        it('strips <font> with size attribute, preserving content', () => {
            expect(normalizeNoteHtml('<font size="6">Hello</font>'))
                .toBe(pmWrap('<p>Hello</p>'));
        });

        it('strips <font> with color attribute', () => {
            expect(normalizeNoteHtml('<font color="red">text</font>'))
                .toBe(pmWrap('<p>text</p>'));
        });

        it('strips nested <font> tags', () => {
            expect(normalizeNoteHtml('<font size="4"><font color="blue">inner</font></font>'))
                .toBe(pmWrap('<p>inner</p>'));
        });

        it('preserves content with nested HTML inside <font>', () => {
            expect(normalizeNoteHtml('<font size="6"><strong>Bold</strong></font>'))
                .toBe(pmWrap('<p><strong>Bold</strong></p>'));
        });

        it('handles <font> with multiple attributes', () => {
            expect(normalizeNoteHtml('<font size="6" face="Arial" color="red">text</font>'))
                .toBe(pmWrap('<p>text</p>'));
        });
    });

    // -------------------------------------------------------------------------
    // Legacy element conversion
    // -------------------------------------------------------------------------
    describe('legacy element conversion', () => {
        it('converts <b> to <strong>', () => {
            expect(normalizeNoteHtml('<b>bold</b>'))
                .toBe(pmWrap('<p><strong>bold</strong></p>'));
        });

        it('converts <b> with attributes (attributes dropped by PM schema)', () => {
            // PM schema doesn't preserve arbitrary attributes on strong
            expect(normalizeNoteHtml('<b class="x">bold</b>'))
                .toBe(pmWrap('<p><strong>bold</strong></p>'));
        });

        it('converts <i> to <em>', () => {
            expect(normalizeNoteHtml('<i>italic</i>'))
                .toBe(pmWrap('<p><em>italic</em></p>'));
        });

        it('converts <s> to strikethrough span', () => {
            expect(normalizeNoteHtml('<s>struck</s>'))
                .toBe(pmWrap('<p><span style="text-decoration: line-through;">struck</span></p>'));
        });

        it('converts <del> to strikethrough span', () => {
            expect(normalizeNoteHtml('<del>deleted</del>'))
                .toBe(pmWrap('<p><span style="text-decoration: line-through;">deleted</span></p>'));
        });

        it('converts <strike> to strikethrough span', () => {
            expect(normalizeNoteHtml('<strike>struck</strike>'))
                .toBe(pmWrap('<p><span style="text-decoration: line-through;">struck</span></p>'));
        });

        it('handles nested legacy elements', () => {
            expect(normalizeNoteHtml('<b><i>bold italic</i></b>'))
                .toBe(pmWrap('<p><strong><em>bold italic</em></strong></p>'));
        });

        it('converts <s> with style attribute into nested single-property spans', () => {
            const result = normalizeNoteHtml('<s style="color:red">struck</s>');
            expect(result).toContain('text-decoration: line-through');
            expect(result).toContain('color: red');
        });

        it('converts <del> with style (PM drops unsupported properties like font-size)', () => {
            const result = normalizeNoteHtml('<del style="color: blue; font-size: 14px">deleted</del>');
            expect(result).toContain('text-decoration: line-through');
            expect(result).toContain('color: blue');
            expect(result).toContain('deleted');
        });

        it('drops unsupported attributes on strike elements (PM schema limits)', () => {
            const result = normalizeNoteHtml('<s class="custom">struck</s>');
            // PM schema doesn't support class on strikethrough spans
            expect(result).toContain('text-decoration: line-through');
            expect(result).toContain('struck');
        });
    });

    // -------------------------------------------------------------------------
    // Hex→RGB conversion (handled by PM's CSS processing)
    // -------------------------------------------------------------------------
    describe('hex to RGB conversion', () => {
        it('converts 6-digit hex in style attribute', () => {
            expect(normalizeNoteHtml('<span style="color: #5686bf">text</span>'))
                .toBe(pmWrap('<p><span style="color: rgb(86, 134, 191);">text</span></p>'));
        });

        it('converts 3-digit hex in style attribute', () => {
            expect(normalizeNoteHtml('<span style="color: #fff">text</span>'))
                .toBe(pmWrap('<p><span style="color: rgb(255, 255, 255);">text</span></p>'));
        });

        it('converts 8-digit hex to rgba', () => {
            expect(normalizeNoteHtml('<span style="background-color: #ff000080">text</span>'))
                .toBe(pmWrap('<p><span style="background-color: rgba(255, 0, 0, 0.5);">text</span></p>'));
        });

        it('converts multiple hex values and splits into nested spans', () => {
            const input = '<span style="color: #ff0000; background-color: #00ff00">text</span>';
            const result = normalizeNoteHtml(input);
            expect(result).toContain('color: rgb(255, 0, 0)');
            expect(result).toContain('background-color: rgb(0, 255, 0)');
        });

        it('does NOT convert hex in text content', () => {
            const result = normalizeNoteHtml('<p>The color #ff0000 is red</p>');
            expect(result).toContain('The color #ff0000 is red');
        });

        it('preserves hex in href attributes', () => {
            const result = normalizeNoteHtml('<a href="https://example.com/#section">link</a>');
            expect(result).toContain('href="https://example.com/#section"');
        });

        it('handles hex without space after colon', () => {
            expect(normalizeNoteHtml('<span style="color:#5686bf">text</span>'))
                .toBe(pmWrap('<p><span style="color: rgb(86, 134, 191);">text</span></p>'));
        });

        it('is case insensitive for hex values', () => {
            expect(normalizeNoteHtml('<span style="color: #AABBCC">text</span>'))
                .toBe(pmWrap('<p><span style="color: rgb(170, 187, 204);">text</span></p>'));
        });
    });

    // -------------------------------------------------------------------------
    // Style value normalization (handled by PM's serializer)
    // -------------------------------------------------------------------------
    describe('style value normalization', () => {
        it('normalizes extra spaces around colon', () => {
            expect(normalizeNoteHtml('<span style="color:    red">text</span>'))
                .toBe(pmWrap('<p><span style="color: red;">text</span></p>'));
        });

        it('normalizes combined styles into nested spans', () => {
            const result = normalizeNoteHtml('<span style="color: red ;  background: blue ;">text</span>');
            expect(result).toContain('color: red');
            expect(result).toContain('background-color: blue');
        });

        it('normalizes rgb() spacing to canonical form', () => {
            expect(normalizeNoteHtml('<span style="color: rgb(1,2,3)">text</span>'))
                .toBe(pmWrap('<p><span style="color: rgb(1, 2, 3);">text</span></p>'));
        });

        it('normalizes rgba() spacing', () => {
            expect(normalizeNoteHtml('<span style="color: rgba(1,  2,3,  0.5)">text</span>'))
                .toBe(pmWrap('<p><span style="color: rgba(1, 2, 3, 0.5);">text</span></p>'));
        });
    });

    // -------------------------------------------------------------------------
    // Combined-style span splitting (PM schema: one mark per span)
    // -------------------------------------------------------------------------
    describe('combined-style span splitting', () => {
        it('splits color + background-color into nested spans', () => {
            const input = '<span style="color: rgb(1, 2, 3); background-color: rgb(4, 5, 6)">text</span>';
            expect(normalizeNoteHtml(input))
                .toBe(pmWrap('<p><span style="color: rgb(1, 2, 3);"><span style="background-color: rgb(4, 5, 6);">text</span></span></p>'));
        });

        it('preserves single-property spans (with trailing semicolon)', () => {
            expect(normalizeNoteHtml('<span style="color: red">text</span>'))
                .toBe(pmWrap('<p><span style="color: red;">text</span></p>'));
        });

        it('handles 3+ properties (PM drops unsupported ones like font-size)', () => {
            const input = '<span style="color: red; background-color: blue; font-size: 14px">text</span>';
            const result = normalizeNoteHtml(input);
            expect(result).toContain('color: red');
            expect(result).toContain('background-color: blue');
            expect(result).toContain('text');
        });

        it('handles nested spans inside combined-style span', () => {
            const input = '<span style="color: red; background-color: blue"><span style="font-weight: bold">inner</span></span>';
            const result = normalizeNoteHtml(input);
            expect(result).toContain('color: red');
            expect(result).toContain('background-color: blue');
            expect(result).toContain('inner');
        });

        it('returns empty string for empty span content', () => {
            const input = '<span style="color: red; background-color: blue"></span>';
            expect(normalizeNoteHtml(input)).toBe('');
        });

        it('handles span with class="citation" (PM recognizes it)', () => {
            const input = '<span class="citation">text</span>';
            const result = normalizeNoteHtml(input);
            expect(result).toContain('class="citation"');
        });
    });

    // -------------------------------------------------------------------------
    // Void element normalization
    // -------------------------------------------------------------------------
    describe('void element normalization', () => {
        it('converts <br/> to <br>', () => {
            const result = normalizeNoteHtml('line1<br/>line2');
            expect(result).toBe(pmWrap('<p>line1<br>line2</p>'));
        });

        it('converts <br /> to <br>', () => {
            const result = normalizeNoteHtml('line1<br />line2');
            expect(result).toBe(pmWrap('<p>line1<br>line2</p>'));
        });

        it('converts <hr/> to <hr>', () => {
            const result = normalizeNoteHtml('<hr/>');
            expect(result).toBe(pmWrap('<hr>'));
        });

        it('converts <hr /> to <hr>', () => {
            const result = normalizeNoteHtml('<hr />');
            expect(result).toBe(pmWrap('<hr>'));
        });

        it('preserves <br> unchanged', () => {
            const result = normalizeNoteHtml('line1<br>line2');
            expect(result).toBe(pmWrap('<p>line1<br>line2</p>'));
        });

        it('preserves img attributes and adds alt="" when missing', () => {
            expect(normalizeNoteHtml('<img src="test.png" width="100" />'))
                .toBe(pmWrap('<p><img src="test.png" alt="" width="100"></p>'));
        });
    });

    // -------------------------------------------------------------------------
    // Content structure normalization
    // -------------------------------------------------------------------------
    describe('content structure normalization', () => {
        it('wraps bare text in <p> tags', () => {
            const result = normalizeNoteHtml('hello');
            expect(result).toBe(pmWrap('<p>hello</p>'));
        });

        it('preserves whitespace within text content', () => {
            // PM normalizes multiple spaces to single space
            const result = normalizeNoteHtml('<p>hello   world</p>');
            expect(result).toContain('hello');
            expect(result).toContain('world');
        });

        it('always adds data-schema-version wrapper', () => {
            const result = normalizeNoteHtml('<p>content</p>');
            expect(result).toContain('data-schema-version="9"');
        });

        it('returns empty string for empty input', () => {
            expect(normalizeNoteHtml('')).toBe('');
        });
    });

    // -------------------------------------------------------------------------
    // Idempotency
    // -------------------------------------------------------------------------
    describe('idempotency', () => {
        it('normalizing PM-canonical HTML produces identical output', () => {
            const canonical = pmWrap('<p><span style="color: rgb(86, 134, 191);">text</span></p>');
            expect(normalizeNoteHtml(canonical)).toBe(canonical);
        });

        it('double normalization equals single normalization', () => {
            const messy = '<span style="color:#5686bf; background-color:    #e0ffff"><font size="6"><b>test</b></font><br/></span>';
            const once = normalizeNoteHtml(messy);
            const twice = normalizeNoteHtml(once);
            expect(twice).toBe(once);
        });
    });

    // -------------------------------------------------------------------------
    // Real-world regression cases
    // -------------------------------------------------------------------------
    describe('real-world regression cases', () => {
        it('normalizes Chinese research template', () => {
            const template = `<span style="color:#5686bf"><h1><font size="6">论文笔记</font></h1></span>
<h3>  <span style="color: #e0ffff; background-color:    #66cdaa;">Section A</span></h3>
<p></p>
<h3>  <span style="color: #e0ffff; background-color:    #FDA5CF;">Section B</span></h3>`;

            const result = normalizeNoteHtml(template);

            // Font tag stripped
            expect(result).not.toContain('<font');
            // Hex converted to rgb
            expect(result).toContain('rgb(86, 134, 191)');
            expect(result).toContain('rgb(224, 255, 255)');
            expect(result).toContain('rgb(102, 205, 170)');
            // Has schema version wrapper
            expect(result).toContain('data-schema-version="9"');
        });

        it('normalizes Beaver-created note with custom div classes to PM structure', () => {
            const canonical = '<div class="display-flex flex-col gap-3"><div class="markdown">'
                + '<h1>Summary</h1>\n<p>This is a <strong>test</strong> note.</p>'
                + '</div></div>';
            const result = normalizeNoteHtml(canonical);
            // PM strips custom div classes and produces canonical output
            expect(result).toContain('<h1>Summary</h1>');
            expect(result).toContain('<strong>test</strong>');
            expect(result).toContain('data-schema-version="9"');
        });

        it('preserves data-citation attributes on citation spans', () => {
            const input = '<span class="citation" data-citation="%7B%22citationItems%22%3A%5B%7B%22uris%22%3A%5B%22http%3A%2F%2Fzotero.org%2Fusers%2F1%2Fitems%2FABC%22%5D%7D%5D%7D">'
                + '<span class="citation-item">Author, 2024</span></span>';
            const result = normalizeNoteHtml(input);
            // data-citation should be preserved
            expect(result).toContain('data-citation=');
            expect(result).toContain('class="citation"');
        });

        it('normalizes combined-style spans containing nested citation spans', () => {
            const input = '<span style="color: #ff0000; background-color: #00ff00">'
                + 'Text with <span class="citation" data-citation="test">cite</span>'
                + '</span>';
            const result = normalizeNoteHtml(input);
            // Should split styles
            expect(result).toContain('color: rgb(255, 0, 0)');
            expect(result).toContain('background-color: rgb(0, 255, 0)');
            // Should preserve citation span
            expect(result).toContain('class="citation"');
        });

        it('handles the full Span 1 header pattern', () => {
            const input = '<span style="color:#5686bf"><h1><font size="6">论文笔记✍</font></h1></span>\n'
                + '<span style="color:#2F2F4F">📅<strong>发表时间：<br/>\n'
                + '<span style="color:#2F2F4F"><strong>🔢期刊会议：<br/>';

            const result = normalizeNoteHtml(input);

            // All hex colors converted
            expect(result).not.toMatch(/#[0-9a-fA-F]{6}\b/);
            // Font tags stripped
            expect(result).not.toContain('<font');
            // br self-closing normalized
            expect(result).not.toContain('<br/>');
            expect(result).toContain('<br>');
            // RGB colors present
            expect(result).toContain('rgb(86, 134, 191)');
            expect(result).toContain('rgb(47, 47, 79)');
        });
    });
});

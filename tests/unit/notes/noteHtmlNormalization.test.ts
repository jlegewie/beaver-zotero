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
// normalizeNoteHtml
// =============================================================================

describe('normalizeNoteHtml', () => {

    // -------------------------------------------------------------------------
    // Step 1: Font tag stripping
    // -------------------------------------------------------------------------
    describe('font tag stripping', () => {
        it('strips <font> with size attribute, preserving content', () => {
            expect(normalizeNoteHtml('<font size="6">Hello</font>'))
                .toBe('Hello');
        });

        it('strips <font> with color attribute', () => {
            expect(normalizeNoteHtml('<font color="red">text</font>'))
                .toBe('text');
        });

        it('strips nested <font> tags', () => {
            expect(normalizeNoteHtml('<font size="4"><font color="blue">inner</font></font>'))
                .toBe('inner');
        });

        it('preserves content with nested HTML inside <font>', () => {
            expect(normalizeNoteHtml('<font size="6"><strong>Bold</strong></font>'))
                .toBe('<strong>Bold</strong>');
        });

        it('handles <font> with multiple attributes', () => {
            expect(normalizeNoteHtml('<font size="6" face="Arial" color="red">text</font>'))
                .toBe('text');
        });
    });

    // -------------------------------------------------------------------------
    // Step 2: Legacy element conversion
    // -------------------------------------------------------------------------
    describe('legacy element conversion', () => {
        it('converts <b> to <strong>', () => {
            expect(normalizeNoteHtml('<b>bold</b>'))
                .toBe('<strong>bold</strong>');
        });

        it('converts <b> with attributes', () => {
            expect(normalizeNoteHtml('<b class="x">bold</b>'))
                .toBe('<strong class="x">bold</strong>');
        });

        it('converts <i> to <em>', () => {
            expect(normalizeNoteHtml('<i>italic</i>'))
                .toBe('<em>italic</em>');
        });

        it('converts <s> to strikethrough span', () => {
            expect(normalizeNoteHtml('<s>struck</s>'))
                .toBe('<span style="text-decoration: line-through">struck</span>');
        });

        it('converts <del> to strikethrough span', () => {
            expect(normalizeNoteHtml('<del>deleted</del>'))
                .toBe('<span style="text-decoration: line-through">deleted</span>');
        });

        it('converts <strike> to strikethrough span', () => {
            expect(normalizeNoteHtml('<strike>struck</strike>'))
                .toBe('<span style="text-decoration: line-through">struck</span>');
        });

        it('handles nested legacy elements', () => {
            const input = '<b><i>bold italic</i></b>';
            const expected = '<strong><em>bold italic</em></strong>';
            expect(normalizeNoteHtml(input)).toBe(expected);
        });
    });

    // -------------------------------------------------------------------------
    // Step 3: Hex→RGB conversion
    // -------------------------------------------------------------------------
    describe('hex to RGB conversion', () => {
        it('converts 6-digit hex in style attribute', () => {
            expect(normalizeNoteHtml('<span style="color: #5686bf">text</span>'))
                .toBe('<span style="color: rgb(86, 134, 191)">text</span>');
        });

        it('converts 3-digit hex in style attribute', () => {
            expect(normalizeNoteHtml('<span style="color: #fff">text</span>'))
                .toBe('<span style="color: rgb(255, 255, 255)">text</span>');
        });

        it('converts 8-digit hex to rgba', () => {
            expect(normalizeNoteHtml('<span style="background-color: #ff000080">text</span>'))
                .toBe('<span style="background-color: rgba(255, 0, 0, 0.502)">text</span>');
        });

        it('converts multiple hex values in one style', () => {
            const input = '<span style="color: #ff0000; background-color: #00ff00">text</span>';
            expect(normalizeNoteHtml(input))
                .toContain('color: rgb(255, 0, 0)');
            // Note: combined styles also get split in step 5
        });

        it('does NOT convert hex in data-citation attributes', () => {
            const input = '<span data-citation="%7B%22color%22%3A%22%23ff0000%22%7D" style="color: #ff0000">text</span>';
            const result = normalizeNoteHtml(input);
            // data-citation should still have the hex reference (URL-encoded)
            expect(result).toContain('data-citation="%7B%22color%22%3A%22%23ff0000%22%7D"');
            // style should be converted
            expect(result).toContain('rgb(255, 0, 0)');
        });

        it('does NOT convert hex in text content', () => {
            const input = '<p>The color #ff0000 is red</p>';
            expect(normalizeNoteHtml(input)).toBe('<p>The color #ff0000 is red</p>');
        });

        it('does NOT convert hex in href attributes', () => {
            const input = '<a href="https://example.com/#section">link</a>';
            expect(normalizeNoteHtml(input)).toBe('<a href="https://example.com/#section">link</a>');
        });

        it('handles hex without space after colon', () => {
            expect(normalizeNoteHtml('<span style="color:#5686bf">text</span>'))
                .toBe('<span style="color: rgb(86, 134, 191)">text</span>');
        });

        it('is case insensitive for hex values', () => {
            expect(normalizeNoteHtml('<span style="color: #AABBCC">text</span>'))
                .toBe('<span style="color: rgb(170, 187, 204)">text</span>');
        });
    });

    // -------------------------------------------------------------------------
    // Step 4: Style value whitespace normalization
    // -------------------------------------------------------------------------
    describe('style value whitespace normalization', () => {
        it('normalizes extra spaces around colon', () => {
            expect(normalizeNoteHtml('<span style="color:    red">text</span>'))
                .toBe('<span style="color: red">text</span>');
        });

        it('normalizes extra spaces around semicolons', () => {
            expect(normalizeNoteHtml('<span style="color: red ;  background: blue ;">text</span>'))
                .toContain('color: red');
        });

        it('normalizes rgb() spacing to canonical form', () => {
            expect(normalizeNoteHtml('<span style="color: rgb(1,2,3)">text</span>'))
                .toBe('<span style="color: rgb(1, 2, 3)">text</span>');
        });

        it('normalizes rgba() spacing', () => {
            expect(normalizeNoteHtml('<span style="color: rgba(1,  2,3,  0.5)">text</span>'))
                .toBe('<span style="color: rgba(1, 2, 3, 0.5)">text</span>');
        });
    });

    // -------------------------------------------------------------------------
    // Step 5: Combined-style span splitting
    // -------------------------------------------------------------------------
    describe('combined-style span splitting', () => {
        it('splits color + background-color into nested spans', () => {
            const input = '<span style="color: rgb(1, 2, 3); background-color: rgb(4, 5, 6)">text</span>';
            const expected = '<span style="color: rgb(1, 2, 3)"><span style="background-color: rgb(4, 5, 6)">text</span></span>';
            expect(normalizeNoteHtml(input)).toBe(expected);
        });

        it('preserves single-property spans unchanged', () => {
            const input = '<span style="color: red">text</span>';
            expect(normalizeNoteHtml(input)).toBe('<span style="color: red">text</span>');
        });

        it('handles 3+ properties', () => {
            const input = '<span style="color: red; background-color: blue; font-size: 14px">text</span>';
            const result = normalizeNoteHtml(input);
            expect(result).toContain('<span style="color: red">');
            expect(result).toContain('<span style="background-color: blue">');
            expect(result).toContain('<span style="font-size: 14px">');
            expect(result).toContain('text');
            // Should have 3 closing tags
            expect(result).toMatch(/<\/span><\/span><\/span>$/);
        });

        it('preserves non-style attributes on outermost span', () => {
            const input = '<span class="highlight" style="color: red; background-color: blue">text</span>';
            const result = normalizeNoteHtml(input);
            expect(result).toMatch(/^<span class="highlight" style="color: red">/);
            expect(result).toContain('<span style="background-color: blue">');
        });

        it('handles nested spans inside the combined-style span', () => {
            const input = '<span style="color: red; background-color: blue"><span style="font-weight: bold">inner</span></span>';
            const result = normalizeNoteHtml(input);
            expect(result).toContain('<span style="color: red">');
            expect(result).toContain('<span style="background-color: blue">');
            expect(result).toContain('<span style="font-weight: bold">inner</span>');
        });

        it('handles empty span content', () => {
            const input = '<span style="color: red; background-color: blue"></span>';
            const result = normalizeNoteHtml(input);
            expect(result).toBe('<span style="color: red"><span style="background-color: blue"></span></span>');
        });

        it('does not split spans without style attribute', () => {
            const input = '<span class="citation">text</span>';
            expect(normalizeNoteHtml(input)).toBe(input);
        });
    });

    // -------------------------------------------------------------------------
    // Step 6: Void element normalization
    // -------------------------------------------------------------------------
    describe('void element normalization', () => {
        it('converts <br/> to <br>', () => {
            expect(normalizeNoteHtml('line1<br/>line2'))
                .toBe('line1<br>line2');
        });

        it('converts <br /> to <br>', () => {
            expect(normalizeNoteHtml('line1<br />line2'))
                .toBe('line1<br>line2');
        });

        it('converts <hr/> to <hr>', () => {
            expect(normalizeNoteHtml('<hr/>'))
                .toBe('<hr>');
        });

        it('converts <hr /> to <hr>', () => {
            expect(normalizeNoteHtml('<hr />'))
                .toBe('<hr>');
        });

        it('preserves <br> unchanged', () => {
            expect(normalizeNoteHtml('line1<br>line2'))
                .toBe('line1<br>line2');
        });

        it('preserves img attributes when normalizing', () => {
            expect(normalizeNoteHtml('<img src="test.png" width="100" />'))
                .toBe('<img src="test.png" width="100">');
        });
    });

    // -------------------------------------------------------------------------
    // Step 7: Inter-element whitespace
    // -------------------------------------------------------------------------
    describe('inter-element whitespace', () => {
        it('collapses spaces between closing and opening tags', () => {
            expect(normalizeNoteHtml('</h3>  <span>'))
                .toBe('</h3><span>');
        });

        it('collapses tabs between tags', () => {
            expect(normalizeNoteHtml('</h3>\t\t<span>'))
                .toBe('</h3><span>');
        });

        it('preserves newlines between tags', () => {
            expect(normalizeNoteHtml('</h3>\n<span>'))
                .toBe('</h3>\n<span>');
        });

        it('preserves mixed newline + space (only collapses spaces)', () => {
            // Newline is preserved, trailing spaces after newline are in next "segment"
            const input = '</p>\n  <p>';
            const result = normalizeNoteHtml(input);
            // The regex />[ \t]+</g only matches horizontal whitespace between > and <
            // So "\n  " is not all between > and < — the \n breaks it
            expect(result).toContain('</p>\n');
        });

        it('does not collapse whitespace inside text content', () => {
            expect(normalizeNoteHtml('<p>hello   world</p>'))
                .toBe('<p>hello   world</p>');
        });
    });

    // -------------------------------------------------------------------------
    // Idempotency
    // -------------------------------------------------------------------------
    describe('idempotency', () => {
        it('normalizing already-normalized HTML produces identical output', () => {
            const canonical = '<span style="color: rgb(86, 134, 191)">text</span>';
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
        it('normalizes Chinese research template (Span 1/5/7 pattern)', () => {
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
            // Combined styles split
            expect(result).not.toMatch(/style="[^"]*;[^"]*"/); // no semicolons in style
            // Inter-element whitespace collapsed
            expect(result).not.toMatch(/>  </);
        });

        it('leaves Beaver-created note (already canonical) unchanged except void elements', () => {
            const canonical = '<div class="display-flex flex-col gap-3"><div class="markdown">'
                + '<h1>Summary</h1>\n<p>This is a <strong>test</strong> note.</p>'
                + '</div></div>';
            expect(normalizeNoteHtml(canonical)).toBe(canonical);
        });

        it('preserves data-citation and data-annotation attributes', () => {
            const input = '<span class="citation" data-citation="%7B%22citationItems%22%3A%5B%7B%22uris%22%3A%5B%22http%3A%2F%2Fzotero.org%2Fusers%2F1%2Fitems%2FABC%22%5D%7D%5D%7D">'
                + '<span class="citation-item">Author, 2024</span></span>';
            const result = normalizeNoteHtml(input);
            // data-citation should be preserved exactly
            expect(result).toContain('data-citation="%7B%22citationItems');
        });

        it('normalizes combined-style spans containing nested citation spans', () => {
            const input = '<span style="color: #ff0000; background-color: #00ff00">'
                + 'Text with <span class="citation" data-citation="test">cite</span>'
                + '</span>';
            const result = normalizeNoteHtml(input);
            // Should split styles
            expect(result).toContain('<span style="color: rgb(255, 0, 0)">');
            expect(result).toContain('<span style="background-color: rgb(0, 255, 0)">');
            // Should preserve citation span
            expect(result).toContain('<span class="citation" data-citation="test">cite</span>');
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

import { describe, expect, it } from 'vitest';
import { codeRanges } from '@beaver/agent-export/parse/markdown';
import {
    maskNoteCitationTags,
    maskRenderedCitationTags,
    unmaskNoteCitationTags,
} from '../../../src/utils/noteCitationMask';

const noCode = () => [] as Array<[number, number]>;

describe('maskNoteCitationTags', () => {
    it('replaces every citation tag form with a placeholder and keeps the tags in order', () => {
        const masked = maskNoteCitationTags(
            'A <citation id="1-AAAA1111" loc="page5"/> B <citation id="1-BBBB2222"> C <citation id="1-CCCC3333"></citation>',
            noCode,
        );

        expect(masked.text).not.toContain('<citation');
        expect(masked.tags).toEqual([
            '<citation id="1-AAAA1111" loc="page5"/>',
            '<citation id="1-BBBB2222"/>',
            '<citation id="1-CCCC3333"/>',
        ]);
    });

    it('unwraps tag-only backtick spans the same way the Markdown renderer does', () => {
        const masked = maskNoteCitationTags('Claim `<citation id="1-AAAA1111"/>`.', codeRanges);

        expect(masked.tags).toEqual(['<citation id="1-AAAA1111"/>']);
        expect(masked.literals).toEqual([]);
        expect(masked.text).not.toContain('`');
    });

    it('rewrites single-quoted and escaped attributes in the double-quoted form the expander reads', () => {
        const masked = maskNoteCitationTags(`A <citation external_id='W1' loc='page5'/> B <citation id=\\"u-AAAA1111\\"/>`, noCode);

        expect(masked.tags).toEqual([
            '<citation external_id="W1" loc="page5"/>',
            '<citation id="u-AAAA1111"/>',
        ]);
    });

    it('escapes a double quote inside a single-quoted value', () => {
        expect(maskNoteCitationTags(`<citation id='u-A"B'/>`, noCode).tags).toEqual(['<citation id="u-A&quot;B"/>']);
    });

    it('masks tags in code as verbatim literals, decided by the code-range finder', () => {
        const content = 'Use `example <citation id="u-EXAMPLE1"/> here` and\n\n    <citation id=\'u-EXAMPLE2\'/>\n\nReal <citation id="u-AAAA1111"/>';

        const masked = maskNoteCitationTags(content, codeRanges);

        expect(masked.tags).toEqual(['<citation id="u-AAAA1111"/>']);
        expect(masked.literals).toEqual(['<citation id="u-EXAMPLE1"/>', '<citation id=\'u-EXAMPLE2\'/>']);
        expect(masked.text).not.toContain('<citation');
    });

    it('keeps a Markdown-escaped tag literal, absorbing the escaping backslash', () => {
        const masked = maskNoteCitationTags('Write \\<citation id="u-EXAMPLE1"/> to cite.', noCode);

        expect(masked.tags).toEqual([]);
        expect(masked.literals).toEqual(['<citation id="u-EXAMPLE1"/>']);
        expect(masked.text).not.toContain('\\');
        expect(unmaskNoteCitationTags(masked.text, masked)).toBe('Write &lt;citation id=&quot;u-EXAMPLE1&quot;/&gt; to cite.');
    });

    it('treats a tag after an escaped backslash as a citation', () => {
        const masked = maskNoteCitationTags('Path \\\\<citation id="u-AAAA1111"/>', noCode);

        expect(masked.tags).toEqual(['<citation id="u-AAAA1111"/>']);
        expect(masked.text.startsWith('Path \\\\\u27E6')).toBe(true);
    });

    it('delimits placeholders with punctuation so adjacent emphasis still closes', () => {
        expect(maskNoteCitationTags('_word_<citation id="1-AAAA1111"/>', noCode).text).toMatch(/^_word_⟦[A-Z0-9]+⟧$/);
    });

    it('picks a prefix that does not occur in the content', () => {
        const masked = maskNoteCitationTags('BEAVERNOTECITATION <citation id="1-AAAA1111"/>', noCode);

        expect(masked.prefix).not.toBe('BEAVERNOTECITATION');
        expect(unmaskNoteCitationTags(masked.text, masked)).toBe('BEAVERNOTECITATION <citation id="1-AAAA1111"/>');
    });

    it('is deterministic', () => {
        const content = '# H\n\nText <citation id="1-AAAA1111"/> `<citation id="u-X"/> x`';
        expect(maskNoteCitationTags(content, codeRanges)).toEqual(maskNoteCitationTags(content, codeRanges));
    });

    it('leaves content without citations untouched', () => {
        expect(maskNoteCitationTags('**bold** `code`', codeRanges)).toMatchObject({ text: '**bold** `code`', tags: [], literals: [] });
    });
});

describe('maskRenderedCitationTags', () => {
    it('takes every tag in rendered HTML as a citation, since code there is already escaped text', () => {
        const masked = maskRenderedCitationTags(
            '<p>Real <citation id="u-AAAA1111"/></p><pre><code>&lt;citation id=&quot;u-EXAMPLE1&quot;/&gt;</code></pre>',
        );

        expect(masked.tags).toEqual(['<citation id="u-AAAA1111"/>']);
        expect(masked.text).toContain('&lt;citation id=&quot;u-EXAMPLE1&quot;/&gt;');
    });
});

describe('maskRenderedCitationTags escapes', () => {
    it('does not read a backslash in rendered HTML as a Markdown escape', () => {
        expect(maskRenderedCitationTags('<p>\\<citation id="u-AAAA1111"/></p>').tags).toEqual(['<citation id="u-AAAA1111"/>']);
    });
});

describe('unmaskNoteCitationTags', () => {
    it('substitutes each placeholder through the replacer, wherever rendering moved it', () => {
        const masked = maskNoteCitationTags('**A** <citation id="1-AAAA1111"/> and <citation id="1-BBBB2222"/>', noCode);
        const rendered = `<p><strong>A</strong> ${masked.text.slice('**A** '.length)}</p>`;

        const html = unmaskNoteCitationTags(rendered, masked, (_tag, index) => `[cite ${index}]`);

        expect(html).toBe('<p><strong>A</strong> [cite 0] and [cite 1]</p>');
    });

    it('restores citation tags by default and code literals as escaped text', () => {
        const masked = maskNoteCitationTags('Text <citation id="1-AAAA1111" ref="c_AAAA1111_0"/> `x <citation id=\'u-X\'/>`', codeRanges);

        expect(unmaskNoteCitationTags(masked.text, masked))
            .toBe('Text <citation id="1-AAAA1111" ref="c_AAAA1111_0"/> `x &lt;citation id=&#x27;u-X&#x27;/&gt;`');
    });
});

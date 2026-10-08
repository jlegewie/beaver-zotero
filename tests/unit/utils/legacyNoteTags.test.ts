/**
 * Legacy `<note>` sections from threads written before note creation moved to
 * the `create_note` tool. Nothing renders them as a block any more, so reopening
 * such a thread must still show their body as markdown: the tags are unwrapped
 * before parsing, because CommonMark starts a raw HTML block at an opening tag
 * that no blank line follows and would hand the reader literal markup.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-ui/chat/Citation', () => ({
    default: () => null,
}));

import { unwrapLegacyNoteTags } from '../../../react/utils/legacyNoteTags';
import MarkdownRenderer from '../../../react/components/messages/MarkdownRenderer';

const render = (content: string): string =>
    renderToStaticMarkup(React.createElement(MarkdownRenderer, { content }));

describe('unwrapLegacyNoteTags', () => {
    it('leaves text without a note tag untouched', () => {
        const text = 'Just an answer with a [link](https://example.com).';
        expect(unwrapLegacyNoteTags(text)).toBe(text);
    });

    it('turns the title into a heading and the tags into rules', () => {
        expect(unwrapLegacyNoteTags('Before <note title="Summary">Body</note> after')).toBe(
            'Before \n\n---\n## Summary\n\nBody\n\n---\n after',
        );
    });

    // Parity with the renderer that used to display these sections: it required
    // attributes on the opening tag and only looked for a closing tag once one
    // had matched, so the forms below reached the reader as written.
    describe('markup that was never a note section', () => {
        it('leaves a bare tag in prose alone', () => {
            expect(unwrapLegacyNoteTags('Use <note> in prose.')).toBe('Use <note> in prose.');
        });

        it('leaves markdown-escaped tags alone', () => {
            expect(unwrapLegacyNoteTags('Use \\<note> and \\</note>')).toBe(
                'Use \\<note> and \\</note>',
            );
            expect(unwrapLegacyNoteTags('Use \\<note title="T"> here.')).toBe(
                'Use \\<note title="T"> here.',
            );
        });

        it('still unwraps a tag behind an escaped backslash', () => {
            expect(unwrapLegacyNoteTags('Use \\\\<note title="T">Body</note>')).toBe(
                'Use \\\\\n\n---\n## T\n\nBody\n\n---\n',
            );
        });

        it('leaves a closing tag with nothing open alone', () => {
            expect(unwrapLegacyNoteTags('Tail of a note.</note>\n\nAfter.')).toBe(
                'Tail of a note.</note>\n\nAfter.',
            );
        });

        it('does not match a different tag that starts with note', () => {
            expect(unwrapLegacyNoteTags('My <notebook foo="1"> thing')).toBe(
                'My <notebook foo="1"> thing',
            );
        });
    });

    it('leaves note tags written inside code examples alone', () => {
        const fenced = 'Example:\n\n```xml\n<note title="T">Body</note>\n```\n\nAnd `<note>` inline.';
        expect(unwrapLegacyNoteTags(fenced)).toBe(fenced);
    });

    it('leaves a note tag inside an indented code block alone', () => {
        const indented = 'Example:\n\n    <note title="T">Body</note>\n\nAfter.';
        expect(unwrapLegacyNoteTags(indented)).toBe(indented);
    });

    it('does not let an unclosed tag in code consume a later real note', () => {
        expect(
            unwrapLegacyNoteTags('Write `<note>` like this.\n\n<note title="Real">Body</note>'),
        ).toBe('Write `<note>` like this.\n\n\n\n---\n## Real\n\nBody\n\n---\n');
    });

    // The body of an opening tag no blank line follows parses as one raw HTML
    // block, so a scan of the text as written finds no code inside it at all.
    describe('code in a body the opening tag runs straight into', () => {
        it('keeps an inline code span', () => {
            expect(unwrapLegacyNoteTags('<note title="T">\nUse `<note>` here.\n</note>')).toBe(
                '\n\n---\n## T\n\n\nUse `<note>` here.\n\n\n---\n',
            );
        });

        it('keeps a fenced block', () => {
            expect(
                unwrapLegacyNoteTags('<note title="T">\n```xml\n<note title="x">b</note>\n```\n</note>'),
            ).toBe('\n\n---\n## T\n\n\n```xml\n<note title="x">b</note>\n```\n\n\n---\n');
        });
    });

    it('keeps an unterminated note to the end of the text', () => {
        expect(unwrapLegacyNoteTags('<note title="T">Still writing')).toBe(
            '\n\n---\n## T\n\nStill writing',
        );
    });
});

describe('MarkdownRenderer on legacy note sections', () => {
    it('parses a body that follows the opening tag with no blank line', () => {
        // The shape the models actually wrote: tag, newline, content.
        const html = render('<note title="Summary">\n# Summary\n- First\n</note>');

        expect(html).toContain('<h2>Summary</h2>');
        expect(html).toContain('<h1>Summary</h1>');
        expect(html).toContain('<li>First</li>');
        expect(html).not.toContain('# Summary');
        expect(html).not.toContain('- First');
    });

    it('keeps markdown links inside a note body clickable', () => {
        const html = render('<note title="T">\nSee [docs](https://example.com) here.\n</note>');

        expect(html).toContain('href="https://example.com"');
        expect(html).not.toContain('[docs]');
    });

    it('still renders a note tag inside a code example as code', () => {
        const html = render('Use this:\n\n```xml\n<note title="T">Body</note>\n```');

        expect(html).toContain('<code');
        expect(html).toContain('&lt;note title=&quot;T&quot;&gt;Body&lt;/note&gt;');
        expect(html).not.toContain('<hr');
    });
});

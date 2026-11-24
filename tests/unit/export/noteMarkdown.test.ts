/**
 * Note Markdown renders through the chat's Markdown pipeline, without React or
 * a window, with its citations left as `<citation …/>` tags for the plugin
 * realm to expand. Whether a tag is a citation or a code example is decided by
 * the Markdown grammar itself, so examples in any form of code stay code.
 */
import { describe, expect, it } from 'vitest';
import { codeRanges } from '@beaver/agent-export/parse/markdown';
import { renderNoteMarkdownHtml } from '@beaver/agent-export/render/noteHtml';
import { renderNoteMarkdown } from '../../../src/services/export/noteMarkdown';

const render = async (content: string) => renderNoteMarkdown({ codeRanges, renderNoteMarkdownHtml }, content);

describe('renderNoteMarkdown', () => {
    it('returns citations as canonical tags, never through the chat citation renderer', async () => {
        const html = await render("**Claim** <citation id='u-AAAA1111' loc='page5'/> and `<citation id=\"u-BBBB2222\"/>`.");

        expect(html).toContain('<strong>Claim</strong> <citation id="u-AAAA1111" loc="page5"/> and <citation id="u-BBBB2222"/>.');
    });

    it.each([
        ['an inline code span', 'Use `example <citation id="u-EXAMPLE1"/> here` like so.'],
        ['an indented code block', 'Example:\n\n    <citation id="u-EXAMPLE1"/>\n'],
        ['a fenced code block', '```html\n<citation id="u-EXAMPLE1"/>\n```'],
        ['a fence inside a blockquote', '> ```\n> <citation id="u-EXAMPLE1"/>\n> ```'],
        ['a fence opened on a list-item line', '- ```\n  <citation id="u-EXAMPLE1"/>\n  ```'],
        ['a top-level fence containing a quoted fence line', '~~~\n> ~~~\n<citation id="u-EXAMPLE1"/>\n~~~'],
    ])('keeps a tag in %s as escaped code text', async (_case, example) => {
        const html = await render(`${example}\n\nReal <citation id="u-AAAA1111"/>.`);

        expect(html).toContain('&lt;citation id=&quot;u-EXAMPLE1&quot;/&gt;');
        expect(html).toContain('Real <citation id="u-AAAA1111"/>.');
        expect(html.match(/<citation /g)).toHaveLength(1);
    });

    it('keeps a Markdown-escaped tag as text, as Markdown shows it', async () => {
        const html = await render('Write \\<citation id="u-EXAMPLE1"/> to cite.\n\nReal <citation id="u-AAAA1111"/>.');

        expect(html).toContain('Write &lt;citation id=&quot;u-EXAMPLE1&quot;/&gt; to cite.');
        expect(html.match(/<citation /g)).toHaveLength(1);
    });

    it('keeps a tag after an escaped backslash a citation', async () => {
        const html = await render('Path \\\\<citation id="u-AAAA1111"/>.');

        expect(html).toContain('Path \\<citation id="u-AAAA1111"/>.');
    });

    it('keeps the text after a citation tag split by an invisible character', async () => {
        const html = await render('Claim <cita\u200Btion id="u-AAAA1111"/> tail. More.');

        expect(html).toContain('tail. More.');
        expect(html).not.toContain('<citation');
    });

    it('treats a nested list paragraph indented four spaces as prose, not code', async () => {
        const html = await render('1. Item\n\n    Claim <citation id="u-AAAA1111"/>.');

        expect(html).toContain('Claim <citation id="u-AAAA1111"/>.');
    });
});

describe('renderNoteMarkdown footnotes', () => {
    it('writes footnotes as endnotes a note can hold', async () => {
        const html = await render('Claim.[^a] Another <citation id="u-AAAA1111"/>.[^2]\n\n[^a]: First *note* <citation id="u-BBBB2222" loc="page4"/>.\n[^2]: Second note.\n');

        // References are plain superscript numbers.
        expect(html).toContain('<p>Claim.<sup>1</sup> Another <citation id="u-AAAA1111"/>.<sup>2</sup></p>');
        // Definitions are a visible list under a "Notes" heading, citations kept.
        expect(html).toContain('<h2>Notes</h2>');
        expect(html).toMatch(/<ol>\s*<li>\s*<p>First <em>note<\/em> <citation id="u-BBBB2222" loc="page4"\/>\.<\/p>\s*<\/li>\s*<li>\s*<p>Second note\.<\/p>/);
        // No in-note anchors, back-references or the hidden chat heading.
        expect(html).not.toMatch(/href="#|↩|data-footnote|Footnotes|sr-only|id="user-content/);
    });

    it('leaves no trailing space where several back-references were removed', async () => {
        const html = await render('First[^a] and again[^a].\n\n[^a]: Note A para one.\n\n    Note A para two.\n');

        expect(html).toContain('<p>First<sup>1</sup> and again<sup>1</sup>.</p>');
        expect(html).toContain('<p>Note A para two.</p>');
        expect(html).not.toMatch(/↩|href="#/);
    });
});

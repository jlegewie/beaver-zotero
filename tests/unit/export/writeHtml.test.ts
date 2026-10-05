import { describe, expect, it } from 'vitest';
import { parseExportSource } from '@beaver/agent-export/parse/parseExportDoc';
import { writeHtml } from '@beaver/agent-export/html/writeHtml';
import { sanitizeCslHtml } from '@beaver/agent-export/html/escape';
import { paperSize } from '@beaver/agent-export/page';
import type { ExportDoc, FormattedCitations, FormattedCluster } from '@beaver/agent-export/types';

function cluster(html: string, noteIndex = 0): FormattedCluster {
    return {
        html,
        plain: html.replace(/<[^>]+>/g, ''),
        noteIndex,
        items: [{ id: 7, uris: ['http://zotero.org/users/1/items/AAAAAAAA'], itemData: { id: 7, type: 'book', title: 'T' } }],
        fallbackTexts: [],
    };
}

function citations(doc: ExportDoc, styleClass: 'in-text' | 'note', overrides: Partial<FormattedCitations> = {}): FormattedCitations {
    return {
        styleId: 'http://www.zotero.org/styles/apa',
        locale: 'en-US',
        styleClass,
        clusters: doc.clusters.map((_, index) => cluster('(Smith, <i>2004</i>)', styleClass === 'note' ? index + 1 : 0)),
        bibliography: {
            entries: ['<div class="csl-entry">Smith, J. (2004). <i>Title</i>.</div>', '<div class="csl-entry">Zed, A. (2010). Other.</div>'],
            layout: { indent: 720, firstLineIndent: -720, lineSpacing: 480, entrySpacing: 240, tabStops: [] },
        },
        documentData: null,
        ...overrides,
    };
}

const options = { linkItems: false, bibliographyTitle: 'References', notesTitle: 'Notes' };

/** The body's visible text, one line per block. */
const visibleText = (html: string) => html
    .replace(/^[\s\S]*<body>/, '')
    .replace(/<annotation[\s\S]*?<\/annotation>/g, '')
    .replace(/<\/(p|h[1-6]|li|div|tr)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\n+/g, '\n');

describe('writeHtml', () => {
    const markdown = 'Claim <citation id="u-AAAAAAAA" loc="page3"/>. Second claim<citation id="u-BBBBBBBB"/>.\n\n'
        + '# Heading\n\n- one\n- two\n\n3. third\n\n| A | B |\n|:--|--:|\n| 1 | 2 |\n\n> quoted\n\n'
        + '[web](https://example.com) and [item](u-CCCCCCCC)\n\n$$x^2$$\n\n```\ncode <b>\n```';

    it('writes a self-contained page that loads nothing', () => {
        const doc = parseExportSource({ title: 'A <b>title</b>', blocks: [{ type: 'markdown', markdown }] });
        const { html } = writeHtml({ doc, citations: citations(doc, 'in-text'), options });
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
        expect(html).toContain('<title>A &lt;b&gt;title&lt;/b&gt;</title>');
        expect(html).toContain('<h1 class="doc-title">A &lt;b&gt;title&lt;/b&gt;</h1>');
        expect(html).not.toMatch(/<script|<img|<link/);
        expect(html).toContain('<html lang="en-US">');
    });

    it('maps markdown structure to HTML', () => {
        const doc = parseExportSource({ title: 'Export', blocks: [{ type: 'markdown', markdown }] });
        const { html, stats } = writeHtml({ doc, citations: citations(doc, 'in-text'), options });
        expect(html).toContain('<h1>Heading</h1>');
        expect(html).toContain('<ul>\n<li><p>one</p>');
        expect(html).toContain('<ol start="3">');
        expect(html).toContain('<thead><tr><th>A</th><th style="text-align:right">B</th></tr></thead>');
        expect(html).toContain('<blockquote>\n<p>quoted</p>');
        expect(html).toContain('<pre><code>code &lt;b&gt;</code></pre>');
        expect(html).toContain('<a href="https://example.com">web</a>');
        // Item links are text unless asked for.
        expect(html).toContain(' and item</p>');
        expect(html).toMatch(/<div class="math-display"><span class="katex"><math[^>]*display="block"/);
        expect(stats.equations).toBe(1);
    });

    it('links item references when asked', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: '[item](u-CCCCCCCC)' }] });
        const { html } = writeHtml({ doc, citations: citations(doc, 'in-text'), options: { ...options, linkItems: true } });
        expect(html).toContain('<a href="zotero://select/library/items/CCCCCCCC">item</a>');
    });

    it('writes in-text citations and the bibliography with its layout', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown }] });
        const { html, stats } = writeHtml({ doc, citations: citations(doc, 'in-text'), options });
        const text = visibleText(html);
        expect(text).toContain('Claim (Smith, 2004).');
        // A space is inserted before a citation glued to the previous word.
        expect(text).toContain('Second claim (Smith, 2004).');
        expect(text).toContain('References\nSmith, J. (2004). Title.\nZed, A. (2010). Other.');
        expect(html).toContain('<span class="citation">(Smith, <i>2004</i>)</span>');
        expect(html).toContain('.csl-entry { padding-left: 36pt; text-indent: -36pt; line-height: 2; margin-bottom: 12pt; }');
        expect(stats.citations).toBe(2);
        expect(stats.notes).toBe(0);
    });

    it('turns note-style citations into endnotes numbered with markdown footnotes', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'One <citation id="u-AAAAAAAA"/>. Two[^n] <citation id="u-BBBBBBBB"/>.\n\n[^n]: A note.' }] });
        const { html, stats } = writeHtml({ doc, citations: citations(doc, 'note'), options: { ...options, bibliographyTitle: 'Bibliography' } });
        expect(stats.notes).toBe(3);
        // The mark follows the word directly.
        expect(html).toContain('One<sup class="note-ref">1</sup>. Two<sup class="note-ref">2</sup><sup class="note-ref">3</sup>.');
        const text = visibleText(html);
        expect(text).toContain('Notes\n(Smith, 2004)\nA note.\n(Smith, 2004)\nBibliography');
        expect(html).toContain('<li value="3"><p><span class="citation">');
        // Notes come before the bibliography.
        expect(html.indexOf('class="notes"')).toBeLessThan(html.indexOf('class="bibliography"'));
    });

    it('writes markdown footnotes as endnotes for in-text styles, once per note', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'A[^n] B[^n].\n\n[^n]: Note <citation id="u-AAAAAAAA"/>.' }] });
        const { html, stats } = writeHtml({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options });
        expect(stats.notes).toBe(1);
        expect(html).toContain('A<sup class="note-ref">1</sup> B<sup class="note-ref">1</sup>.');
        expect(visibleText(html)).toContain('Notes\nNote (Smith, 2004).');
    });

    it('writes citations the processor could not format as plain text', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'File <citation id="ext-ABCD1234"/>.' }] });
        const formatted = citations(doc, 'note', {
            clusters: [{ html: '', plain: '', noteIndex: 0, items: [], fallbackTexts: ['(data.csv, p. 2)'] }],
            bibliography: null,
        });
        const { html, stats } = writeHtml({ doc, citations: formatted, options });
        expect(visibleText(html)).toContain('File (data.csv, p. 2).');
        expect(stats.notes).toBe(0);
    });

    it('escapes model text and sanitizes citation processor HTML', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'Text with <script>alert(1)</script> and <citation id="u-AAAAAAAA"/>.' }] });
        const formatted = citations(doc, 'in-text', { bibliography: null });
        formatted.clusters[0] = cluster('(<b onclick="x()">Smith</b>, <a href="javascript:alert(1)">2004</a><img src="https://x.test/a.png">)');
        const { html } = writeHtml({ doc, citations: formatted, options });
        expect(html).not.toMatch(/<script|onclick|javascript:|<img/);
        expect(html).toContain('<span class="citation">(<b>Smith</b>, 2004)</span>');
    });

    it('writes images as their alt text, without loading them', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: '![A chart](https://example.com/chart.png)' }] });
        const { html } = writeHtml({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options });
        expect(html).toContain('<em>A chart</em>');
        expect(html).not.toContain('chart.png');
    });

    it('writes a user prompt and tool activity distinctly', () => {
        const doc = parseExportSource({ title: '', blocks: [
            { type: 'user', text: 'Summarize' },
            { type: 'activity', calls: ['Searched "networks"'] },
            { type: 'note', title: 'My note', markdown: 'Body' },
        ] });
        const { html } = writeHtml({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options });
        expect(html).toContain('<p class="prompt-label">User</p>\n<div class="prompt">\n<p>Summarize</p>');
        expect(html).toContain('<div class="activity">\n<p>Searched “networks”</p>');
        expect(html).toContain('<h1>My note</h1>\n<p>Body</p>');
    });

    it('reports equations exported as text', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: '$$\\frac{a}{$$' }] });
        const result = writeHtml({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options });
        expect(result.warnings).toEqual([expect.objectContaining({ code: 'math_as_text', count: 1 })]);
        expect(result.html).toContain('<code class="math-source">\\frac{a}{</code>');
    });

    it('sizes the label column of numbered bibliographies to the tab stop', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'A <citation id="u-AAAAAAAA"/>.' }] });
        const formatted = citations(doc, 'in-text', {
            bibliography: {
                entries: ['<div class="csl-entry">\n  <div class="csl-left-margin">[1]</div><div class="csl-right-inline">Entry</div>\n</div>'],
                layout: { indent: 384, firstLineIndent: -384, lineSpacing: 240, entrySpacing: 0, tabStops: [384] },
            },
        });
        const { html } = writeHtml({ doc, citations: formatted, options });
        expect(html).toContain('.csl-left-margin { min-width: 19.2pt; padding-right: 0; }');
        expect(html).toContain('<div class="csl-entry"><div class="csl-left-margin">[1]</div><div class="csl-right-inline">Entry</div></div>');
    });

    it('keeps headings on the page of the text that follows them', () => {
        const doc = parseExportSource({ title: '', blocks: [
            { type: 'markdown', markdown: '# One\n\n## Two\n\nText <citation id="u-AAAAAAAA"/>.\n\n# Alone\n\n- list' },
            { type: 'note', title: 'Note', markdown: 'Body[^n].\n\n[^n]: A note.' },
        ] });
        const { html } = writeHtml({ doc, citations: citations(doc, 'in-text'), options });
        expect(html).toContain('<div class="keep">\n<h1>One</h1>\n<h2>Two</h2>\n<p>Text');
        expect(html).toContain('<h1>Alone</h1>\n<ul>');
        expect(html).toContain('<div class="keep">\n<h1>Note</h1>\n<p>Body');
        expect(html).toContain('<div class="keep">\n<h1>Notes</h1>\n<ol>\n<li value="1"><p>A note.</p>');
        expect(html).toContain('<div class="keep">\n<h1>References</h1>\n<div class="csl-entry">Smith');
        expect(html).not.toContain('<section');
    });

    it('picks the paper size from the citation locale', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'A' }] });
        expect(writeHtml({ doc, citations: citations(doc, 'in-text'), options }).page).toEqual({ size: 'letter', margin: 1, pageNumbers: true });
        expect(writeHtml({ doc, citations: citations(doc, 'in-text', { locale: 'de-DE' }), options }).page.size).toBe('a4');
    });
});

describe('sanitizeCslHtml', () => {
    it('keeps the formatting subset and drops everything else', () => {
        expect(sanitizeCslHtml('<i>a</i> <b>b</b> <sup>1</sup> <span style="font-variant:small-caps;color:red">c</span>'))
            .toBe('<i>a</i> <b>b</b> <sup>1</sup> <span style="font-variant:small-caps">c</span>');
        expect(sanitizeCslHtml('<span style="color:red">x</span><em>y</em>')).toBe('x<i>y</i>');
        expect(sanitizeCslHtml('<div class="csl-entry other" style="x">e</div>')).toBe('<div class="csl-entry">e</div>');
    });

    it('keeps only web links, and none where links cannot nest', () => {
        expect(sanitizeCslHtml('<a href="https://doi.org/10.1/x?a=1&amp;b=2">doi</a>'))
            .toBe('<a href="https://doi.org/10.1/x?a=1&amp;b=2">doi</a>');
        expect(sanitizeCslHtml('<a href="javascript:x()">j</a>')).toBe('j');
        expect(sanitizeCslHtml('<a href="https://x.test">x</a>', { links: false })).toBe('x');
    });

    it('decodes and re-escapes text and balances tags', () => {
        expect(sanitizeCslHtml('A &#38; B &lt;c&gt; <i>open')).toBe('A &amp; B &lt;c&gt; <i>open</i>');
        expect(sanitizeCslHtml('<i><b>x</i>y')).toBe('<i><b>x</b></i>y');
    });
});

describe('paperSize', () => {
    it('uses Letter for US and Canadian English and A4 elsewhere', () => {
        expect(paperSize('en-US')).toBe('letter');
        expect(paperSize('en-CA')).toBe('letter');
        expect(paperSize('en-GB')).toBe('a4');
        expect(paperSize('en-US', 'a4')).toBe('a4');
    });
});

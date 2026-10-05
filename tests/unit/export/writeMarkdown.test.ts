import { describe, expect, it } from 'vitest';
import { parseExportSource } from '@beaver/agent-export/parse/parseExportDoc';
import { segmentsToInlines, writeMarkdown } from '@beaver/agent-export/markdown/writeMarkdown';
import { parseCslHtml } from '@beaver/agent-export/citations/inlineHtml';
import type { ExportDoc, FormattedCitations, FormattedCluster, MarkdownExportOptions } from '@beaver/agent-export/types';

function cluster(html: string): FormattedCluster {
    return {
        html,
        plain: html.replace(/<[^>]+>/g, ''),
        noteIndex: 0,
        items: [{ id: 7, uris: ['http://zotero.org/users/1/items/AAAAAAAA'], itemData: { id: 7 } }],
        fallbackTexts: [],
    };
}

function citations(doc: ExportDoc, styleClass: 'in-text' | 'note', overrides: Partial<FormattedCitations> = {}): FormattedCitations {
    return {
        styleId: 'http://www.zotero.org/styles/apa',
        locale: 'en-US',
        styleClass,
        clusters: doc.clusters.map(() => cluster('(Smith, <i>2004</i>)')),
        bibliography: {
            entries: ['<div class="csl-entry">Smith, J. (2004). <i>A *starred* title</i>.</div>', '<div class="csl-entry">Zed, A. (2010). Other.</div>'],
            layout: { indent: 720, firstLineIndent: -720, lineSpacing: 480, entrySpacing: 240, tabStops: [] },
        },
        documentData: null,
        ...overrides,
    };
}

const options: MarkdownExportOptions = { linkItems: false, bibliographyTitle: 'References', frontMatter: null };

function write(markdown: string, styleClass: 'in-text' | 'note' = 'in-text', extra: Partial<MarkdownExportOptions> = {}, overrides: Partial<FormattedCitations> = {}) {
    const doc = parseExportSource({ title: 'Export', blocks: [{ type: 'markdown', markdown }] });
    return writeMarkdown({ doc, citations: citations(doc, styleClass, overrides), options: { ...options, ...extra } });
}

describe('writeMarkdown', () => {
    it('keeps markdown structure in one consistent style', () => {
        const { markdown, stats } = write('Intro *em* __strong__ ~~gone~~ `code`.\n\n## Heading\n\n* one\n* two\n\n3. third\n\n| A | B |\n|:--|--:|\n| 1 | 2 |\n\n> quoted\n\n$$x^2$$\n\nInline $y$.\n\n```js\nlet a = 1;\n```\n\n- [x] done', 'in-text', {}, { bibliography: null });
        expect(markdown).toBe([
            '# Export',
            '',
            'Intro *em* **strong** ~~gone~~ `code`.',
            '',
            '## Heading',
            '',
            '- one',
            '- two',
            '',
            '3. third',
            '',
            '| A  |  B |',
            '| :- | -: |',
            '| 1  |  2 |',
            '',
            '> quoted',
            '',
            '$$',
            'x^2',
            '$$',
            '',
            'Inline $y$.',
            '',
            '```js',
            'let a = 1;',
            '```',
            '',
            '- [x] done',
            '',
        ].join('\n'));
        expect(stats.equations).toBe(2);
    });

    it('writes in-text citations as formatted text and the bibliography after the body', () => {
        const { markdown, stats } = write('Claim <citation id="u-AAAAAAAA" loc="page3"/>. Second claim<citation id="u-BBBBBBBB"/>.');
        expect(markdown).toContain('Claim (Smith, *2004*). Second claim (Smith, *2004*).');
        // Processor text is text: markdown characters in it are escaped.
        expect(markdown).toContain('# References\n\nSmith, J. (2004). *A \\*starred\\* title*.\n\nZed, A. (2010). Other.\n');
        expect(markdown.indexOf('Claim')).toBeLessThan(markdown.indexOf('# References'));
        expect(stats.citations).toBe(2);
    });

    it('escapes text that markdown would read as markup', () => {
        const { markdown } = write('Costs \\$5 and \\$6 with a\\_b.');
        expect(markdown).toContain('Costs \\$5 and \\$6 with a\\_b.');
    });

    it('turns note-style citations into footnotes numbered with markdown footnotes', () => {
        const { markdown, stats } = write('One <citation id="u-AAAAAAAA"/>. Two[^x] <citation id="u-BBBBBBBB"/>. Again[^x].\n\n[^x]: A note <citation id="u-CCCCCCCC"/>.', 'note', { bibliographyTitle: 'Bibliography' });
        expect(stats.footnotes).toBe(3);
        expect(markdown).toContain('One[^1]. Two[^2][^3]. Again[^2].');
        // A citation inside a markdown footnote stays inline.
        expect(markdown).toContain('[^1]: (Smith, *2004*)\n\n[^2]: A note (Smith, *2004*).\n\n[^3]: (Smith, *2004*)');
        expect(markdown.indexOf('[^3]:')).toBeLessThan(markdown.indexOf('# Bibliography'));
    });

    it('renumbers footnotes of separate notes into one sequence', () => {
        const doc = parseExportSource({ title: '', blocks: [
            { type: 'note', title: 'First', markdown: 'A[^1].\n\n[^1]: one' },
            { type: 'note', title: 'Second', markdown: 'B[^1].\n\n[^1]: two' },
        ] });
        const { markdown } = writeMarkdown({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options });
        expect(markdown).toBe('# First\n\nA[^1].\n\n# Second\n\nB[^2].\n\n[^1]: one\n\n[^2]: two\n');
    });

    it('writes item links as text unless asked to link them', () => {
        expect(write('See [Smith](u-CCCCCCCC) and [web](https://example.com).').markdown)
            .toContain('See Smith and [web](https://example.com).');
        expect(write('See [Smith](u-CCCCCCCC).', 'in-text', { linkItems: true }).markdown)
            .toContain('See [Smith](zotero://select/library/items/CCCCCCCC).');
    });

    it('moves a note mark out of link text', () => {
        const { markdown } = write('[a link <citation id="u-AAAAAAAA"/>](https://example.com) end.', 'note');
        expect(markdown).toContain('[a link](https://example.com)[^1] end.');
    });

    it('writes YAML front matter instead of the title heading when asked', () => {
        const { markdown } = write('Body.', 'in-text', { frontMatter: { date: '2026-10-05', source: 'zotero://beaver/thread/t/run/r' } }, { bibliography: null });
        expect(markdown).toBe('---\ntitle: "Export"\ndate: "2026-10-05"\nsource: "zotero://beaver/thread/t/run/r"\n---\n\nBody.\n');
    });

    it('writes prompts, activity and notes as sections', () => {
        const doc = parseExportSource({ title: 'Thread', blocks: [
            { type: 'user', text: 'Question?' },
            { type: 'markdown', markdown: 'Looking.' },
            { type: 'activity', calls: ['Searched "networks"'] },
            { type: 'note', title: 'Summary', markdown: 'Text.' },
        ] });
        const { markdown } = writeMarkdown({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options });
        expect(markdown).toBe('# Thread\n\n**User**\n\n> Question?\n\nLooking.\n\n*Searched “networks”*\n\n# Summary\n\nText.\n');
    });

    it('keeps citations the processor could not format as plain text', () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'File <citation id="ext-ABCD1234"/>.' }] });
        const { markdown } = writeMarkdown({
            doc,
            citations: citations(doc, 'note', {
                clusters: [{ html: '', plain: '', noteIndex: 0, items: [], fallbackTexts: ['(data.csv, p. 2)'] }],
                bibliography: null,
            }),
            options,
        });
        expect(markdown).toBe('File (data.csv, p. 2).\n');
    });
});

describe('segmentsToInlines', () => {
    it('keeps whitespace outside emphasis and writes superscripts as HTML', () => {
        const nodes = segmentsToInlines(parseCslHtml('<i>Title </i>vol<sup>2</sup>'), { links: true });
        expect(nodes).toEqual([
            { type: 'emphasis', children: [{ type: 'text', value: 'Title' }] },
            { type: 'text', value: ' ' },
            { type: 'text', value: 'vol' },
            { type: 'html', value: '<sup>2</sup>' },
        ]);
    });
});

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseNoteDoc, type PmNode } from '@beaver/agent-export/note/parseNoteDoc';
import { writeDocx } from '@beaver/agent-export/docx/writeDocx';
import { writeHtml } from '@beaver/agent-export/html/writeHtml';
import { writeLatex } from '@beaver/agent-export/latex/writeLatex';
import { writeMarkdown } from '@beaver/agent-export/markdown/writeMarkdown';
import type { ExportDoc, ExportImage, FormattedCitations } from '@beaver/agent-export/types';

/** A 1×1 PNG. */
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const IMAGES: Record<string, ExportImage> = { 'image-1': { mime: 'image/png', data: PNG, width: 1200, height: 600 } };

const text = (value: string, marks?: PmNode['marks']): PmNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content: PmNode[]): PmNode => ({ type: 'paragraph', content });
const cell = (type: 'table_cell' | 'table_header', content: PmNode[], attrs: Record<string, unknown> = {}): PmNode =>
    ({ type, attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null, ...attrs }, content });

/** A note with a user-inserted citation, formatting, an image and a table with spans. */
const NOTE: PmNode = {
    type: 'doc',
    content: [
        { type: 'heading', attrs: { level: 1 }, content: [text('Notes')] },
        { type: 'paragraph', attrs: { align: 'center', dir: 'rtl' }, content: [
            text('Claim '),
            { type: 'citation', attrs: { citation: { citationItems: [{
                uris: ['http://zotero.org/users/1/items/SMITH001'], locator: '3', label: 'chapter', prefix: 'see', suffix: 'emphasis added', 'suppress-author': true,
            }], properties: {} } } },
            text('. H'),
            text('2', [{ type: 'subsup', attrs: { type: 'sub' } }]),
            text('O '),
            text('under', [{ type: 'underline', attrs: { color: '#5fb236' } }]),
            text(' '),
            text('red', [{ type: 'textColor', attrs: { color: '#ff2020' } }]),
            text(' '),
            text('marked', [{ type: 'backgroundColor', attrs: { color: '#ffd40080' } }]),
        ] },
        paragraph({ type: 'image', attrs: { attachmentKey: 'IMG00001', width: 300, height: null } }),
        { type: 'table', content: [
            { type: 'table_row', content: [cell('table_cell', [paragraph(text('A'))], { rowspan: 2 }), cell('table_cell', [paragraph(text('B'))])] },
            { type: 'table_row', content: [cell('table_cell', [paragraph(text('C')), { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('x'))] }] }], { background: '#ffd400' })] },
            { type: 'table_row', content: [cell('table_cell', [paragraph(text('wide'))], { colspan: 2 })] },
        ] },
    ],
};

function citationsFor(doc: ExportDoc): FormattedCitations {
    return {
        styleId: 'http://www.zotero.org/styles/apa',
        locale: 'en-US',
        styleClass: 'in-text',
        citationFormat: 'author-date',
        clusters: doc.clusters.map(() => ({
            html: '(see 2020, chap. 3 emphasis added)',
            plain: '(see 2020, chap. 3 emphasis added)',
            rtf: '(see 2020, chap. 3 emphasis added)',
            noteIndex: 0,
            items: [{
                id: 7, uris: ['http://zotero.org/users/1/items/SMITH001'], itemData: { id: 7, type: 'book' },
                locator: '3', label: 'chapter', prefix: 'see', suffix: 'emphasis added', suppressAuthor: true,
            }],
            fallbackTexts: [],
        })),
        bibliography: null,
        documentData: '<data data-version="3"/>',
    };
}

describe('note documents in every format', () => {
    const doc = parseNoteDoc(NOTE);

    it('writes Word: field with the stored citation fields, formatting, layout, image and spanning cells', async () => {
        const { bytes } = await writeDocx({
            doc, citations: citationsFor(doc), options: { liveCitations: true, linkItems: true, bibliographyTitle: 'References' }, images: IMAGES,
        });
        const zip = await JSZip.loadAsync(bytes);
        const document = await zip.file('word/document.xml')!.async('string');
        const field = /ADDIN ZOTERO_ITEM CSL_CITATION (\{.*?\}) <\/w:instrText>/.exec(document.replace(/&quot;/g, '"'))![1];
        expect(JSON.parse(field).citationItems[0]).toMatchObject({
            locator: '3', label: 'chapter', prefix: 'see', suffix: 'emphasis added', 'suppress-author': true,
        });
        expect(document).toContain('<w:u w:val="single" w:color="5FB236"/>');
        expect(document).toContain('<w:color w:val="FF2020"/>');
        // #ffd400 at 50% (0x80) on white.
        expect(document).toMatch(/<w:shd [^>]*w:fill="FFE97F"/);
        expect(document).toContain('<w:vertAlign w:val="subscript"/>');
        expect(document).toContain('<w:jc w:val="center"/>');
        expect(document).toContain('<w:bidi/>');
        // The image at the note's width (300 CSS px = 2857500 EMU), aspect kept.
        expect(document).toContain('<wp:extent cx="2857500" cy="1428750"/>');
        expect(Object.keys(zip.files).some(name => name.startsWith('word/media/'))).toBe(true);
        expect(document).toContain('<w:vMerge w:val="restart"/>');
        expect(document).toContain('<w:vMerge w:val="continue"/>');
        expect(document).toContain('<w:gridSpan w:val="2"/>');
        expect(document).toMatch(/<w:shd [^>]*w:fill="FFD400"/);
    });

    it('writes HTML for PDF: embedded image, spans, formatting and layout', () => {
        const { html } = writeHtml({
            doc, citations: citationsFor(doc), options: { linkItems: false, bibliographyTitle: 'References', notesTitle: 'Notes' }, images: IMAGES,
        });
        expect(html).toContain("img-src data:");
        expect(html).toMatch(/<img class="note-image" src="data:image\/png;base64,iVBORw0KGgo[^"]*" alt="" style="width:300px;max-width:100%;height:auto">/);
        expect(html).toContain('<p style="text-align:center" dir="rtl">Claim');
        expect(html).toContain('H<sub>2</sub>O');
        expect(html).toContain('<u style="text-decoration-color:#5fb236">under</u>');
        expect(html).toContain('<span style="color:#ff2020">red</span>');
        expect(html).toContain('<span style="background-color:#ffe97f">marked</span>');
        expect(html).toContain('<td rowspan="2"><p>A</p>');
        expect(html).toContain('<td colspan="2"><p>wide</p>');
        expect(html).toContain('<td style="background-color:#ffd400"><p>C</p>\n<ul>');
        // No header cells: no table head.
        expect(html).not.toMatch(/<table class="note-table">\n<thead>/);
    });

    it('writes LaTeX: prenote, labelled postnote and starred cite; images, colors and spanning cells', () => {
        const write = (citationPackage: 'biblatex' | 'natbib') => writeLatex({
            doc,
            citations: citationsFor(doc),
            keys: { 7: 'smith2020' },
            options: { citationPackage, standalone: true, bibFileName: 'refs.bib', linkItems: false, bibliographyTitle: 'References', date: '' },
            images: { 'image-1': { ...IMAGES['image-1'], path: 'notes-figures/image-1.png' } },
        });
        const { tex, warnings } = write('biblatex');
        expect(tex).toContain('\\parencite*[see][chap.~3 emphasis added]{smith2020}');
        expect(write('natbib').tex).toContain('\\citeyearpar[see][chap.~3 emphasis added]{smith2020}');
        // A "]" in a note is braced on its own (natbib strips braces around the whole argument).
        const bracketed = { ...citationsFor(doc) };
        bracketed.clusters = bracketed.clusters.map(cluster => ({ ...cluster, items: cluster.items.map(item => ({ ...item, label: undefined, locator: '7', prefix: undefined, suffix: '[trans.]', suppressAuthor: false })) }));
        const natbib = writeLatex({
            doc, citations: bracketed, keys: { 7: 'smith2020' },
            options: { citationPackage: 'natbib', standalone: false, bibFileName: 'refs.bib', linkItems: false, bibliographyTitle: 'References', date: '' },
        }).tex;
        expect(natbib).toContain('\\citep[p.~7 [trans.{]}]{smith2020}');
        expect(tex).toContain('\\includegraphics[width=\\BeaverImageWidth{3.13in}]{notes-figures/image-1.png}');
        expect(tex).toContain('\\providecommand{\\BeaverImageWidth}');
        expect(tex).toContain('H\\textsubscript{2}O \\uline{under} \\textcolor[HTML]{FF2020}{red} \\BeaverHighlight{BeaverHighlight1}{marked}');
        expect(tex).toContain('\\definecolor{BeaverHighlight1}{HTML}{FFE97F}');
        expect(tex).toContain('\\usepackage[table]{xcolor}');
        // Highlights: lua-ul under LuaLaTeX, soul under pdfLaTeX (soul loses non-ASCII text under the Unicode engines).
        expect(tex).toContain('\\ifLuaTeX\\usepackage{luacolor,lua-ul}\\fi\n\\ifPDFTeX\\usepackage{soul}\\fi');
        expect(tex).toContain('\\providecommand{\\BeaverHighlight}[2]');
        expect(tex).toContain('\\begin{center}\nClaim');
        expect(tex).toMatch(/\\begin\{longtable\}\[l\]\{@\{\}(>\{\\raggedright\\arraybackslash\}p\{[^}]*\}){2}@\{\}\}/);
        expect(tex).toContain('\\multicolumn{2}');
        expect(tex).toContain('\\cellcolor[HTML]{FFD400}C \\par\n\\begin{itemize}');
        expect(warnings).toEqual([expect.objectContaining({ code: 'formatting_simplified', count: 1 })]);
    });

    it('writes biblatex page postnotes as before, and spells out the page when a suffix follows', () => {
        const pageDoc = parseNoteDoc({ type: 'doc', content: [paragraph(text('A '), { type: 'citation', attrs: { citation: { citationItems: [{ uris: ['u'], locator: '12' }] } } })] });
        const citations = citationsFor(pageDoc);
        const write = (item: Record<string, unknown>) => writeLatex({
            doc: pageDoc,
            citations: { ...citations, clusters: [{ ...citations.clusters[0], items: [{ id: 7, uris: ['u'], itemData: {}, ...item }] }] },
            keys: { 7: 'k' },
            options: { citationPackage: 'biblatex', standalone: false, bibFileName: 'refs.bib', linkItems: false, bibliographyTitle: 'References', date: '' },
        }).tex;
        expect(write({ locator: '12', label: 'page' })).toContain('\\parencite[12]{k}');
        expect(write({ locator: '12-14', suffix: 'n. 3' })).toContain('\\parencite[\\ppno~12--14 n. 3]{k}');
        expect(write({ prefix: 'cf.' })).toContain('\\parencite[cf.][]{k}');
        // Zotero suffixes usually start with punctuation, which follows the locator directly.
        expect(write({ locator: '3', label: 'chapter', suffix: ', emphasis added' })).toContain('\\parencite[chap.~3, emphasis added]{k}');
        expect(write({ locator: '5', suffix: ', n. 3' })).toContain('\\parencite[\\pno~5, n. 3]{k}');
        // As citeproc: a space before a suffix starting with a letter, "&", "(" or "[", not a digit.
        expect(write({ locator: '6', suffix: '(emphasis added)' })).toContain('\\parencite[\\pno~6 (emphasis added)]{k}');
        expect(write({ locator: '6', suffix: '2' })).toContain('\\parencite[\\pno~62]{k}');
        expect(write({ locator: '6', suffix: 'și nota 3' })).toContain('\\parencite[\\pno~6 și nota 3]{k}');
    });

    it('keeps a cluster that leaves out one of several authors: natbib per work, biblatex as text', () => {
        const pairDoc = parseNoteDoc({ type: 'doc', content: [paragraph(text('A '), { type: 'citation', attrs: { citation: { citationItems: [{ uris: ['a'] }, { uris: ['b'] }] } } })] });
        const citations = citationsFor(pairDoc);
        const write = (citationPackage: 'biblatex' | 'natbib') => writeLatex({
            doc: pairDoc,
            citations: {
                ...citations,
                clusters: [{
                    ...citations.clusters[0],
                    plain: '(see 2020, 3; Jones 2021)',
                    items: [
                        { id: 1, uris: ['a'], itemData: {}, locator: '3', prefix: 'see', suppressAuthor: true },
                        { id: 2, uris: ['b'], itemData: {} },
                    ],
                }],
            },
            keys: { 1: 'smith', 2: 'jones' },
            options: { citationPackage, standalone: false, bibFileName: 'refs.bib', linkItems: false, bibliographyTitle: 'References', date: '' },
        });
        // natbib's \citeyear drops a prenote, so it is written before the year.
        expect(write('natbib').tex).toContain('\\citetext{see \\citeyear[p.~3]{smith}; \\citealp{jones}}');
        const biblatex = write('biblatex');
        expect(biblatex.tex).toContain('A (see 2020, 3; Jones 2021)\\nocite{smith,jones}');
        expect(biblatex.warnings).toEqual([expect.objectContaining({ code: 'citations_as_text', count: 1 })]);
    });

    it('writes a note-style citation without its author as text with biblatex (\\footcite has no starred form)', () => {
        const citations = { ...citationsFor(doc), styleClass: 'note' as const, citationFormat: 'note' };
        const { tex } = writeLatex({
            doc,
            citations: { ...citations, clusters: citations.clusters.map(cluster => ({ ...cluster, noteIndex: 1 })) },
            keys: { 7: 'smith2020' },
            options: { citationPackage: 'biblatex', standalone: false, bibFileName: 'refs.bib', linkItems: false, bibliographyTitle: 'References', date: '' },
        });
        expect(tex).toContain('\\footnote{(see 2020, chap. 3 emphasis added)}\\nocite{smith2020}');
        expect(tex).not.toContain('\\autocite');
    });

    it('cites with the number in numeric styles, where there is no author to leave out', () => {
        const citations = { ...citationsFor(doc), citationFormat: 'numeric' };
        const { tex } = writeLatex({
            doc, citations, keys: { 7: 'smith2020' },
            options: { citationPackage: 'natbib', standalone: false, bibFileName: 'refs.bib', linkItems: false, bibliographyTitle: 'References', date: '' },
        });
        expect(tex).toContain('\\citep[see][chap.~3 emphasis added]{smith2020}');
        expect(tex).not.toContain('citeyear');
    });

    it('highlights only text soul can take, and names the cell-color option for body-only output', () => {
        const symbols = parseNoteDoc({ type: 'doc', content: [
            paragraph(text('α ≤ β', [{ type: 'backgroundColor', attrs: { color: '#ffd400' } }])),
            { type: 'table', content: [{ type: 'table_row', content: [cell('table_cell', [paragraph(text('x'))], { background: '#ffd400' })] }] },
        ] }, { liftTitle: false });
        const { tex } = writeLatex({
            doc: symbols, citations: citationsFor(symbols), keys: {},
            options: { citationPackage: 'biblatex', standalone: false, bibFileName: null, linkItems: false, bibliographyTitle: 'References', date: '' },
        });
        expect(tex).not.toContain('\\BeaverHighlight{');
        expect(tex).toContain('\\ensuremath{\\alpha}');
        expect(tex).toContain('xcolor (option table)');
    });

    it('writes a table inside a table cell as lines of text in LaTeX', () => {
        const nested = parseNoteDoc({ type: 'doc', content: [{ type: 'table', content: [{ type: 'table_row', content: [cell('table_cell', [
            paragraph(text('outer')),
            { type: 'table', content: [{ type: 'table_row', content: [cell('table_cell', [paragraph(text('a'))]), cell('table_cell', [paragraph(text('b'))])] }] },
        ])] }] }] }, { liftTitle: false });
        const { tex, warnings } = writeLatex({
            doc: nested, citations: citationsFor(nested), keys: {},
            options: { citationPackage: 'biblatex', standalone: false, bibFileName: null, linkItems: false, bibliographyTitle: 'References', date: '' },
        });
        expect(tex).toContain('outer \\par\na \\textbar{} b');
        expect(warnings).toEqual([expect.objectContaining({ code: 'formatting_simplified', count: 1 })]);
    });

    it('flattens a table nested in a list inside a table cell', () => {
        const nested = parseNoteDoc({ type: 'doc', content: [{ type: 'table', content: [{ type: 'table_row', content: [cell('table_cell', [
            { type: 'bulletList', content: [{ type: 'listItem', content: [
                paragraph(text('item')),
                { type: 'table', content: [{ type: 'table_row', content: [cell('table_cell', [paragraph(text('deep'))])] }] },
            ] }] },
        ])] }] }] }, { liftTitle: false });
        const { tex } = writeLatex({
            doc: nested, citations: citationsFor(nested), keys: {},
            options: { citationPackage: 'biblatex', standalone: false, bibFileName: null, linkItems: false, bibliographyTitle: 'References', date: '' },
        });
        expect(tex).toContain('deep');
    });

    it('writes Markdown: image file, sub/superscripts, and a GFM table with spans flattened', () => {
        const { markdown, warnings } = writeMarkdown({
            doc,
            citations: citationsFor(doc),
            options: { linkItems: false, bibliographyTitle: 'References', frontMatter: null },
            images: { 'image-1': { ...IMAGES['image-1'], path: 'notes_files/image-1.png' } },
        });
        expect(markdown).toContain('# Notes');
        expect(markdown).toContain('![](notes_files/image-1.png)');
        expect(markdown).toContain('H<sub>2</sub>O under red marked');
        // No header cells: the first row is the header GFM requires.
        expect(markdown).toContain('| A    | B        |\n| ---- | -------- |\n|      | C<br>• x |\n| wide |          |');
        expect(warnings).toEqual([expect.objectContaining({ code: 'formatting_simplified', count: 1 })]);
    });

    it('keeps a header row in the body when one of its cells spans into the rows below', () => {
        const spanning = parseNoteDoc({ type: 'doc', content: [{ type: 'table', content: [
            { type: 'table_row', content: [cell('table_header', [paragraph(text('A'))], { rowspan: 2 }), cell('table_header', [paragraph(text('B'))])] },
            { type: 'table_row', content: [cell('table_cell', [paragraph(text('C'))])] },
        ] }] }, { liftTitle: false });
        const { html } = writeHtml({ doc: spanning, citations: citationsFor(spanning), options: { linkItems: false, bibliographyTitle: 'R', notesTitle: 'N' } });
        expect(html).not.toContain('<thead>');
        expect(html).toContain('<tbody>\n<tr><th rowspan="2"><p>A</p>\n</th><th><p>B</p>\n</th></tr>\n<tr><td><p>C</p>\n</td></tr>');
    });

    it('keeps a first heading with more than text in the body instead of lifting it into the title', () => {
        const withImage = parseNoteDoc({ type: 'doc', content: [
            { type: 'heading', attrs: { level: 1 }, content: [text('Figure '), { type: 'image', attrs: { attachmentKey: 'IMG00001' } }] },
        ] });
        expect(withImage.title).toBe('');
        expect(withImage.sections[0].children[0]).toMatchObject({ type: 'heading', children: [{ type: 'text' }, { type: 'image', assetId: 'image-1' }] });
    });

    it('keeps line breaks in Markdown table cells and layout on list paragraphs', async () => {
        const noteDoc = parseNoteDoc({ type: 'doc', content: [
            { type: 'table', content: [{ type: 'table_row', content: [cell('table_cell', [paragraph(text('one'), { type: 'hardBreak' }, text('two', [{ type: 'strong' }]), { type: 'hardBreak' }, text('three', [{ type: 'strong' }]))])] }] },
            { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', attrs: { align: 'center', dir: 'rtl' }, content: [text('item')] }] }] },
        ] }, { liftTitle: false });
        const citations = citationsFor(noteDoc);
        const { markdown } = writeMarkdown({ doc: noteDoc, citations, options: { linkItems: false, bibliographyTitle: 'R', frontMatter: null } });
        expect(markdown).toContain('| one<br>**two**<br>**three** |');
        const { html } = writeHtml({ doc: noteDoc, citations, options: { linkItems: false, bibliographyTitle: 'R', notesTitle: 'N' } });
        expect(html).toContain('<li><p style="text-align:center" dir="rtl">item</p>');
        const zip = await JSZip.loadAsync((await writeDocx({ doc: noteDoc, citations, options: { liveCitations: false, linkItems: false, bibliographyTitle: 'R' } })).bytes);
        expect(await zip.file('word/document.xml')!.async('string')).toMatch(/<w:numPr>[\s\S]*?<w:bidi\/><w:jc w:val="center"\/>/);
    });

    it('keeps spaces at the edges of marked text outside the marks, and spaces a following citation once', async () => {
        const spaced = parseNoteDoc({ type: 'doc', content: [paragraph(
            text('cite '),
            text(' and more ', [{ type: 'textColor', attrs: { color: '#e56eee' } }]),
            text('underlined ', [{ type: 'underline', attrs: { color: '' } }]),
            { type: 'citation', attrs: { citation: { citationItems: [{ uris: ['u'] }] } } },
        )] }, { liftTitle: false });
        const citations = citationsFor(spaced);
        const { tex } = writeLatex({
            doc: spaced, citations, keys: { 7: 'k' },
            options: { citationPackage: 'biblatex', standalone: false, bibFileName: 'refs.bib', linkItems: false, bibliographyTitle: 'R', date: '' },
        });
        // xcolor drops a space at the start of \textcolor's argument.
        expect(tex).toContain('cite  \\textcolor[HTML]{E56EEE}{and more} \\uline{underlined} \\parencite*');
        const { markdown } = writeMarkdown({ doc: spaced, citations, options: { linkItems: false, bibliographyTitle: 'R', frontMatter: null } });
        expect(markdown).toContain('underlined (see');
        expect(markdown).not.toContain('underlined  (see');
    });

    it('spaces a citation after bold text once, and keeps Markdown marks free of edge spaces', async () => {
        const marked = parseNoteDoc({ type: 'doc', content: [paragraph(
            text('A '),
            text('struck ', [{ type: 'strike' }]),
            text('word '),
            text('bold text ', [{ type: 'strong' }]),
            { type: 'citation', attrs: { citation: { citationItems: [{ uris: ['u'] }] } } },
            text(' H'),
            text(' 2 ', [{ type: 'subsup', attrs: { type: 'sub' } }]),
            text('O'),
        )] }, { liftTitle: false });
        const citations = citationsFor(marked);
        const { markdown } = writeMarkdown({ doc: marked, citations, options: { linkItems: false, bibliographyTitle: 'R', frontMatter: null } });
        expect(markdown).toContain('A ~~struck~~ word **bold text** (see');
        expect(markdown).toContain('H <sub>2</sub> O');
        const { tex } = writeLatex({
            doc: marked, citations, keys: { 7: 'k' },
            options: { citationPackage: 'biblatex', standalone: false, bibFileName: 'refs.bib', linkItems: false, bibliographyTitle: 'R', date: '' },
        });
        // The bold text's own space separates it from the citation.
        expect(tex).toContain('\\textbf{bold text }\\parencite');
        const { html } = writeHtml({ doc: marked, citations, options: { linkItems: false, bibliographyTitle: 'R', notesTitle: 'N' } });
        expect(html).toContain('<strong>bold text </strong><span class="citation">');
    });

    it('writes local file and Beaver links as their text in every format', async () => {
        const linked = parseNoteDoc({ type: 'doc', content: [paragraph(
            text('file', [{ type: 'link', attrs: { href: 'file:///Users/me/secret.pdf' } }]),
            text(' chat', [{ type: 'link', attrs: { href: 'zotero://beaver/thread/T1' } }]),
        )] }, { liftTitle: false });
        const citations = citationsFor(linked);
        const latex = writeLatex({ doc: linked, citations, keys: {}, options: { citationPackage: 'biblatex', standalone: false, bibFileName: null, linkItems: true, bibliographyTitle: 'R', date: '' } }).tex;
        const markdown = writeMarkdown({ doc: linked, citations, options: { linkItems: true, bibliographyTitle: 'R', frontMatter: null } }).markdown;
        const html = writeHtml({ doc: linked, citations, options: { linkItems: true, bibliographyTitle: 'R', notesTitle: 'N' } }).html;
        const zip = await JSZip.loadAsync((await writeDocx({ doc: linked, citations, options: { liveCitations: false, linkItems: true, bibliographyTitle: 'R' } })).bytes);
        const docx = Object.values(zip.files).map(file => file.name).join(' ') + await zip.file('word/_rels/document.xml.rels')!.async('string');
        for (const output of [latex, markdown, html, docx]) {
            expect(output).not.toContain('secret.pdf');
            expect(output).not.toContain('zotero://beaver');
        }
        expect(markdown).toContain('file chat');
    });

    it('sizes a height-only image of unknown natural size by the default shape in Word', async () => {
        const sized = parseNoteDoc({ type: 'doc', content: [paragraph({ type: 'image', attrs: { attachmentKey: 'IMG00001', height: 96 } })] }, { liftTitle: false });
        const { bytes } = await writeDocx({
            doc: sized,
            citations: citationsFor(sized),
            options: { liveCitations: false, linkItems: false, bibliographyTitle: 'R' },
            images: { 'image-1': { mime: 'image/png', data: PNG, width: 0, height: 0 } },
        });
        const document = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string');
        // 128 x 96 CSS px (4:3), not the 480 px default width: 9525 EMU per pixel.
        expect(document).toContain(`<wp:extent cx="${128 * 9525}" cy="${96 * 9525}"/>`);
    });

    it('spaces a citation after a link whose text ends in a space once', () => {
        const linked = parseNoteDoc({ type: 'doc', content: [paragraph(
            text('see this ', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
            { type: 'citation', attrs: { citation: { citationItems: [{ uris: ['u'] }] } } },
        )] }, { liftTitle: false });
        const citations = citationsFor(linked);
        const { html } = writeHtml({ doc: linked, citations, options: { linkItems: false, bibliographyTitle: 'R', notesTitle: 'N' } });
        expect(html).toContain('<a href="https://example.com">see this </a><span class="citation">');
        const { markdown } = writeMarkdown({ doc: linked, citations, options: { linkItems: false, bibliographyTitle: 'R', frontMatter: null } });
        expect(markdown).not.toMatch(/\)\s{2,}\(see/);
    });

    it('keeps the space after a bare address before a citation in LaTeX', () => {
        const linked = parseNoteDoc({ type: 'doc', content: [paragraph(
            text('https://example.com ', [{ type: 'link', attrs: { href: 'https://example.com' } }]),
            { type: 'citation', attrs: { citation: { citationItems: [{ uris: ['u'] }] } } },
        )] }, { liftTitle: false });
        const { tex } = writeLatex({
            doc: linked, citations: citationsFor(linked), keys: { 7: 'k' },
            options: { citationPackage: 'biblatex', standalone: false, bibFileName: 'refs.bib', linkItems: false, bibliographyTitle: 'R', date: '' },
        });
        expect(tex).toContain('\\url{https://example.com} \\parencite');
    });

    it('spaces an unresolved citation once in Word with a note style', async () => {
        const unresolved = parseNoteDoc({ type: 'doc', content: [paragraph(
            text('Unresolvable '),
            { type: 'citation', attrs: { citation: { citationItems: [{ uris: ['u'] }] } } },
        )] }, { liftTitle: false });
        const base = citationsFor(unresolved);
        const citations = {
            ...base,
            styleClass: 'note' as const,
            clusters: [{ html: '', plain: '', noteIndex: 0, items: [], fallbackTexts: ['(Ghost Author, 2001)'] }],
        };
        const { bytes } = await writeDocx({ doc: unresolved, citations, options: { liveCitations: false, linkItems: false, bibliographyTitle: 'R' } });
        const document = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string');
        expect(document.replace(/<[^>]+>/g, '')).toContain('Unresolvable (Ghost Author, 2001)');
    });

    it('marks an image that could not be loaded instead of dropping it', async () => {
        const html = writeHtml({ doc, citations: citationsFor(doc), options: { linkItems: false, bibliographyTitle: 'R', notesTitle: 'N' } }).html;
        expect(html).toContain('<em>[Image not available]</em>');
        expect(html).not.toContain('img-src');
    });
});

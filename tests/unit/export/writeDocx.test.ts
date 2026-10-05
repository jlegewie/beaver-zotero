import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { parseExportSource } from '@beaver/agent-export/parse/parseExportDoc';
import { writeDocx } from '@beaver/agent-export/docx/writeDocx';
import type { ExportDoc, FormattedCitations, FormattedCluster } from '@beaver/agent-export/types';

const DOC_DATA = '<data data-version="3"><session id="S"/><style id="http://www.zotero.org/styles/apa" hasBibliography="1" bibliographyStyleHasBeenSet="1"/><prefs><pref name="fieldType" value="Field"/></prefs></data>';

function cluster(html: string, noteIndex = 0): FormattedCluster {
    return {
        html,
        plain: html.replace(/<[^>]+>/g, ''),
        rtf: html,
        noteIndex,
        items: [{ id: 7, uris: ['http://zotero.org/users/1/items/AAAAAAAA'], itemData: { id: 7, type: 'book', title: 'T' }, locator: '3', label: 'page' }],
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
            layout: { indent: 720, firstLineIndent: -720, lineSpacing: 480, entrySpacing: 0, tabStops: [] },
        },
        documentData: DOC_DATA,
        ...overrides,
    };
}

async function unzip(bytes: Uint8Array) {
    const zip = await JSZip.loadAsync(bytes);
    const read = async (name: string) => (await zip.file(name)?.async('string')) ?? '';
    return { document: await read('word/document.xml'), footnotes: await read('word/footnotes.xml'), custom: await read('docProps/custom.xml') };
}

const visibleText = (xml: string) => xml
    .replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '');

const options = { liveCitations: true, linkItems: true, bibliographyTitle: 'References' };

describe('writeDocx', () => {
    const markdown = 'Claim <citation id="u-AAAAAAAA" loc="page3"/>. Second claim<citation id="u-BBBBBBBB"/>.\n\n'
        + '# Heading\n\n- one\n- two\n\n1. first\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n'
        + '[web](https://example.com) and [item](u-CCCCCCCC)\n\n$$x^2$$';

    it('writes live Zotero citation fields whose visible text equals plainCitation', async () => {
        const doc = parseExportSource({ title: 'Export', blocks: [{ type: 'markdown', markdown }] });
        const result = await writeDocx({ doc, citations: citations(doc, 'in-text'), options });
        const { document, custom } = await unzip(result.bytes);
        expect(result.stats.citationFields).toBe(2);

        const fields = [...document.matchAll(/<w:instrText xml:space="preserve">([\s\S]*?)<\/w:instrText>/g)].map(match => match[1]);
        const citationFields = fields.filter(code => code.includes('ZOTERO_ITEM'));
        expect(citationFields).toHaveLength(2);
        const json = JSON.parse(citationFields[0].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(' ADDIN ZOTERO_ITEM CSL_CITATION ', ''));
        expect(json.properties).toEqual({ formattedCitation: '(Smith, <i>2004</i>)', plainCitation: '(Smith, 2004)', noteIndex: 0 });
        expect(json.citationItems[0]).toMatchObject({ id: 7, uris: ['http://zotero.org/users/1/items/AAAAAAAA'], locator: '3', label: 'page' });
        expect(json.schema).toContain('csl-citation.json');

        const text = visibleText(document);
        expect(text).toContain('Claim (Smith, 2004).');
        // A space is inserted before a citation glued to the previous word.
        expect(text).toContain('Second claim (Smith, 2004).');
        expect(text).toContain('References\nSmith, J. (2004). Title.\nZed, A. (2010). Other.');
        // One bibliography field spanning the entries.
        expect(fields.filter(code => code.includes('ZOTERO_BIBL'))).toHaveLength(1);
        expect(document.match(/w:fldCharType="begin"/g)).toHaveLength(3);
        expect(document.match(/w:fldCharType="end"/g)).toHaveLength(3);
        expect(custom).toContain('name="ZOTERO_PREF_1"');
    });

    it('maps markdown structure to Word structure', async () => {
        const doc = parseExportSource({ title: 'Export', blocks: [{ type: 'markdown', markdown }] });
        const { document } = await unzip((await writeDocx({ doc, citations: citations(doc, 'in-text'), options })).bytes);
        expect(document).toContain('w:val="Title"');
        expect(document).toContain('w:val="Heading1"');
        expect(document.match(/<w:numPr>/g)?.length).toBe(3);
        expect(document).toContain('<w:tbl>');
        expect(document).toContain('w:val="Quote"');
        expect(document).toContain('<m:oMathPara>');
        expect(document.match(/<w:hyperlink /g)).toHaveLength(2);
    });

    it('puts note-style citations in footnotes numbered with markdown footnotes', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'One <citation id="u-AAAAAAAA"/>. Two[^n] <citation id="u-BBBBBBBB"/>.\n\n[^n]: A note.' }] });
        const formatted = citations(doc, 'note');
        const result = await writeDocx({ doc, citations: formatted, options });
        const { document, footnotes } = await unzip(result.bytes);
        expect(result.stats.footnotes).toBe(3);
        expect(document.match(/<w:footnoteReference /g)).toHaveLength(3);
        // The mark follows the word directly.
        expect(visibleText(document)).toContain('One. Two.');
        expect(footnotes.match(/ZOTERO_ITEM/g)).toHaveLength(2);
        // The second citation's footnote comes after the markdown footnote.
        expect(footnotes).toContain('noteIndex&quot;:3');
        expect(visibleText(footnotes)).toContain('A note.');
    });

    it('writes plain text without fields or document preferences when citations are static', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'Claim <citation id="u-AAAAAAAA"/>.' }] });
        const result = await writeDocx({ doc, citations: citations(doc, 'in-text'), options: { ...options, liveCitations: false } });
        const { document, custom } = await unzip(result.bytes);
        expect(document).not.toContain('ZOTERO_');
        expect(document).not.toContain('fldChar');
        expect(custom).not.toContain('ZOTERO_PREF');
        expect(visibleText(document)).toContain('Claim (Smith, 2004).');
    });

    it('writes citations the processor could not format as plain text', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'File <citation id="ext-ABCD1234"/>.' }] });
        const formatted = citations(doc, 'in-text', {
            clusters: [{ html: '', plain: '', noteIndex: 0, items: [], fallbackTexts: ['(data.csv, p. 2)'] }],
            bibliography: null,
        });
        const { document } = await unzip((await writeDocx({ doc, citations: formatted, options })).bytes);
        expect(visibleText(document)).toContain('File (data.csv, p. 2).');
        expect(document).not.toContain('ZOTERO_ITEM');
    });

    it('drops characters XML cannot carry instead of writing a corrupt file', async () => {
        const doc = parseExportSource({ title: 'Ti\u000ctle', blocks: [{ type: 'markdown', markdown: 'Form\u000cfeed and \u000bvtab <citation id="u-AAAAAAAA"/>' }] });
        const formatted = citations(doc, 'in-text', { bibliography: null });
        formatted.clusters[0] = cluster('(Sm\u0001ith)');
        const { document } = await unzip((await writeDocx({ doc, citations: formatted, options })).bytes);
        for (const char of ['\u0001', '\u000b', '\u000c']) expect(document).not.toContain(char);
        expect(visibleText(document)).toContain('Formfeed and vtab (Smith)');
    });

    it('reports equations exported as text', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: '$$\\frac{a}{$$' }] });
        const result = await writeDocx({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options });
        expect(result.warnings).toEqual([expect.objectContaining({ code: 'math_as_text', count: 1 })]);
    });
});

describe('writeDocx markdown footnotes', () => {
    it('writes a footnote referenced twice once and finds definitions inside lists', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown:
            'A[^n] B[^n].\n\n[^n]: Note <citation id="u-AAAAAAAA"/>.\n\n- Item[^m]\n\n  [^m]: In a list.' }] });
        const formatted = citations(doc, 'note', { bibliography: null });
        const result = await writeDocx({ doc, citations: formatted, options });
        const { document, footnotes } = await unzip(result.bytes);
        expect(result.stats.footnotes).toBe(2);
        expect(document.match(/<w:footnoteReference /g)).toHaveLength(2);
        // The repeat is a cross-reference to the bookmarked first mark.
        expect(document).toContain('w:name="_RefBeaverNote1"');
        expect(document).toMatch(/NOTEREF _RefBeaverNote1 \\f \\h/);
        expect(footnotes.match(/ZOTERO_ITEM/g)).toHaveLength(1);
        expect(visibleText(footnotes)).toContain('In a list.');
    });
});

describe('writeDocx lists', () => {
    it('starts a nested ordered list at its own number on its own level', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: '- outer\n\n  3. three\n  4. four' }] });
        const result = await writeDocx({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options });
        const zip = await JSZip.loadAsync(result.bytes);
        const numbering = (await zip.file('word/numbering.xml')?.async('string')) ?? '';
        expect(numbering).toMatch(/<w:lvl w:ilvl="1"[^>]*><w:start w:val="3"\/>/);
    });
});

describe('writeDocx bibliography layout', () => {
    it('keeps a tab stop at zero for numbers hanging in the margin', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'A <citation id="u-AAAAAAAA"/>.' }] });
        const formatted = citations(doc, 'in-text', {
            bibliography: {
                entries: ['<div class="csl-entry"><div class="csl-left-margin">[1]</div><div class="csl-right-inline">Entry</div></div>'],
                layout: { indent: 0, firstLineIndent: -384, lineSpacing: 240, entrySpacing: 0, tabStops: [0] },
            },
        });
        const { document } = await unzip((await writeDocx({ doc, citations: formatted, options })).bytes);
        expect(document).toMatch(/<w:tab w:val="left" w:pos="0"\/>/);
    });
});

describe('writeDocx raw HTML', () => {
    it('writes HTML blocks as decoded, separate paragraphs', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: '<p>A &amp; B</p><p>C</p>' }] });
        const { document } = await unzip((await writeDocx({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options })).bytes);
        const text = visibleText(document).replace(/&amp;/g, '&');
        expect(text).toContain('A & B\nC\n');
        expect(document).not.toContain('&amp;amp;');
    });
});

describe('writeDocx list markers', () => {
    it('numbers list items that begin with a heading', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: '1. ## First step\n2. ## Second step' }] });
        const { document } = await unzip((await writeDocx({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options })).bytes);
        expect(document.match(/<w:numPr>/g)).toHaveLength(2);
        expect(document.match(/w:val="Heading2"/g)).toHaveLength(2);
    });
});

describe('writeDocx links', () => {
    it('keeps equations and citation fields inside link text, outside the hyperlink runs', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: '[Eq $x^2$ and <citation id="u-AAAAAAAA"/> end](https://example.com)' }] });
        const result = await writeDocx({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options });
        const { document } = await unzip(result.bytes);
        expect(result.stats).toMatchObject({ equations: 1, citationFields: 1 });
        expect(document).toContain('<m:oMath>');
        expect(document.match(/<w:hyperlink /g)).toHaveLength(3);
        // No hyperlink opens inside the field.
        const field = document.slice(document.indexOf('fldCharType="begin"'), document.indexOf('fldCharType="end"'));
        expect(field).not.toContain('<w:hyperlink');
        expect(visibleText(document)).toContain('Eq ');
        expect(visibleText(document)).toContain('(Smith, 2004) end');
    });
});

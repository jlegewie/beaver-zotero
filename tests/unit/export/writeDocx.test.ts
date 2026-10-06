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
    return {
        document: await read('word/document.xml'),
        footnotes: await read('word/footnotes.xml'),
        custom: await read('docProps/custom.xml'),
        styles: await read('word/styles.xml'),
        footer: await read('word/footer1.xml'),
    };
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

describe('writeDocx footnotes across activity', () => {
    it('resolves a response footnote within the response, not in a note that reuses its label', async () => {
        const doc = parseExportSource({ title: '', blocks: [
            { type: 'note', title: 'N', markdown: 'Note text[^1].\n\n[^1]: Note footnote.' },
            { type: 'markdown', markdown: 'Claim[^1].' },
            { type: 'activity', calls: ['Item search'] },
            { type: 'markdown', markdown: 'More.\n\n[^1]: Response footnote.' },
        ] });
        const result = await writeDocx({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options });
        const { footnotes } = await unzip(result.bytes);
        expect(result.stats.footnotes).toBe(2);
        expect(visibleText(footnotes)).toContain('Note footnote.');
        expect(visibleText(footnotes)).toContain('Response footnote.');
    });

    it('writes a footnote whose definition follows a tool call', async () => {
        const doc = parseExportSource({ title: '', blocks: [
            { type: 'markdown', markdown: 'Claim[^a].' },
            { type: 'activity', calls: ['Item search'] },
            { type: 'markdown', markdown: 'More.\n\n[^a]: The note.' },
        ] });
        const result = await writeDocx({ doc, citations: citations(doc, 'in-text', { bibliography: null }), options });
        const { document, footnotes } = await unzip(result.bytes);
        expect(result.stats.footnotes).toBe(1);
        expect(document).toContain('<w:footnoteReference ');
        expect(visibleText(document)).not.toContain('[^a]');
        expect(visibleText(footnotes)).toContain('The note.');
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

describe('writeDocx theme', () => {
    const write = async (markdown: string, locale = 'en-US', blocks?: any[]) => {
        const doc = parseExportSource({ title: 'T', blocks: blocks ?? [{ type: 'markdown', markdown }] });
        const formatted = citations(doc, 'in-text', { locale });
        return unzip((await writeDocx({ doc, citations: formatted, options })).bytes);
    };

    it('defines fonts, sizes and spacing in styles, not on individual runs', async () => {
        const { document, styles } = await write('Plain paragraph.\n\n# Heading');
        expect(styles).toMatch(/<w:docDefaults>.*w:ascii="Times New Roman".*<w:sz w:val="24"\/>/s);
        const bodyText = styles.match(/<w:style [^>]*w:styleId="BodyText".*?<\/w:style>/s)?.[0] ?? '';
        expect(bodyText).toMatch(/<w:spacing [^>]*w:after="160"/);
        expect(bodyText).toMatch(/<w:spacing [^>]*w:line="276"/);
        // Headings are black and bold, not Word's blue.
        expect(styles).toMatch(/w:styleId="Heading1".*?<w:b\/>.*?<w:color w:val="000000"\/>/s);
        expect(document).toContain('<w:pStyle w:val="BodyText"/>');
        expect(document).not.toMatch(/<w:rFonts /);
    });

    it('sets the page from the citation locale and numbers pages', async () => {
        const letter = await write('x');
        expect(letter.document).toMatch(/<w:pgSz w:w="12240" w:h="15840"/);
        expect(letter.document).toMatch(/<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
        expect(letter.footer).toContain('PAGE');
        const a4 = await write('x', 'de-DE');
        expect(a4.document).toMatch(/<w:pgSz w:w="11906" w:h="16838"/);
    });

    it('writes tables with rules above, below and under the header only', async () => {
        const { document } = await write('| A | B |\n|---|---|\n| 1 | 2 |');
        const tableBorders = document.match(/<w:tblBorders>.*?<\/w:tblBorders>/s)?.[0] ?? '';
        expect(tableBorders).toMatch(/<w:top w:val="single"/);
        expect(tableBorders).toMatch(/<w:insideV w:val="none"/);
        expect(document).toMatch(/<w:tcBorders><w:bottom w:val="single"/);
        expect(document).toContain('<w:pStyle w:val="TableText"/>');
    });

    it('gives the paragraph after a list a full paragraph gap', async () => {
        const { document } = await write('Intro.\n\n- one\n- two\n\nAfter.');
        expect(document.match(/<w:pStyle w:val="ListParagraph"\/>/g)).toHaveLength(2);
        expect(document).toMatch(/<w:pStyle w:val="BodyText"\/><w:spacing w:before="160"\/><\/w:pPr><w:r><w:t xml:space="preserve">After\./);
    });

    it('writes tool activity as quiet lines with typographic quotes', async () => {
        const { document, styles } = await write('', 'en-US', [
            { type: 'markdown', markdown: 'Searching.' },
            { type: 'activity', calls: ['Item search: "school segregation" (10 results)', 'Reading: Smith 2004'] },
            { type: 'markdown', markdown: 'Done.' },
        ]);
        expect(document.match(/<w:pStyle w:val="BeaverActivity"\/>/g)).toHaveLength(2);
        expect(visibleText(document)).toContain('Item search: \u201cschool segregation\u201d (10 results)');
        expect(styles).toMatch(/w:styleId="BeaverActivity".*?<w:contextualSpacing\/>/s);
    });

    it('trims the layout whitespace around bibliography entries', async () => {
        const doc = parseExportSource({ title: '', blocks: [{ type: 'markdown', markdown: 'A <citation id="u-AAAAAAAA"/>.' }] });
        const formatted = citations(doc, 'in-text', {
            bibliography: {
                entries: ['  <div class="csl-entry">Smith, J. 2004. Title.</div>\n'],
                layout: { indent: 720, firstLineIndent: -720, lineSpacing: 240, entrySpacing: 240, tabStops: [] },
            },
        });
        const { document } = await unzip((await writeDocx({ doc, citations: formatted, options })).bytes);
        expect(document).toContain('<w:t xml:space="preserve">Smith, J. 2004. Title.</w:t>');
    });

    describe('block layout', () => {
        const write = async (markdown: string, styleClass: 'in-text' | 'note' = 'in-text') => {
            const doc = parseExportSource({ title: 'Export', blocks: [{ type: 'markdown', markdown }] });
            const result = await writeDocx({ doc, citations: citations(doc, styleClass), options });
            const zip = await JSZip.loadAsync(result.bytes);
            return {
                ...(await unzip(result.bytes)),
                numbering: (await zip.file('word/numbering.xml')?.async('string')) ?? '',
            };
        };
        const paragraphs = (xml: string) => xml.match(/<w:p>[\s\S]*?<\/w:p>|<w:p [\s\S]*?<\/w:p>|<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? [];

        it('keeps the em spaces of \\quad and \\qquad in the written equation', async () => {
            const { document } = await write('$$a \\qquad b \\quad c$$');
            expect(document).toContain('<m:t xml:space="preserve">\u2003\u2003</m:t>');
            expect(document).toContain('<m:t xml:space="preserve">\u2003</m:t>');
        });

        it('keeps a numbered task item\'s number, with the checkbox after it', async () => {
            const { document } = await write('1. [x] done\n2. [ ] open');
            expect(visibleText(document)).toContain('☒ done');
            expect(visibleText(document)).toContain('☐ open');
        });

        it('leads only a note that opens with text', async () => {
            const { footnotes } = await write('Claim.[^a]\n\n[^a]: - first\n    - second\n\n    And a paragraph.');
            expect(visibleText(footnotes)).toContain('And a paragraph.');
            expect(visibleText(footnotes)).not.toContain(' And a paragraph.');
        });

        it('makes a task item\'s checkbox its marker instead of adding one to a bullet', async () => {
            const { document, numbering } = await write('- [ ] open task\n- [x] done task');
            expect(visibleText(document)).not.toMatch(/[☐☒]/);
            expect(numbering).toContain('w:val="☐"');
            expect(numbering).toContain('w:val="☒"');
        });

        it('separates adjacent code blocks, and a table and a code block, with an unshaded spacer', async () => {
            const { document } = await write('```\none\n```\n\n```\ntwo\n```\n\n| A |\n|---|\n| 1 |\n\n```\nthree\n```');
            const blocks = paragraphs(document).map(block => (
                block.startsWith('<w:tbl') ? 'table'
                    : /w:val="Code"/.test(block) ? 'code'
                        : /w:lineRule="exact"/.test(block) && !/<w:t[ >]/.test(block) ? 'spacer' : 'other'
            ));
            const start = blocks.indexOf('code');
            expect(blocks.slice(start, start + 6)).toEqual(['code', 'spacer', 'code', 'table', 'spacer', 'code']);
        });

        it('gives a quote after a list its gap, and marks quotes with a rule', async () => {
            const { document, styles } = await write('- item\n\n> quoted');
            const quote = paragraphs(document).find(block => block.includes('quoted'))!;
            expect(quote).toContain('w:val="Quote"');
            expect(quote).toMatch(/<w:spacing w:before="\d+"/);
            expect(styles).toMatch(/w:styleId="Quote"[\s\S]*?<w:left w:val="single"/);
        });

        it('puts a space between the footnote number and the note', async () => {
            const { footnotes } = await write('Claim.[^a]\n\n[^a]: The note.');
            expect(footnotes).toMatch(/<w:footnoteRef\/><\/w:r>(?:<w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t xml:space="preserve"> <\/w:t><\/w:r>)/);
            const cited = await write('Claim <citation id="u-AAAAAAAA"/>.', 'note');
            expect(cited.footnotes).toMatch(/<w:footnoteRef\/><\/w:r><w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t xml:space="preserve"> <\/w:t>/);
        });
    });
});

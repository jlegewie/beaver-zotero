// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-core/platform/logger', () => ({ logger: vi.fn() }));

// ProseMirror parses in a document from Zotero's main window; jsdom's here.
beforeAll(() => {
    (globalThis as any).Zotero = {
        ...(globalThis as any).Zotero,
        getMainWindow: () => globalThis.window,
    };
});

import { readNoteForExport } from '../../../src/services/export/noteExportSource';
import { getBeaverNoteFooterHTML } from '../../../src/utils/noteProvenance';
import { buildEditFooterHtml } from '../../../src/utils/noteEditFooter';
import { parseNoteDoc } from '@beaver/agent-export/note/parseNoteDoc';
import type { MdBlock, MdInline } from '@beaver/agent-export/mdast';

const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const SMITH = 'http://zotero.org/users/1/items/SMITH001';
const JONES = 'http://zotero.org/users/1/items/JONES001';
const GONE = 'http://zotero.org/users/1/items/GONE0001';

function citation(items: Array<Record<string, unknown>>, preview: string): string {
    return `<span class="citation" data-citation="${encode({ citationItems: items, properties: {} })}">(${preview})</span>`;
}

/** A Beaver note: title, sections, citations side by side, then both Beaver footers. */
function beaverNote(): string {
    const cache = encode([{ uris: [GONE], itemData: { id: GONE, type: 'book', title: 'Gone' } }]);
    return `<div data-citation-items="${cache}" data-schema-version="10">`
        + '<h1>Review of policing</h1>'
        + '<h2>Background</h2>'
        + `<p>Stops rose ${citation([{ uris: [SMITH], locator: 'xii' }], '<span class="citation-item">Smith, 2020, p. xii</span>')} `
        + `${citation([{ uris: [JONES] }], '<span class="citation-item">Jones, 2019</span>')}.</p>`
        + '<p></p>'
        + '<h3>Detail</h3>'
        + `<p>See ${citation([{ uris: [SMITH], locator: '3', label: 'chapter', prefix: 'see', suffix: 'emphasis added', 'suppress-author': true }], '<span class="citation-item">see 2020, chapter 3 emphasis added</span>')} and `
        + `${citation([{ uris: [GONE] }, { uris: [JONES], locator: '4' }], '<span class="citation-item">Gone, 2001</span>; <span class="citation-item">Jones, 2019, p. 4</span>')}.</p>`
        + getBeaverNoteFooterHTML('T1', 'R1')
        + buildEditFooterHtml(['T1'])
        + '</div>';
}

function texts(nodes: MdInline[]): string {
    return nodes.map(node => ('value' in node ? node.value : 'children' in node ? texts(node.children) : node.type === 'citation' ? `[c${node.clusterIndex}]` : '')).join('');
}

function blockText(block: MdBlock): string {
    if (block.type === 'paragraph' || block.type === 'heading') return texts(block.children);
    return block.type;
}

describe('readNoteForExport + parseNoteDoc', () => {
    it('reads a Beaver note: title, shifted headings, clustered citations, no footers', () => {
        const { doc: json, citationItems } = readNoteForExport(beaverNote());
        const doc = parseNoteDoc(json);

        expect(doc.title).toBe('Review of policing');
        const blocks = doc.sections[0].children;
        expect(blocks.map(block => (block.type === 'heading' ? `h${block.depth}:${blockText(block)}` : blockText(block)))).toEqual([
            'h1:Background',
            'Stops rose [c0].',
            'h2:Detail',
            'See [c1] and [c2].',
        ]);

        // Side-by-side citations are one cluster; the space between them goes.
        expect(doc.clusters[0].items.map(item => item.note)).toEqual([
            { uris: [SMITH], locator: 'xii' },
            { uris: [JONES] },
        ]);
        // User-set citation fields are kept as stored.
        expect(doc.clusters[1].items[0].note).toEqual({
            uris: [SMITH], locator: '3', label: 'chapter', prefix: 'see', suffix: 'emphasis added', suppressAuthor: true,
        });
        expect(doc.clusters[1].items[0].previewText).toBe('(see 2020, chapter 3 emphasis added)');
        // One preview per item of a multi-item citation, each parenthesized.
        expect(doc.clusters[2].items.map(item => item.previewText)).toEqual(['(Gone, 2001)', '(Jones, 2019, p. 4)']);

        expect(citationItems).toEqual([{ uris: [GONE], itemData: { id: GONE, type: 'book', title: 'Gone' } }]);
        expect(JSON.stringify(doc)).not.toContain('Beaver');
    });

    it('falls back to the metadata Beaver stores on a citation of a work not in the library', () => {
        const doi = 'https://doi.org/10.1000/xyz';
        const csl = { id: doi, type: 'article-journal', title: 'External work' };
        const cached = { id: doi, type: 'article-journal', title: 'Cached copy' };
        const external = (cache: unknown[] | null) => (cache ? `<div data-citation-items="${encode(cache)}" data-schema-version="10">` : '<div data-schema-version="10">')
            + `<p>${citation([{ uris: [doi], locator: '4', beaver: { v: 1, ext: 'W1', src: 'openalex', csl } }], '<span class="citation-item">Doe, 2020, p. 4</span>')}</p>`
            + `<p>${citation([{ uris: [SMITH], beaver: { v: 2, csl } }], '<span class="citation-item">Smith, 2020</span>')}</p>`
            + '</div>';

        // Without a cache entry, the citation's own copy is used; metadata of another version is ignored.
        expect(readNoteForExport(external(null)).citationItems).toEqual([{ uris: [doi], itemData: csl }]);
        // The note's cache comes first, so the resolver prefers it.
        expect(readNoteForExport(external([{ uris: [doi], itemData: cached }])).citationItems).toEqual([
            { uris: [doi], itemData: cached },
            { uris: [doi], itemData: csl },
        ]);
    });

    it('skips malformed citation items and still reads the note', () => {
        const doi = 'https://doi.org/10.1000/xyz';
        const csl = { id: doi, type: 'article-journal', title: 'External work' };
        const html = '<div data-schema-version="10">'
            + `<p>Text ${citation([null as any, 'junk' as any, { uris: [doi], beaver: { v: 1, ext: 'W1', csl } }], '<span class="citation-item">Doe, 2020</span>')}</p>`
            + '</div>';

        const { doc, citationItems } = readNoteForExport(html);

        expect(citationItems).toEqual([{ uris: [doi], itemData: csl }]);
        expect(parseNoteDoc(doc, { liftTitle: false }).clusters[0].items.map(item => item.note?.uris)).toEqual([[doi]]);
    });

    it('reads annotation notes: highlight text, its visible citation, image annotations', () => {
        const annotation = encode({
            attachmentURI: 'http://zotero.org/users/1/items/ATT00001', annotationKey: 'ANN00001', color: '#ffd400',
            pageLabel: '5', position: { pageIndex: 4, rects: [[0, 0, 1, 1]] }, citationItem: { uris: [SMITH], locator: '5' },
        });
        const html = '<div data-schema-version="10">'
            + `<p><span class="highlight" data-annotation="${annotation}">“Quoted text”</span> `
            + `${citation([{ uris: [SMITH], locator: '5' }], '<span class="citation-item">Smith, 2020, p. 5</span>')} comment</p>`
            + `<p><span class="underline" data-annotation="${annotation}"><u style="text-decoration-color: #5fb236">under</u></span></p>`
            + `<p><img data-attachment-key="IMG00001" width="200" height="100" data-annotation="${annotation}"></p>`
            + '</div>';
        const doc = parseNoteDoc(readNoteForExport(html).doc, { liftTitle: false });
        const [quote, under, image] = doc.sections[0].children;
        expect(blockText(quote)).toBe('“Quoted text” [c0] comment');
        // The highlight's own citation item is not cited a second time.
        expect(doc.clusters).toHaveLength(1);
        expect(under).toMatchObject({ type: 'paragraph', children: [{ type: 'underline', color: '#5fb236' }] });
        expect(image).toMatchObject({ type: 'paragraph', children: [{ type: 'image', assetId: 'image-1', width: 200, height: 100 }] });
        expect(doc.images).toEqual({ 'image-1': { kind: 'attachment', key: 'IMG00001' } });
    });

    it('maps formatting, math, links, lists and tables as the note editor reads them', () => {
        const html = '<div data-schema-version="10">'
            + '<p style="text-align: center">H<sub>2</sub>O and x<sup>2</sup>, <span style="color: #ff2020">red</span>, '
            + '<span style="background-color: #ffd40080">marked</span>, <s>struck</s>, <code>code()</code></p>'
            + '<p><span class="math">$a^2$</span></p><pre class="math">$$\\int x$$</pre>'
            + '<p><a href="https://example.com">web</a> <a href="zotero://select/library/items/SMITH001">item</a> '
            + '<a href="file:///Users/me/secret.pdf">file</a></p>'
            + '<ol start="3"><li><p>three</p></li></ol>'
            + '<table><tr><th>A</th><th>B</th></tr><tr><td colspan="2" style="background-color: #ffd40080"><p>wide</p><ul><li>x</li></ul></td></tr></table>'
            + '<p style="padding-left: 80px" dir="rtl">indented</p>'
            + '</div>';
        const doc = parseNoteDoc(readNoteForExport(html).doc);
        const [formatted, inlineMath, display, links, list, table, indented] = doc.sections[0].children;

        expect(formatted).toMatchObject({ type: 'paragraph', align: 'center' });
        const children = (formatted as any).children as MdInline[];
        expect(children).toEqual(expect.arrayContaining([
            { type: 'subscript', children: [{ type: 'text', value: '2' }] },
            { type: 'superscript', children: [{ type: 'text', value: '2' }] },
            { type: 'styled', color: '#ff2020', children: [{ type: 'text', value: 'red' }] },
            // Half-transparent highlight blended onto white.
            { type: 'styled', background: '#ffea80', children: [{ type: 'text', value: 'marked' }] },
            { type: 'delete', children: [{ type: 'text', value: 'struck' }] },
            { type: 'inlineCode', value: 'code()' },
        ]));
        expect(inlineMath).toEqual({ type: 'paragraph', children: [{ type: 'inlineMath', value: 'a^2' }] });
        expect(display).toEqual({ type: 'math', value: '\\int x' });
        expect((links as any).children).toEqual([
            { type: 'link', url: 'https://example.com', children: [{ type: 'text', value: 'web' }] },
            { type: 'text', value: ' ' },
            { type: 'link', url: 'zotero://select/library/items/SMITH001', children: [{ type: 'text', value: 'item' }] },
            { type: 'text', value: ' ' },
            // Kept in the model; every writer writes a local file link as its text.
            { type: 'link', url: 'file:///Users/me/secret.pdf', children: [{ type: 'text', value: 'file' }] },
        ]);
        expect(list).toMatchObject({ type: 'list', ordered: true, start: 3 });
        expect(table).toMatchObject({
            type: 'table',
            headerRow: true,
            children: [
                { children: [{ header: true, blocks: [{ type: 'paragraph' }] }, { header: true }] },
                { children: [{ colspan: 2, background: '#ffea80', blocks: [{ type: 'paragraph' }, { type: 'list' }] }] },
            ],
        });
        expect(indented).toMatchObject({ type: 'paragraph', indent: 2, dir: 'rtl' });
    });

    it('keeps the preview of a multi-item citation for the group when it does not show items separately', () => {
        const html = `<div data-schema-version="10"><p>${citation([{ uris: [SMITH] }, { uris: [JONES] }], 'Smith 2020; Jones 2019')}</p></div>`;
        const doc = parseNoteDoc(readNoteForExport(html).doc);
        expect(doc.clusters[0].items.map(item => [item.previewText, item.groupPreview])).toEqual([
            [undefined, '(Smith 2020; Jones 2019)'],
            [undefined, '(Smith 2020; Jones 2019)'],
        ]);
    });

    it('keeps stored metadata when side-by-side copies of one citation merge', () => {
        const data = { id: GONE, type: 'book', title: 'Gone' };
        const html = `<div data-schema-version="10"><p>${citation([{ uris: [GONE] }], 'Gone')} ${citation([{ uris: [GONE], itemData: data }], 'Gone')}</p></div>`;
        const doc = parseNoteDoc(readNoteForExport(html).doc);
        expect(doc.clusters[0].items).toHaveLength(1);
        expect(doc.clusters[0].items[0].note?.itemData).toEqual(data);
    });

    it('leaves out the branding of a note saved from a chat, at its top and its end, with their rules', () => {
        const branding = getBeaverNoteFooterHTML('T1', 'R1');
        const html = `<div data-schema-version="10"><h1>Saved chat</h1>${branding}<hr><p>Body</p><hr>${branding}</div>`;
        const doc = parseNoteDoc(readNoteForExport(html).doc);
        expect(doc.title).toBe('Saved chat');
        expect(doc.sections[0].children).toEqual([{ type: 'paragraph', children: [{ type: 'text', value: 'Body' }] }]);
    });

    it('leaves out the older footer that is only a "Created by Beaver" link', () => {
        const html = '<div data-schema-version="10"><p>Body</p><p><span style="color: #aaa;"><a href="zotero://beaver/thread/T1">Created by Beaver</a></span></p></div>';
        const doc = parseNoteDoc(readNoteForExport(html).doc, { liftTitle: false });
        expect(doc.sections[0].children).toEqual([{ type: 'paragraph', children: [{ type: 'text', value: 'Body' }] }]);
    });

    it('leaves out a footer whose link was lost, recognized by its text and gray', () => {
        const html = '<div data-schema-version="10"><p>Body</p>'
            + '<p><strong><span style="color: rgb(170, 170, 170);">Created by Beaver</span></strong><span style="color: rgb(170, 170, 170);"> · Open Message</span></p></div>';
        const doc = parseNoteDoc(readNoteForExport(html).doc, { liftTitle: false });
        expect(doc.sections[0].children).toEqual([{ type: 'paragraph', children: [{ type: 'text', value: 'Body' }] }]);
    });

    it('keeps "Created by Beaver" text without a link in other colors (gray background included) or without the rest of the footer', () => {
        const html = '<div data-schema-version="10">'
            + '<p><span style="color: #ff2020;">Created by Beaver · Open Message</span></p>'
            + '<p><span style="color: #aaa;">Created by Beaver</span></p>'
            + '<p><span style="color: #ff2020; background-color: #aaa;">Created by Beaver · Open Message</span></p></div>';
        const doc = parseNoteDoc(readNoteForExport(html).doc, { liftTitle: false });
        expect(doc.sections[0].children).toHaveLength(3);
    });

    it('keeps a paragraph that only reads like the branding', () => {
        const html = '<div data-schema-version="10"><p>Created by Beaver · Open Message</p><hr><p>Body</p></div>';
        const doc = parseNoteDoc(readNoteForExport(html).doc, { liftTitle: false });
        expect(doc.sections[0].children.map(block => block.type)).toEqual(['paragraph', 'thematicBreak', 'paragraph']);
    });

    it('decodes HTML entities in local link targets', () => {
        const html = '<div data-schema-version="10"><p><a href="zotero://open-pdf/library/items/ATT00001?page=3&amp;annotation=IJKLMNOP">note</a> '
            + '<a href="https://example.com/?a=1&amp;b=2">web</a></p></div>';
        const doc = parseNoteDoc(readNoteForExport(html).doc, { liftTitle: false });
        const links = ((doc.sections[0].children[0] as any).children as MdInline[]).filter(node => node.type === 'link');
        expect(links.map(link => (link as any).url)).toEqual([
            'zotero://open-pdf/library/items/ATT00001?page=3&annotation=IJKLMNOP',
            'https://example.com/?a=1&b=2',
        ]);
    });

    it('drops colors on request and keeps a first paragraph as body text', () => {
        const html = '<div data-schema-version="10"><p>First line <span style="color: #ff2020">red</span></p></div>';
        const doc = parseNoteDoc(readNoteForExport(html).doc, { colors: false });
        expect(doc.title).toBe('');
        expect(doc.sections[0].children).toEqual([{ type: 'paragraph', children: [{ type: 'text', value: 'First line red' }] }]);
    });
});

describe('getDomWindow', () => {
    it('falls back to any open window when Zotero has no main window', async () => {
        const { getDomWindow } = await import('../../../src/prosemirror/dom');
        const standalone = { document: globalThis.document };
        const previous = (globalThis as any).Services;
        (globalThis as any).Zotero.getMainWindow = () => null;
        (globalThis as any).Services = { wm: { getMostRecentWindow: () => standalone } };
        try {
            expect(getDomWindow()).toBe(standalone);
        } finally {
            (globalThis as any).Zotero.getMainWindow = () => globalThis.window;
            (globalThis as any).Services = previous;
        }
    });
});

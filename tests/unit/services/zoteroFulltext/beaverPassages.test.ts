import { describe, expect, it } from 'vitest';
import type { StructuredDocument } from '../../../../packages/agent-core/src/extract/schema';
import type { DomDocument } from '../../../../packages/agent-core/src/extract/document/dom/schema';
import {
    codePointLength,
    domDocumentPassages,
    structuredDocumentPassages,
} from '../../../../src/services/zoteroFulltext/beaverPassages';

/** Python-style slice by code points, as the backend renders spans. */
const slice = (text: string, start: number, end: number) => Array.from(text).slice(start, end).join('');

function page(index: number, items: any[], label?: string) {
    return { index, label, width: 600, height: 800, viewBox: [0, 0, 600, 800], rotation: 0, items };
}

const bbox = [1, 2, 3, 4];

describe('structuredDocumentPassages', () => {
    const document = {
        pageCount: 2,
        bboxOrigin: 'top-left',
        bboxPrecision: 1,
        pages: [
            page(0, [
                { id: 'heading0.1', kind: 'section_header', pageIndex: 0, order: 0, bbox, text: '## Introduction', level: 1 },
                {
                    id: 'p0.2', kind: 'text', pageIndex: 0, order: 1, bbox, text: 'First 𝑥 sentence. Second one.',
                    sentences: [
                        { id: 's0.2', order: 1, text: 'Second one.', bboxes: [[5, 5, 6, 6]] },
                        { id: 's0.1', order: 0, text: 'First 𝑥 sentence.', bboxes: [[1, 1, 2, 2]] },
                    ],
                },
                { id: 'ref0.3', kind: 'reference', pageIndex: 0, order: 2, bbox, text: 'Smith J. 2020. A paper.' },
                { id: 'fig0.4', kind: 'picture', pageIndex: 0, order: 3, bbox, text: 'axis label' },
            ], 'iv'),
            page(1, [
                {
                    id: 'table1.1', kind: 'table', pageIndex: 1, order: 0, bbox, text: 'a | b',
                    sentences: [{ id: 's1.1', order: 0, text: 'a | b', bboxes: [[1, 1, 2, 2]] }],
                },
                { id: 'eq1.2', kind: 'formula', pageIndex: 1, order: 1, bbox, text: 'E = mc^2' },
            ]),
        ],
    } as unknown as StructuredDocument;

    const passages = structuredDocumentPassages(document);

    it('cuts one passage per page with page-scoped locators', () => {
        expect(passages.map((p) => p.pageIndex)).toEqual([0, 1]);
        expect(passages[0].locator).toMatchObject({
            content_kind: 'pdf',
            pages: [{ page_index: 0, page_label: 'iv' }],
            item_ids: ['heading0.1', 'p0.2'],
            section: 'Introduction',
        });
        expect(passages[1].locator).toMatchObject({ pages: [{ page_index: 1 }], section: 'Introduction' });
    });

    it('orders sentences and leaves out references and figures', () => {
        expect(passages[0].text).toBe('## Introduction\n\nFirst 𝑥 sentence. Second one.');
    });

    it('records spans in code points that slice back to each sentence', () => {
        const { text, locator } = passages[0];
        const spans = locator.spans as { id: string; start: number; end: number; page_index?: number; bboxes?: unknown }[];
        expect(spans.map((span) => [span.id, slice(text, span.start, span.end)])).toEqual([
            ['heading0.1', '## Introduction'],
            ['s0.1', 'First 𝑥 sentence.'],
            ['s0.2', 'Second one.'],
        ]);
        expect(spans[1]).toMatchObject({ page_index: 0, bboxes: [[1, 1, 2, 2]] });
        expect(spans[spans.length - 1].end).toBe(codePointLength(text));
    });

    it('wraps table sentences in their item and cites formulas whole', () => {
        const spans = passages[1].locator.spans as { id: string; item_id?: string }[];
        expect(spans).toEqual([
            expect.objectContaining({ id: 's1.1', item_id: 'table1.1' }),
            expect.objectContaining({ id: 'eq1.2' }),
        ]);
        expect(spans[1].item_id).toBeUndefined();
    });

    it('splits long pages and never ends a passage with a heading', () => {
        const sentence = (i: number) => ({ id: `s0.${i}`, order: i, text: `Sentence number ${i} ${'word '.repeat(40)}.`, bboxes: [] });
        const items: any[] = [];
        for (let i = 0; i < 12; i++) {
            items.push({ id: `p0.${i}`, kind: 'text', pageIndex: 0, order: i * 2, bbox, text: 'x', sentences: [sentence(i)] });
            if (i === 5) items.push({ id: 'heading0.99', kind: 'section_header', pageIndex: 0, order: i * 2 + 1, bbox, text: 'Methods', level: 1 });
        }
        const long = structuredDocumentPassages({ pageCount: 1, bboxOrigin: 'top-left', bboxPrecision: 1, pages: [page(0, items)] } as unknown as StructuredDocument);
        expect(long.length).toBeGreaterThan(1);
        for (const passage of long) {
            const spans = passage.locator.spans as { id: string }[];
            expect(spans[spans.length - 1].id.startsWith('heading')).toBe(false);
            expect(passage.text.length).toBeLessThanOrEqual(2000);
        }
    });
});

describe('continued sentences', () => {
    const sentence = (id: string, order: number, text: string, joinWithNext = false) =>
        ({ id, order, text, bboxes: [[0, 0, 1, 1]], ...(joinWithNext ? { joinWithNext: true } : {}) });
    const filler = 'word '.repeat(240).trim();

    function docWith(items: any[]) {
        return { pageCount: 1, bboxOrigin: 'top-left', bboxPrecision: 1, pages: [page(0, items)] } as unknown as StructuredDocument;
    }

    it('keeps a sentence split by a column break in one passage, with footnotes after it', () => {
        const passages = structuredDocumentPassages(docWith([
            { id: 'p0.1', kind: 'text', pageIndex: 0, order: 0, bbox, text: 'x', sentences: [sentence('s0.1', 0, filler + '.'), sentence('s0.2', 1, 'The effect was', true)] },
            { id: 'footnote0.2', kind: 'footnote', pageIndex: 0, order: 1, bbox, text: '1 A note.' },
            { id: 'p0.3', kind: 'text', pageIndex: 0, order: 2, bbox, text: 'x', sentences: [sentence('s0.3', 0, 'large and lasting.'), sentence('s0.4', 1, filler + '.')] },
        ]));
        const withBreak = passages.find((p) => p.text.includes('The effect was'))!;
        expect(withBreak.text).toContain('The effect was large and lasting.');
        expect(withBreak.locator.item_ids).toEqual(expect.arrayContaining(['p0.1', 'p0.3']));
        const footnote = passages.findIndex((p) => p.text.includes('1 A note.'));
        expect(footnote).toBeGreaterThanOrEqual(passages.indexOf(withBreak));
    });

    it('does not join across a heading or into a non-text item', () => {
        const passages = structuredDocumentPassages(docWith([
            { id: 'p0.1', kind: 'text', pageIndex: 0, order: 0, bbox, text: 'x', sentences: [sentence('s0.1', 0, 'Dangling', true)] },
            { id: 'heading0.2', kind: 'section_header', pageIndex: 0, order: 1, bbox, text: 'Methods', level: 1 },
            { id: 'p0.3', kind: 'text', pageIndex: 0, order: 2, bbox, text: 'x', sentences: [sentence('s0.3', 0, 'Next part.')] },
        ]));
        expect(passages[0].text).toBe('Dangling\n\nMethods\n\nNext part.');
    });
});

describe('domDocumentPassages', () => {
    const document = {
        sectionCount: 2,
        citationIndex: {},
        diagnostics: { extractedTextChars: 0, sourceTextChars: 0, textCoverage: null },
        sections: [
            {
                index: 0, rawHref: 'ch1.xhtml', label: 'Chapter 1',
                items: [
                    { id: 'h0', kind: 'section_header', sectionIndex: 0, order: 0, text: 'Chapter 1', anchorId: 'c1' },
                    { id: 'p1', kind: 'text', sectionIndex: 0, order: 1, pageNumber: 3, anchorId: 'a1', sentences: [{ id: 's1', text: 'Hello world.' }] },
                ],
            },
            {
                index: 1, rawHref: 'ch2.xhtml',
                items: [{ id: 'p2', kind: 'text', sectionIndex: 1, order: 0, text: 'No sentences here' }],
            },
        ],
    } as unknown as DomDocument;

    it('builds EPUB locators per section', () => {
        const passages = domDocumentPassages(document, 'epub');
        expect(passages).toHaveLength(2);
        expect(passages[0]).toMatchObject({
            pageIndex: null,
            text: 'Chapter 1\n\nHello world.',
            locator: {
                content_kind: 'epub', section_index: 0, section_href: 'ch1.xhtml', section_label: 'Chapter 1',
                anchor_id: 'c1', page_numbers: [1, 3], section: 'Chapter 1',
            },
        });
        // Items without a stamped page number fall back to the 1-based section ordinal
        expect(passages[1].locator).toMatchObject({ section_index: 1, page_numbers: [2], spans: [{ id: 'p2', start: 0, end: 17 }] });
    });

    it('builds snapshot locators without section fields', () => {
        const [passage] = domDocumentPassages(document, 'snapshot');
        expect(passage.locator.content_kind).toBe('snapshot');
        expect(passage.locator).not.toHaveProperty('section_href');
    });
});

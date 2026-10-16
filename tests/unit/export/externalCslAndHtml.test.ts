import { describe, expect, it } from 'vitest';
import { externalReferenceToCsl, parseAuthorName } from '@beaver/agent-export/citations/externalCsl';
import { cslHtmlToText, parseCslHtml } from '@beaver/agent-export/citations/inlineHtml';
import { NormalizedPublicationType } from '@beaver/agent-core/types/externalReferences';

describe('externalReferenceToCsl', () => {
    it('maps backend metadata to CSL-JSON', () => {
        const csl = externalReferenceToCsl({
            source: 'openalex',
            title: 'A Study',
            authors: ['Jane Q. Doe', 'Roe, John'],
            publication_date: '2020-05-01',
            journal: { name: 'Journal', volume: '3', issue: '2', pages: '10-20' },
            identifiers: { doi: '10.1/x' },
            url: 'https://example.com',
            publication_types: [NormalizedPublicationType.BOOK_CHAPTER],
            library_items: [],
        }, 'ext-1');
        expect(csl).toEqual({
            id: 'ext-1',
            type: 'chapter',
            title: 'A Study',
            author: [{ family: 'Doe', given: 'Jane Q.' }, { family: 'Roe', given: 'John' }],
            issued: { 'date-parts': [[2020, 5, 1]] },
            'container-title': 'Journal',
            volume: '3',
            issue: '2',
            page: '10-20',
            DOI: '10.1/x',
        });
    });

    it('keeps single-word names literal and falls back to the year', () => {
        expect(parseAuthorName('Plato')).toEqual({ literal: 'Plato' });
        expect(externalReferenceToCsl({ source: 'openalex', year: 1999, library_items: [] }, 'x').issued)
            .toEqual({ 'date-parts': [[1999]] });
    });
});

describe('parseCslHtml', () => {
    it('reads the inline styling a CSL processor emits and decodes entities', () => {
        expect(parseCslHtml('Smith &#38; Jones, <i>Title</i> <span style="font-variant:small-caps;">sc</span><sup>2</sup>')).toEqual([
            { text: 'Smith & Jones, ' },
            { text: 'Title', italic: true },
            { text: ' ' },
            { text: 'sc', smallCaps: true },
            { text: '2', superscript: true },
        ]);
    });

    it('turns a left-margin column into a tab', () => {
        const html = '<div class="csl-entry">\n  <div class="csl-left-margin">[1]</div><div class="csl-right-inline">Entry</div>\n</div>';
        expect(cslHtmlToText(html)).toBe('[1]\tEntry');
    });
});

import { describe, expect, it } from 'vitest';
import {
    importItemDisplayJson,
    itemJsonDisplay,
    type ImportItemProposedData,
    type ZoteroItemJson,
} from '@beaver/agent-core/types/itemImport';

describe('itemJsonDisplay', () => {
    it('uses a statute\'s name of act or a case\'s name as the title', () => {
        expect(itemJsonDisplay({ itemType: 'statute', nameOfAct: 'API Standards', shortTitle: 'API' }).title).toBe('API Standards');
        expect(itemJsonDisplay({ itemType: 'case', caseName: 'Brown v. Board of Education' }).title).toBe('Brown v. Board of Education');
    });

    it('summarizes a journal article for a UI row', () => {
        const display = itemJsonDisplay({
            itemType: 'journalArticle',
            title: ' Deep learning ',
            creators: [{ creatorType: 'author', firstName: 'Y', lastName: 'LeCun' }],
            date: '2015-05-28',
            publicationTitle: 'Nature',
            abstractNote: 'An abstract',
            DOI: '10.1038/nature14539',
            url: 'https://www.nature.com/articles/nature14539',
        });
        expect(display).toMatchObject({
            title: 'Deep learning',
            itemType: 'journalArticle',
            creatorsSummary: 'LeCun',
            year: '2015',
            venue: 'Nature',
            abstract: 'An abstract',
            doi: '10.1038/nature14539',
            site: 'nature.com',
        });
    });

    it('formats one, two and many creators', () => {
        const creators = (...names: string[]) => names.map((lastName) => ({ creatorType: 'author', lastName }));
        expect(itemJsonDisplay({ itemType: 'book', creators: creators('Smith') }).creatorsSummary).toBe('Smith');
        expect(itemJsonDisplay({ itemType: 'book', creators: creators('Smith', 'Jones') }).creatorsSummary).toBe('Smith & Jones');
        expect(itemJsonDisplay({ itemType: 'book', creators: creators('Smith', 'Jones', 'Lee') }).creatorsSummary).toBe('Smith et al.');
    });

    it('prefers authors over other roles but falls back to any creator', () => {
        const mixed = itemJsonDisplay({
            itemType: 'book',
            creators: [
                { creatorType: 'translator', lastName: 'Trans' },
                { creatorType: 'author', lastName: 'Writer' },
            ],
        });
        expect(mixed.creatorsSummary).toBe('Writer');

        const onlyTranslator = itemJsonDisplay({
            itemType: 'book',
            creators: [{ creatorType: 'translator', lastName: 'Trans' }],
        });
        expect(onlyTranslator.creatorsSummary).toBe('Trans');
    });

    it('uses single-field names and first names when no last name exists', () => {
        expect(itemJsonDisplay({ itemType: 'report', creators: [{ creatorType: 'author', name: 'WHO' }] }).creatorsSummary).toBe('WHO');
        expect(itemJsonDisplay({ itemType: 'report', creators: [{ creatorType: 'author', firstName: 'Plato' }] }).creatorsSummary).toBe('Plato');
    });

    it('falls back to the short title, then to "Untitled"', () => {
        expect(itemJsonDisplay({ itemType: 'book', shortTitle: 'Short' }).title).toBe('Short');
        expect(itemJsonDisplay({ itemType: 'book' }).title).toBe('Untitled');
        expect(itemJsonDisplay({ itemType: 'book', title: '   ' }).title).toBe('Untitled');
    });

    it('picks the first available venue field in priority order', () => {
        expect(itemJsonDisplay({ itemType: 'conferencePaper', proceedingsTitle: 'ICML', publisher: 'ACM' }).venue).toBe('ICML');
        expect(itemJsonDisplay({ itemType: 'book', publisher: 'MIT Press' }).venue).toBe('MIT Press');
        expect(itemJsonDisplay({ itemType: 'book' }).venue).toBeUndefined();
    });

    it('extracts the year from free-form dates and ignores dates without one', () => {
        expect(itemJsonDisplay({ itemType: 'book', date: 'March 3, 1999' }).year).toBe('1999');
        expect(itemJsonDisplay({ itemType: 'book', date: 'n.d.' }).year).toBeUndefined();
    });

    it('reads numeric field values and the host of a url', () => {
        const display = itemJsonDisplay({ itemType: 'webpage', title: 'T', date: 2020, url: 'http://example.org:8080/a?b=1' });
        expect(display.year).toBe('2020');
        expect(display.site).toBe('example.org:8080');
    });

    it('reports ISBN and omits site for a non-http url', () => {
        const display = itemJsonDisplay({ itemType: 'book', title: 'B', ISBN: '9780262035613', url: 'ftp://x.org/a' });
        expect(display.isbn).toBe('9780262035613');
        expect(display.site).toBeUndefined();
    });
});

describe('importItemDisplayJson', () => {
    const item: ZoteroItemJson = { itemType: 'book', title: 'Resolved' };
    const fallback: ZoteroItemJson = { itemType: 'book', title: 'Fallback' };
    const source = { kind: 'identifier' as const, input: 'doi:10.1/x' };

    it('returns undefined without data', () => {
        expect(importItemDisplayJson(undefined)).toBeUndefined();
    });

    it('prefers the resolved item over the pending fallback', () => {
        const data: ImportItemProposedData = { source, item, pending_resolution: { fallback_item: fallback } };
        expect(importItemDisplayJson(data)).toBe(item);
    });

    it('uses the pending-resolution fallback for citation-derived actions', () => {
        const data: ImportItemProposedData = { source, pending_resolution: { fallback_item: fallback } };
        expect(importItemDisplayJson(data)).toBe(fallback);
    });

    it('returns undefined when neither exists', () => {
        expect(importItemDisplayJson({ source })).toBeUndefined();
    });
});

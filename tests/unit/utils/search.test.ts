import { describe, expect, it } from 'vitest';
import { normalizeQuickSearchQuery, rankSearchResults, scoreSearchResult } from '../../../react/utils/search';
import { createMockItem } from '../../helpers/factories';

describe('scoreSearchResult', () => {
    it('ranks earlier author matches above buried coauthor matches', () => {
        const firstAuthorMatch = createMockItem({
            fields: {
                title: 'Aggressive Policing and the Educational Performance of Minority Youth',
                date: '2018',
            },
            creators: [
                { firstName: 'Joscha', lastName: 'Legewie', creatorType: 'author' },
                { firstName: 'Jeffrey', lastName: 'Fagan', creatorType: 'author' },
            ],
        }) as Zotero.Item;
        const buriedCoauthorMatch = createMockItem({
            fields: {
                title: 'Public Policy and Educational Inequality',
                date: '2020',
            },
            creators: [
                { firstName: 'David', lastName: 'Brady', creatorType: 'author' },
                { firstName: 'Ryan', lastName: 'Finnigan', creatorType: 'author' },
                { firstName: 'Ulrich', lastName: 'Kohler', creatorType: 'author' },
                { firstName: 'Joscha', lastName: 'Legewie', creatorType: 'author' },
            ],
        }) as Zotero.Item;

        expect(scoreSearchResult(firstAuthorMatch, 'legewie')).toBeGreaterThan(
            scoreSearchResult(buriedCoauthorMatch, 'legewie')
        );
    });

    it('uses newer publication years as the tie breaker for equivalent matches', () => {
        const olderMatch = createMockItem({
            fields: {
                title: 'Aggressive Policing and Educational Outcomes',
                date: '2018',
            },
            creators: [{ firstName: 'Joscha', lastName: 'Legewie', creatorType: 'author' }],
        }) as Zotero.Item;
        const newerMatch = createMockItem({
            fields: {
                title: 'Local Policing and Educational Outcomes',
                date: '2022',
            },
            creators: [{ firstName: 'Joscha', lastName: 'Legewie', creatorType: 'author' }],
        }) as Zotero.Item;

        expect(scoreSearchResult(newerMatch, 'legewie')).toBeGreaterThan(
            scoreSearchResult(olderMatch, 'legewie')
        );
    });

    it('ranks earlier title matches above later title matches', () => {
        const titleStartsWithMatch = createMockItem({
            fields: {
                title: 'Legewie figures',
                date: '2019',
            },
        }) as Zotero.Item;
        const laterTitleMatch = createMockItem({
            fields: {
                title: 'Figures and Legewie',
                date: '2019',
            },
        }) as Zotero.Item;

        expect(scoreSearchResult(titleStartsWithMatch, 'legewie')).toBeGreaterThan(
            scoreSearchResult(laterTitleMatch, 'legewie')
        );
    });
});

describe('rankSearchResults', () => {
    const item = (key: string, title: string, libraryID = 1, publicationTitle = '') => createMockItem({
        key,
        libraryID,
        fields: { title, date: '2020', publicationTitle },
    }) as Zotero.Item;

    it('keeps a match the scorer cannot read, after the ones it can', () => {
        const journalOnly = item('JOURNAL1', 'Policing and Schools', 1, 'Sociological Review');
        const titled = item('TITLED01', 'A Review of Policing');

        expect(rankSearchResults([journalOnly, titled], 'review').map((i) => i.key))
            .toEqual(['TITLED01', 'JOURNAL1']);
    });

    it('orders equal scores by library and key, whatever order they arrive in', () => {
        const groupItem = item('AAAAAAAA', 'Policing', 5);
        const laterKey = item('BBBBBBBB', 'Policing', 1);
        const earlierKey = item('AAAAAAAA', 'Policing', 1);

        expect(rankSearchResults([groupItem, laterKey, earlierKey], 'policing').map((i) => `${i.libraryID}/${i.key}`))
            .toEqual(['1/AAAAAAAA', '1/BBBBBBBB', '5/AAAAAAAA']);
    });
});

describe('normalizeQuickSearchQuery', () => {
    it('turns every comma and ampersand into a word break', () => {
        expect(normalizeQuickSearchQuery('Smith, Jones, Brown & Lee').split(/\s+/))
            .toEqual(['Smith', 'Jones', 'Brown', 'Lee']);
    });

    it('drops joining words between names', () => {
        expect(normalizeQuickSearchQuery('Smith and Jones 2020').split(/\s+/)).toEqual(['Smith', 'Jones', '2020']);
    });

    it('splits a year typed straight after a name', () => {
        expect(normalizeQuickSearchQuery('smith2020')).toBe('smith 2020');
    });

    it('leaves an item key ending in digits whole', () => {
        expect(normalizeQuickSearchQuery('2DWQHP99')).toBe('2DWQHP99');
        expect(normalizeQuickSearchQuery('Smith 2DWQHP99')).toBe('Smith 2DWQHP99');
    });
});

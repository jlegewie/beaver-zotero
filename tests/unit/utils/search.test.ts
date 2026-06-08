import { describe, expect, it } from 'vitest';
import { scoreSearchResult } from '../../../react/utils/search';
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

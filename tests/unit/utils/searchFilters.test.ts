import { describe, expect, it } from 'vitest';
import {
    matchesPublicationYear,
    matchesCreatorName,
} from '../../../src/utils/searchFilters';

describe('publication-year bounds', () => {
    it.each(['', null, 'undated', '0000-00-00'])(
        'excludes unknown date %s when bounded',
        (date) => {
            expect(matchesPublicationYear(date, 2020)).toBe(false);
            expect(matchesPublicationYear(date, undefined, 2010)).toBe(false);
            expect(matchesPublicationYear(date)).toBe(true);
        },
    );
    it.each(['2016', '2016-00-00', '2016-01', '2016-01-01', 'June 2016'])(
        'uses inclusive years for %s',
        (date) => {
            expect(matchesPublicationYear(date, undefined, 2015)).toBe(false);
            expect(matchesPublicationYear(date, 2017)).toBe(false);
            expect(matchesPublicationYear(date, 2016, 2016)).toBe(true);
        },
    );
});

describe('creator-name matching', () => {
    const creators = [
        { firstName: 'Joscha', lastName: 'Legewie' },
        { firstName: 'Jeffrey', lastName: 'Fagan' },
    ];
    it.each(['joscha', 'LEGEWIE', 'Joscha Legewie', 'Legewie, Joscha'])(
        'matches %s',
        (query) => {
            expect(matchesCreatorName(creators, query)).toBe(true);
        },
    );
    it('requires the tokens to belong to one creator', () => {
        expect(matchesCreatorName(creators, 'Joscha Fagan')).toBe(false);
        expect(matchesCreatorName(creators, '')).toBe(false);
    });
    it('supports institutional creators', () => {
        expect(
            matchesCreatorName(
                [{ lastName: 'World Health Organization' }],
                'world health',
            ),
        ).toBe(true);
    });
});

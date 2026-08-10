import { describe, it, expect } from 'vitest';
import { areItemsDuplicates, deduplicateItems } from '../../../src/utils/zoteroUtils';
import { createMockItem } from '../../helpers/factories';

const VALID_ISBN = '978-0-306-40615-7';
const OTHER_ISBN = '0-306-40615-2';

/** A regular item with the fields duplicate detection reads. */
function item(opts: {
    id: number;
    libraryID?: number;
    itemTypeID?: number;
    title?: string;
    date?: string;
    doi?: string;
    isbn?: string;
    creators?: Array<{ firstName?: string; lastName?: string; creatorType: string }>;
}) {
    const mock = createMockItem({
        id: opts.id,
        libraryID: opts.libraryID ?? 1,
        fields: {
            ...(opts.title !== undefined ? { title: opts.title } : {}),
            ...(opts.date !== undefined ? { date: opts.date } : {}),
            ...(opts.doi !== undefined ? { DOI: opts.doi } : {}),
            ...(opts.isbn !== undefined ? { ISBN: opts.isbn } : {}),
        },
        creators: opts.creators ?? [],
    });
    return Object.assign(mock, { itemTypeID: opts.itemTypeID ?? 2 }) as unknown as Zotero.Item;
}

describe('areItemsDuplicates', () => {
    it('treats the same item as a duplicate of itself', () => {
        const a = item({ id: 1, title: 'Paper' });
        expect(areItemsDuplicates(a, a)).toBe(true);
    });

    it('never matches items of different types', () => {
        const a = item({ id: 1, itemTypeID: 2, title: 'Paper', date: '2020' });
        const b = item({ id: 2, itemTypeID: 7, title: 'Paper', date: '2020' });
        expect(areItemsDuplicates(a, b)).toBe(false);
    });

    describe('identifier rules', () => {
        it('matches on an equal DOI', () => {
            const a = item({ id: 1, doi: '10.1/AbC', title: 'One' });
            const b = item({ id: 2, doi: '10.1/abc', title: 'Two' });
            expect(areItemsDuplicates(a, b)).toBe(true);
        });

        it('rejects differing DOIs even when the rest of the metadata agrees', () => {
            const a = item({ id: 1, doi: '10.1/aaa', title: 'Paper', date: '2020' });
            const b = item({ id: 2, doi: '10.1/bbb', title: 'Paper', date: '2020' });
            expect(areItemsDuplicates(a, b)).toBe(false);
        });

        it('matches on an equal ISBN regardless of hyphenation', () => {
            const a = item({ id: 1, isbn: VALID_ISBN, title: 'One' });
            const b = item({ id: 2, isbn: VALID_ISBN.replace(/-/g, ''), title: 'Two' });
            expect(areItemsDuplicates(a, b)).toBe(true);
        });

        it('rejects differing ISBNs even when the rest of the metadata agrees', () => {
            const a = item({ id: 1, isbn: VALID_ISBN, title: 'Book', date: '2020' });
            const b = item({ id: 2, isbn: OTHER_ISBN, title: 'Book', date: '2020' });
            expect(areItemsDuplicates(a, b)).toBe(false);
        });

        it('keeps a valid identifier authoritative against unparseable text', () => {
            const a = item({ id: 1, isbn: VALID_ISBN, title: 'Book', date: '2020' });
            const b = item({ id: 2, isbn: 'unknown', title: 'Book', date: '2020' });
            expect(areItemsDuplicates(a, b)).toBe(false);
        });

        it('falls back to title and year when neither identifier parses', () => {
            const a = item({ id: 1, isbn: 'unknown', title: 'Book', date: '2020' });
            const b = item({ id: 2, isbn: 'n/a', title: 'Book', date: '2020' });
            expect(areItemsDuplicates(a, b)).toBe(true);
        });

        it('does not treat two unparseable identifiers as a match on their own', () => {
            const a = item({ id: 1, isbn: 'unknown', title: 'One Thing', date: '1990' });
            const b = item({ id: 2, isbn: 'n/a', title: 'Another Thing', date: '2020' });
            expect(areItemsDuplicates(a, b)).toBe(false);
        });

        it('falls back to title and year when only one item has an identifier', () => {
            const a = item({ id: 1, isbn: VALID_ISBN, title: 'Book', date: '2020' });
            const b = item({ id: 2, title: 'Book', date: '2020' });
            expect(areItemsDuplicates(a, b)).toBe(true);
        });
    });

    describe('title fallback', () => {
        it('matches on title plus a year within one', () => {
            const a = item({ id: 1, title: 'Climate Policy', date: '2019' });
            const b = item({ id: 2, title: 'climate  policy!', date: '2020' });
            expect(areItemsDuplicates(a, b)).toBe(true);
        });

        it('rejects a matching title when the years are further apart', () => {
            const a = item({ id: 1, title: 'Climate Policy', date: '2015' });
            const b = item({ id: 2, title: 'Climate Policy', date: '2020' });
            expect(areItemsDuplicates(a, b)).toBe(false);
        });

        it('matches on title plus a shared creator when the years are unusable', () => {
            const creators = [{ lastName: 'Müller', firstName: 'Anna', creatorType: 'author' }];
            const a = item({ id: 1, title: 'Climate Policy', creators });
            const b = item({ id: 2, title: 'Climate Policy', creators: [{ lastName: 'Muller', firstName: 'A.', creatorType: 'author' }] });
            expect(areItemsDuplicates(a, b)).toBe(true);
        });

        it('never matches items without a title', () => {
            const a = item({ id: 1, date: '2020' });
            const b = item({ id: 2, date: '2020' });
            expect(areItemsDuplicates(a, b)).toBe(false);
        });
    });
});

describe('deduplicateItems', () => {
    it('keeps the copy from the preferred library', () => {
        const group = item({ id: 1, libraryID: 3, doi: '10.1/x', title: 'Paper' });
        const personal = item({ id: 2, libraryID: 1, doi: '10.1/x', title: 'Paper' });
        expect(deduplicateItems([group, personal], 1)).toEqual([personal]);
    });

    it('leaves distinct items untouched and preserves their order', () => {
        const a = item({ id: 1, doi: '10.1/a', title: 'A' });
        const b = item({ id: 2, doi: '10.1/b', title: 'B' });
        expect(deduplicateItems([a, b], 1)).toEqual([a, b]);
    });
});

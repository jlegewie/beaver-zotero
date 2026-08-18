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

    it('does not compare every pair of same-titled items an identifier separates', () => {
        // The worst case for bucketing is a title thousands of items share
        // ("Editorial" in a large library). None of them pair, so nothing is
        // ever marked processed and every pass sees the whole bucket.
        //
        // Splitting the title bucket by DOI is what makes the common form of
        // that case cheap: a pair that both carry a live DOI is settled by the
        // DOI outright, and equal DOIs are already paired by the DOI bucket, so
        // those pairs never need to be drawn from the title bucket.
        //
        // Only timing can observe this from outside — the result is identical
        // either way — so the two shapes are measured against each other rather
        // than against a wall-clock budget, which keeps the assertion about
        // complexity instead of machine speed. Measured at n=4000: ~30ms
        // separated vs ~255ms unseparated; without the split the two are equal.
        const size = 4000;
        const timed = (items: Zotero.Item[]): number => {
            const startedAt = Date.now();
            const deduplicated = deduplicateItems(items, 1);
            // Nothing collapses in either shape, so any drop means the
            // partition lost a real match rather than a wasted comparison.
            expect(deduplicated).toHaveLength(items.length);
            return Date.now() - startedAt;
        };

        // Distinct DOIs: the DOI rule settles every pair, so the split applies.
        const separated = Array.from({ length: size }, (_, index) =>
            item({ id: index + 1, doi: `10.1/unique-${index}`, title: 'Editorial', date: String(1000 + index * 3) })
        );
        // No identifiers and years far enough apart to never corroborate: the
        // DOI rule never applies, so this shape keeps the all-pairs cost and
        // calibrates what "quadratic on this machine" means.
        const unseparated = Array.from({ length: size }, (_, index) =>
            item({ id: index + 1, title: 'Editorial', date: String(1000 + index * 3) })
        );

        const separatedMs = timed(separated);
        const unseparatedMs = timed(unseparated);

        expect(separatedMs * 3).toBeLessThan(unseparatedMs);
    });

    it('matches an exhaustive all-pairs scan on adversarial inputs', () => {
        // deduplicateItems buckets candidates by id/DOI/ISBN/title instead of
        // comparing every pair, because a broad multi-library search otherwise
        // does tens of millions of comparisons on Zotero's main thread. The
        // bucketing is only sound because every match rule needs an exact hit
        // on one of those keys, so this pins it against the scan it replaces.
        //
        // The fixtures below are picked for the cases where bucketing could
        // plausibly diverge: values that survive on one side and normalize away
        // on the other, pairs that agree on a title but are split by their
        // identifiers, and rows carrying no bucketable key at all.
        const reference = (items: Zotero.Item[], preferredLibraryId: number): Zotero.Item[] => {
            const out: Zotero.Item[] = [];
            const processed = new Set<number>();
            for (let i = 0; i < items.length; i++) {
                if (processed.has(i)) continue;
                let best = items[i];
                for (let j = i + 1; j < items.length; j++) {
                    if (processed.has(j)) continue;
                    if (areItemsDuplicates(items[i], items[j])) {
                        processed.add(j);
                        if (items[j].libraryID === preferredLibraryId && best.libraryID !== preferredLibraryId) {
                            best = items[j];
                        }
                    }
                }
                out.push(best);
            }
            return out;
        };

        const fixtures: Zotero.Item[] = [
            item({ id: 1, libraryID: 3, doi: '10.1/x', title: 'Shared Title', date: '2020' }),
            item({ id: 2, libraryID: 1, doi: '10.1/X', title: 'shared title', date: '2021' }),
            // Same title, differing DOIs — the identifier rule must still split them.
            item({ id: 3, libraryID: 1, doi: '10.1/other', title: 'Shared Title', date: '2020' }),
            // Whitespace-only DOIs normalize away, so these fall back to title.
            item({ id: 4, libraryID: 2, doi: '   ', title: 'Whitespace Doi', date: '2019' }),
            item({ id: 5, libraryID: 1, doi: '  ', title: 'Whitespace Doi', date: '2019' }),
            // One real DOI against one that normalizes away: not a duplicate.
            item({ id: 6, libraryID: 1, doi: '10.1/real', title: 'Whitespace Doi', date: '2019' }),
            item({ id: 7, libraryID: 1, isbn: VALID_ISBN, title: 'Book' }),
            item({ id: 8, libraryID: 3, isbn: VALID_ISBN.replace(/-/g, ''), title: 'Other Book' }),
            item({ id: 9, libraryID: 1, isbn: OTHER_ISBN, title: 'Book' }),
            // Unparseable ISBNs clean to nothing, so the title rule decides.
            item({ id: 10, libraryID: 1, isbn: 'not-an-isbn', title: 'Book', date: '2001' }),
            // No bucketable key at all: no title, no identifiers.
            item({ id: 11, libraryID: 1, date: '2020' }),
            item({ id: 12, libraryID: 1, date: '2020' }),
            // Title match corroborated by a creator rather than a year.
            item({ id: 13, libraryID: 3, title: 'Creator Match', creators: [{ lastName: 'Müller', firstName: 'Anna', creatorType: 'author' }] }),
            item({ id: 14, libraryID: 1, title: 'Creator Match', creators: [{ lastName: 'Muller', firstName: 'A.', creatorType: 'author' }] }),
            // Same title, different item type — never a duplicate.
            item({ id: 15, libraryID: 1, itemTypeID: 7, title: 'Shared Title', date: '2020' }),
        ];

        // Order decides which copy survives, so check several orderings rather
        // than only the one the fixtures happen to be written in.
        const orderings: Zotero.Item[][] = [
            fixtures,
            [...fixtures].reverse(),
            [...fixtures].filter((_, i) => i % 2 === 0).concat(fixtures.filter((_, i) => i % 2 === 1)),
        ];

        for (const ordering of orderings) {
            for (const preferred of [1, 3]) {
                expect(deduplicateItems(ordering, preferred)).toEqual(reference(ordering, preferred));
            }
        }
    });
});

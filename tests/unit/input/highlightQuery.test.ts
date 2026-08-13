import { describe, expect, it } from 'vitest';
import { queryMatchRanges } from '../../../react/components/ui/menus/utils/highlightQuery';

/** The matched substrings, in the order they appear in the text. */
const matches = (text: string, query: string): string[] =>
    queryMatchRanges(text, query).map(([start, end]) => text.slice(start, end));

describe('queryMatchRanges', () => {
    it('matches a plain substring', () => {
        expect(matches('Smith et al. 2020', 'smith')).toEqual(['Smith']);
    });

    it('ignores case in both directions', () => {
        expect(matches('smith', 'SMITH')).toEqual(['smith']);
        expect(matches('SMITH', 'smith')).toEqual(['SMITH']);
    });

    it('matches each query token separately, as the source search scores them', () => {
        // "smith 2020" never appears contiguously in the displayed text.
        expect(matches('Smith et al. 2020', 'smith 2020')).toEqual(['Smith', '2020']);
    });

    it('matches tokens in any order', () => {
        expect(matches('Smith et al. 2020', '2020 smith')).toEqual(['Smith', '2020']);
    });

    it('matches every occurrence of a token', () => {
        expect(matches('the cat and the hat', 'the')).toEqual(['the', 'the']);
    });

    it('merges overlapping token matches instead of nesting them', () => {
        // 'art' also matches inside 'article'; one range must come out, not two.
        expect(matches('article', 'art article')).toEqual(['article']);
    });

    it('merges adjacent token matches into one range', () => {
        expect(queryMatchRanges('abcd', 'ab cd')).toEqual([[0, 4]]);
    });

    it('returns nothing when a token is absent', () => {
        expect(matches('Smith et al. 2020', 'jones')).toEqual([]);
    });

    it('still highlights the tokens that did match when another did not', () => {
        // Results can rank on a partial token match, so the row is shown.
        expect(matches('Smith et al. 2020', 'smith jones')).toEqual(['Smith']);
    });

    it('ignores an empty or whitespace-only query', () => {
        expect(queryMatchRanges('Smith et al. 2020', '')).toEqual([]);
        expect(queryMatchRanges('Smith et al. 2020', '   ')).toEqual([]);
    });

    it('ignores empty text', () => {
        expect(queryMatchRanges('', 'smith')).toEqual([]);
    });

    it('collapses repeated whitespace between tokens', () => {
        expect(matches('Smith et al. 2020', '  smith   2020  ')).toEqual(['Smith', '2020']);
    });

    describe('normalization parity with the source search', () => {
        // normalizeSearchText: lowercase -> strip diacritics -> split on runs
        // of anything that is not a letter or a number.
        it('splits terms on punctuation, so citation-style queries highlight fully', () => {
            expect(matches('Smith et al. 2020', 'smith, 2020')).toEqual(['Smith', '2020']);
        });

        it('splits on an ampersand between creators', () => {
            expect(matches('Smith & Jones', 'smith & jones')).toEqual(['Smith', 'Jones']);
        });

        it('ignores a query that is only punctuation', () => {
            expect(queryMatchRanges('Smith et al. 2020', ',,,')).toEqual([]);
        });

        it('folds diacritics, matching what ranked the row', () => {
            expect(matches('Müller', 'muller')).toEqual(['Müller']);
            expect(matches('Muller', 'müller')).toEqual(['Muller']);
        });

        it('covers the whole accented character when a match starts inside it', () => {
            expect(matches('Müller', 'ller')).toEqual(['ller']);
            expect(matches('Müller', 'ul')).toEqual(['ül']);
        });
    });

    describe('offsets survive folds that change length', () => {
        it('maps back past a character whose lowercase form expands', () => {
            // 'İ'.toLowerCase() is two code units, so a naive indexOf into the
            // lowercased string reports 3 here and slices off the end of "AİB".
            expect(matches('AİB', 'b')).toEqual(['B']);
            expect(queryMatchRanges('AİB', 'b')).toEqual([[2, 3]]);
        });

        it('keeps a decomposed accent attached to its base letter', () => {
            const decomposed = 'u\u0308ber'; // "über" written as u + combining diaeresis
            expect(matches(decomposed, 'uber')).toEqual([decomposed]);
        });

        it('maps back past a surrogate pair', () => {
            expect(matches('𝐀 Smith', 'smith')).toEqual(['Smith']);
        });

        it('lowercases with whole-string semantics, not character by character', () => {
            // A Greek capital sigma lowercases to the final form at the end of a
            // word: the ranker sees 'ος', so folding 'Σ' in isolation to 'σ'
            // would match nothing the search itself matched on.
            expect('ΟΣ'.toLowerCase()).toBe('ος');
            expect(matches('ΟΣ', 'ος')).toEqual(['ΟΣ']);
            // Medial sigma keeps the non-final form.
            expect(matches('ΟΣΑ', 'οσα')).toEqual(['ΟΣΑ']);
        });
    });
});

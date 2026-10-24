import { describe, expect, it } from 'vitest';
import {
    bm25Scores,
    buildQueryTerms,
    ftsExpression,
    MAX_EXPANDED_TERMS,
    MAX_QUERY_TERMS,
    normalizeForSearch,
    selectPassages,
    termDisplay,
    termFrequency,
    tokenize,
} from '../../../../src/services/zoteroFulltext/text';

describe('normalizeForSearch', () => {
    it('folds case, diacritics and special letters the way Zotero indexes them', () => {
        expect(normalizeForSearch('Ärger Café-Größe Naïve Œuvre')).toBe('arger cafe-grosse naive oeuvre');
    });

    it('folds typographic dashes and quotes', () => {
        expect(normalizeForSearch('“self–report”')).toBe('"self-report"');
    });
});

describe('tokenize', () => {
    it('splits words on non-letters and keeps digits', () => {
        expect(tokenize('COVID-19 vaccine, 2021!')).toEqual(['covid', '19', 'vaccine', '2021']);
    });

    it('turns CJK runs into overlapping 2-grams', () => {
        expect(tokenize('气候变化 effects')).toEqual(['气候', '候变', '变化', 'effects']);
    });
});

describe('buildQueryTerms', () => {
    it('drops stopwords and keeps quoted phrases', () => {
        const { terms } = buildQueryTerms('What is the effect of "social capital" on health?');
        expect(terms.map(termDisplay)).toEqual(['"social capital"', 'effect', 'health']);
    });

    it('keeps stopword tokens when nothing else is left', () => {
        const { terms } = buildQueryTerms('the who');
        expect(terms.map(termDisplay)).toEqual(['the', 'who']);
    });

    it('adds keywords as phrases and de-duplicates them against the query', () => {
        const { terms } = buildQueryTerms('sleep duration', ['Sleep', 'sleep duration', 'insomnia', 'the']);
        expect(terms.map(termDisplay)).toEqual(['sleep', 'duration', '"sleep duration"', 'insomnia']);
        expect(terms.every((term) => term.source !== 'keyword' || term.text !== 'the')).toBe(true);
    });

    it('caps terms at 16 without keywords and 32 with them', () => {
        const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
        expect(buildQueryTerms(words.join(' ')).terms).toHaveLength(MAX_QUERY_TERMS);
        expect(buildQueryTerms(words.join(' ')).truncated).toBe(40 - MAX_QUERY_TERMS);
        const expanded = buildQueryTerms(words.slice(0, 10).join(' '), words.slice(10));
        expect(expanded.terms).toHaveLength(MAX_EXPANDED_TERMS);
        expect(expanded.truncated).toBe(40 - MAX_EXPANDED_TERMS);
    });

    it('caps distinct query terms, not repeated words', () => {
        const { terms, truncated } = buildQueryTerms(`${'sleep '.repeat(16)}insomnia`);
        expect(terms.map(termDisplay)).toEqual(['sleep', 'insomnia']);
        expect(truncated).toBe(0);
    });

    it('keeps room for keywords after a long query', () => {
        const query = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
        const { terms } = buildQueryTerms(query, ['sleep deprivation', 'insomnia']);
        expect(terms.filter((term) => term.source === 'query')).toHaveLength(MAX_QUERY_TERMS);
        expect(terms.filter((term) => term.source === 'keyword').map(termDisplay)).toEqual(['"sleep deprivation"', 'insomnia']);
    });

    it('drops words that phrase the request rather than its topic', () => {
        const { terms } = buildQueryTerms('find papers regarding glacier retreat');
        expect(terms.map(termDisplay)).toEqual(['glacier', 'retreat']);
    });

    it('keeps the spelling as written next to the folded tokens', () => {
        const { terms } = buildQueryTerms('Müller on "Straßenverkehr Größe"', ['Café society', 'naïve']);
        expect(terms.map((term) => [term.original, term.text])).toEqual([
            ['Straßenverkehr Größe', 'strassenverkehr grosse'],
            ['Müller', 'muller'],
            ['Café society', 'cafe society'],
            ['naïve', 'naive'],
        ]);
    });

    it('recomposes decomposed accents in the original spelling', () => {
        const [term] = buildQueryTerms('Mu\u0308ller').terms;
        expect(term.original).toBe('Müller');
        expect(term.text).toBe('muller');
    });

    it('routes CJK runs to separate terms', () => {
        const { terms } = buildQueryTerms('', ['气候变化 policy']);
        expect(terms.map((term) => [term.cjk, term.text])).toEqual([[true, '气候变化'], [false, 'policy']]);
    });
});

describe('ftsExpression', () => {
    it('ORs quoted terms of one table only', () => {
        const { terms } = buildQueryTerms('carbon tax', ['气候变化', 'emissions trading']);
        expect(ftsExpression(terms, false)).toBe('"carbon" OR "tax" OR "emissions trading"');
        expect(ftsExpression(terms, true)).toBe('"气候 候变 变化"');
    });
});

describe('bm25', () => {
    it('counts phrase occurrences only for adjacent tokens', () => {
        const [term] = buildQueryTerms('"social capital"').terms;
        expect(termFrequency(tokenize('social capital and capital social social capital'), term)).toBe(2);
    });

    it('ranks documents with rarer and more frequent terms higher', () => {
        const { terms } = buildQueryTerms('microplastics water');
        const docs = [
            'water quality water supply',
            'microplastics in drinking water',
            'microplastics microplastics water',
            'unrelated text about birds',
        ].map(tokenize);
        const scores = bm25Scores(docs, terms);
        expect(scores[3]).toBe(0);
        expect(scores[2]).toBeGreaterThan(scores[1]);
        expect(scores[1]).toBeGreaterThan(scores[0]);
    });
});

describe('selectPassages', () => {
    const doc = (...texts: string[]) => ({ passages: texts.map((text) => ({ text })) });

    it('returns matches best first, then fills round-robin across documents', () => {
        const { terms } = buildQueryTerms('glacier');
        const selected = selectPassages([
            doc('nothing here', 'glacier retreat glacier'),
            doc('alpine glacier', 'other words', 'more words'),
        ], terms, 5);
        expect(selected.slice(0, 2).map((e) => [e.candidate, e.passage])).toEqual([[0, 1], [1, 0]]);
        expect(selected.slice(2).map((e) => [e.candidate, e.passage, e.score])).toEqual([[0, 0, 0], [1, 1, 0], [1, 2, 0]]);
    });

    it('stops at the limit', () => {
        const { terms } = buildQueryTerms('a1');
        expect(selectPassages([doc('a1', 'a1 a1', 'b')], terms, 2)).toHaveLength(2);
    });
});

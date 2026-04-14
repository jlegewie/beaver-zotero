import { describe, it, expect } from 'vitest';

import { findCandidateSnippets } from '../../../src/utils/editNoteHints';

describe('findCandidateSnippets', () => {
    it('returns a single whitespace_relaxed candidate when old_string matches after whitespace collapse', () => {
        const simplified = '<p>The quick brown fox\n  jumps over the lazy dog.</p>';
        const oldString = 'quick brown fox jumps over the lazy dog';

        const candidates = findCandidateSnippets(simplified, oldString);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].via).toBe('whitespace_relaxed');
        expect(candidates[0].score).toBe(1);
        expect(candidates[0].snippet).toContain('quick brown fox');
    });

    it('returns up to N word-overlap candidates above the minScore threshold', () => {
        // Lines contain the same vocabulary but reordered so tier 1
        // (whitespace-relaxed substring match) cannot fire and tier 2 runs.
        const simplified = [
            '<p>delta alpha echo bravo charlie foxtrot</p>',   // all 5 search words
            '<p>unrelated line about cats sleeping today</p>',  // no overlap
            '<p>charlie delta mike bravo november alpha</p>',   // 4/5 overlap
            '<p>bravo alpha more things here also</p>',         // 2/5 (under 0.5)
        ].join('\n');
        const oldString = 'alpha bravo charlie delta echo';

        const candidates = findCandidateSnippets(simplified, oldString, {
            maxCandidates: 2,
        });
        expect(candidates.length).toBe(2);
        // All candidates must be word_overlap with score >= default 0.5
        for (const c of candidates) {
            expect(c.via).toBe('word_overlap');
            expect(c.score).toBeGreaterThanOrEqual(0.5);
        }
        // Highest scorer first
        for (let i = 1; i < candidates.length; i += 1) {
            expect(candidates[i - 1].score).toBeGreaterThanOrEqual(candidates[i].score);
        }
    });

    it('returns empty array when nothing scores above minScore', () => {
        // Only one shared word ("foxtrot") against six search words → score ~0.17
        const simplified = '<p>foxtrot alone amid unrelated prose about cats.</p>';
        const oldString = 'foxtrot alpha bravo charlie delta echo';

        const candidates = findCandidateSnippets(simplified, oldString);
        expect(candidates).toEqual([]);
    });

    it('does not let repeated words inflate word-overlap score above 1', () => {
        const simplified = '<p>alpha alpha alpha alpha bravo trailing context here</p>';
        const oldString = 'bravo alpha missing';

        const candidates = findCandidateSnippets(simplified, oldString, {
            minScore: 0.1,
        });
        expect(candidates).toHaveLength(1);
        expect(candidates[0].via).toBe('word_overlap');
        expect(candidates[0].score).toBeCloseTo(2 / 3, 5);
    });

    it('truncates long lines with … markers and sets truncated flag', () => {
        const longLine = '<p>' + 'alpha '.repeat(80) + 'bravo charlie delta echo foxtrot golf hotel</p>';
        const simplified = longLine;
        const oldString = 'bravo charlie delta echo foxtrot golf hotel';

        const candidates = findCandidateSnippets(simplified, oldString, {
            maxSnippetLength: 120,
        });
        expect(candidates.length).toBeGreaterThan(0);
        const top = candidates[0];
        expect(top.truncated).toBe(true);
        // snippet length is bounded by maxSnippetLength plus up to two … chars
        expect(top.snippet.length).toBeLessThanOrEqual(122);
        // At least one side is marked truncated
        expect(top.snippet.startsWith('…') || top.snippet.endsWith('…')).toBe(true);
    });

    it('respects a custom minScore that rejects previously-surfaced lines', () => {
        // Matches exactly 30% of search words (legacy threshold) — should
        // surface at 0.3 but not at default 0.5.
        const simplified = '<p>apples bananas cherries carried by unrelated travelers.</p>';
        const oldString = 'apples bananas cherries xylophone yoyo zebra kite lime mango nine';

        expect(findCandidateSnippets(simplified, oldString, { minScore: 0.3 }).length)
            .toBeGreaterThan(0);
        expect(findCandidateSnippets(simplified, oldString).length).toBe(0);
    });
});

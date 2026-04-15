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

    it('truncates long tier-2 candidate lines with … markers and sets truncated flag', () => {
        // Reordered so tier-1 (whitespace-relaxed substring) cannot fire and
        // tier-2 runs. The long repetition of "alpha" pads the line past the
        // snippet budget.
        const longLine = '<p>' + 'alpha '.repeat(80) + 'bravo charlie delta echo</p>';
        const simplified = longLine;
        const oldString = 'delta echo bravo charlie';

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

    it('tier-2 candidates preserve inline HTML tags so the agent can paste an exact substring', () => {
        const simplified = '<p>The <strong>critical</strong> passage about X and Y</p>';
        // Typo in "critical" prevents drift and exact match, but word overlap
        // is high enough to surface the line.
        const oldString = 'cirtical passage about X and Y';

        const candidates = findCandidateSnippets(simplified, oldString);
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0].snippet).toContain('<strong>critical</strong>');
    });

    it('tier-1 expands the snippet window so the full match is always visible for long old_strings', () => {
        // An old_string longer than the default 200-char snippet budget. If we
        // center-truncated at the default budget the `…` markers would land
        // inside the match, which the agent cannot paste verbatim.
        const longMatch = 'word '.repeat(60).trim();  // ~300 chars
        const simplified = `<p>prefix padding here ${longMatch} trailing padding here</p>`;
        const oldString = longMatch;

        const candidates = findCandidateSnippets(simplified, oldString);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].via).toBe('whitespace_relaxed');
        // The returned snippet must contain the full match verbatim.
        expect(candidates[0].snippet).toContain(longMatch);
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

import { describe, it, expect } from 'vitest';

import {
    DEFAULT_MAX_SNIPPET_LENGTH,
    findCandidateSnippets,
    MAX_PASTEABLE_SNIPPET_LENGTH,
} from '../../../src/utils/editNoteHints';
import { normalizeWS } from '../../../src/utils/noteHtmlEntities';

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

    it('returns a realistic note line whole, as a pasteable verbatim slice', () => {
        // A representative note paragraph — long prose plus a couple of
        // citation tags — clears the region budget but stays under the
        // pasteable ceiling, so it must come back intact for the agent to
        // paste straight back as old_string.
        const line =
            '<p>Participants reported markedly lower engagement across every '
            + 'measured condition, and the effect persisted after controlling '
            + 'for baseline differences in prior exposure '
            + '<citation item="u-57MQ9WYE" loc="page5"/>, a pattern that also '
            + 'held in the replication sample drawn from the second cohort '
            + '<citation item="u-FEFQH9TC" loc="page12"/>, though the authors '
            + 'caution that attrition may account for part of the gap.</p>';
        const simplified = `<p>Introductory paragraph.</p>\n${line}\n<p>Closing paragraph.</p>`;
        // Same words, reordered opening clause, so tier 1 cannot fire.
        const oldString =
            'engagement lower markedly reported participants across every '
            + 'measured condition baseline differences prior exposure';

        expect(line.length).toBeGreaterThan(DEFAULT_MAX_SNIPPET_LENGTH);
        expect(line.length).toBeLessThan(MAX_PASTEABLE_SNIPPET_LENGTH);

        const candidates = findCandidateSnippets(simplified, oldString);
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0].via).toBe('word_overlap');
        expect(candidates[0].truncated).toBe(false);
        expect(candidates[0].snippet).toBe(line);
        expect(simplified).toContain(candidates[0].snippet);
    });

    it('never reports truncated: false for a snippet that is not verbatim note text', () => {
        // `truncated: false` is a promise that the snippet can be pasted back
        // as old_string. Every tier must keep that promise.
        const cases: Array<[string, string]> = [
            // tier 1, whitespace drift inside the note
            ['<p>The quick brown fox\n  jumps over the lazy dog.</p>',
                'quick brown fox jumps over the lazy dog'],
            // tier 1, CJK Pangu spacing drift
            ['<p>CSCO 指南及 2026 版共识 [14] 将激素抵抗性 CIP 定义为初始足量糖皮质激素治疗。</p>',
                '<p>CSCO指南及2026版共识[14]将激素抵抗性CIP定义为初始足量糖皮质激素治疗。</p>'],
            // tier 2, word overlap on an indented line
            ['<ul>\n    <li>alpha bravo charlie delta echo foxtrot</li>\n</ul>',
                'alpha bravo charlie delta golf'],
            // tier 2, line longer than the snippet budget
            [`<p>${'padding words here '.repeat(120)}alpha bravo charlie delta</p>`,
                'delta charlie bravo alpha'],
        ];

        for (const [simplified, oldString] of cases) {
            for (const c of findCandidateSnippets(simplified, oldString)) {
                if (!c.truncated) {
                    expect(simplified).toContain(c.snippet);
                }
            }
        }
    });

    it('still truncates lines past the pasteable ceiling and marks them', () => {
        const longLine = '<p>' + 'alpha '.repeat(600) + 'bravo charlie delta echo</p>';
        const oldString = 'delta echo bravo charlie';

        const candidates = findCandidateSnippets(longLine, oldString);
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0].truncated).toBe(true);
        // Bounded by the ceiling, plus up to two … markers.
        expect(candidates[0].snippet.length)
            .toBeLessThanOrEqual(MAX_PASTEABLE_SNIPPET_LENGTH + 2);
        expect(candidates[0].snippet.startsWith('…')
            || candidates[0].snippet.endsWith('…')).toBe(true);
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

    // -- CJK Pangu-spacing tier 1 --

    it('tier-1 CJK snippet is sliced from the original note, not the normalized form', () => {
        // The note already has a Pangu space the model dropped from
        // old_string. The hint snippet must include that space so the model
        // can paste it back as an exact-matching old_string. Returning a
        // snippet from the normalized form (without the space) would violate
        // the "paste verbatim" contract.
        const simplified = '<p>CSCO 指南及 2026 版共识 [14] 将激素抵抗性 CIP 定义为初始足量糖皮质激素治疗。</p>';
        const oldString = '<p>CSCO指南及2026版共识[14]将激素抵抗性CIP定义为初始足量糖皮质激素治疗。</p>';

        const candidates = findCandidateSnippets(simplified, oldString);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].via).toBe('whitespace_relaxed');
        // The snippet must be a verbatim slice of the note.
        expect(simplified.indexOf(candidates[0].snippet.replace(/^…|…$/g, '')))
            .toBeGreaterThanOrEqual(0);
        // And must contain at least one of the boundary spaces the note has.
        expect(candidates[0].snippet).toMatch(/共识 \[14\]/);
    });

    // -- tier 1 returns the exact matched span --

    it('tier-1 returns the matched note span itself, not a window around it', () => {
        const simplified =
            '<p>Opening paragraph with unrelated prose.</p>\n'
            + '<p>The quick brown fox\n  jumps over the lazy dog.</p>\n'
            + '<p>Closing paragraph with unrelated prose.</p>';
        const oldString = 'quick brown fox jumps over the lazy dog';

        const candidates = findCandidateSnippets(simplified, oldString);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].via).toBe('whitespace_relaxed');
        expect(candidates[0].truncated).toBe(false);
        // The note's own version of old_string: same text, note whitespace.
        expect(candidates[0].snippet).toBe('quick brown fox\n  jumps over the lazy dog');
        expect(normalizeWS(candidates[0].snippet)).toBe(normalizeWS(oldString));
    });

    it('tier-1 CJK path returns the exact span with the note Pangu spacing', () => {
        const simplified = '<p>CSCO 指南及 2026 版共识 [14] 将激素抵抗性 CIP 定义为初始足量糖皮质激素治疗。</p>';
        const oldString = 'CSCO指南及2026版共识[14]将激素抵抗性CIP定义为';

        const candidates = findCandidateSnippets(simplified, oldString);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].via).toBe('whitespace_relaxed');
        expect(candidates[0].truncated).toBe(false);
        expect(candidates[0].snippet)
            .toBe('CSCO 指南及 2026 版共识 [14] 将激素抵抗性 CIP 定义为');
    });

    it('tier-1 returns a long match whole rather than clipping it', () => {
        const longMatch = 'word '.repeat(60).trim();  // ~300 chars
        const simplified = `<p>prefix padding here ${longMatch} trailing padding here</p>`;

        const candidates = findCandidateSnippets(simplified, longMatch);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].truncated).toBe(false);
        expect(candidates[0].snippet).toBe(longMatch);
        expect(candidates[0].snippet).not.toContain('…');
    });

    it('tier-1 falls back to a window when the matched span is ambiguous', () => {
        // The same sentence twice: pasting the bare span back would only swap
        // a not-found error for an ambiguous-match one.
        const repeated = '<p>Participants reported markedly lower engagement.</p>';
        const simplified = `${repeated}\n${repeated}`;
        const oldString = 'Participants reported  markedly lower engagement.';

        const candidates = findCandidateSnippets(simplified, oldString);
        expect(candidates).toHaveLength(1);
        expect(candidates[0].via).toBe('whitespace_relaxed');
        // Whatever comes back, it must not be the ambiguous span on its own.
        const snippet = candidates[0].snippet;
        expect(snippet).not.toBe('Participants reported markedly lower engagement.');
        if (!candidates[0].truncated) {
            expect(simplified.indexOf(snippet)).toBe(simplified.lastIndexOf(snippet));
        }
    });

    it('a tier-1 snippet marked pasteable is a unique verbatim slice of the note', () => {
        // The property that matters: feeding the snippet back as old_string
        // resolves to exactly one span of the note.
        const cases: Array<[string, string]> = [
            // whitespace drift inside the note
            ['<p>The quick brown fox\n  jumps over the lazy dog.</p>',
                'quick brown fox jumps over the lazy dog'],
            // literal &nbsp; where the agent wrote a plain space
            ['<p>Table&nbsp;3 reports the pooled estimate for each cohort.</p>',
                'Table 3 reports the pooled estimate'],
            // indentation the agent collapsed
            ['<ul>\n    <li>alpha bravo charlie</li>\n</ul>', '<li>alpha bravo charlie</li>'],
            // CJK Pangu spacing drift
            ['<p>CSCO 指南及 2026 版共识 [14] 将激素抵抗性 CIP 定义为初始足量糖皮质激素治疗。</p>',
                '<p>CSCO指南及2026版共识[14]将激素抵抗性CIP定义为初始足量糖皮质激素治疗。</p>'],
        ];

        for (const [simplified, oldString] of cases) {
            const [candidate] = findCandidateSnippets(simplified, oldString);
            expect(candidate.via).toBe('whitespace_relaxed');
            expect(candidate.truncated).toBe(false);
            expect(simplified.indexOf(candidate.snippet))
                .toBe(simplified.lastIndexOf(candidate.snippet));
            expect(simplified.indexOf(candidate.snippet)).toBeGreaterThanOrEqual(0);
        }
    });

    it('tier-1 does not surface tag-boundary spacing drift as a Pangu match', () => {
        // The matcher rejects this drift case (the boundary `文` ↔ `<` is at
        // an HTML delimiter, where Pangu relaxation is suppressed). The hint
        // must agree — otherwise the model would paste a snippet whose
        // tag-adjacent space is dropped and edit_note would loop.
        const simplified = '<p>中文 <strong>anchor</strong> with enough body for the length gate</p>';
        const oldString = '<p>中文<strong>anchor</strong> with enough body for the length gate</p>';

        const candidates = findCandidateSnippets(simplified, oldString);
        // Either no candidate at all, or fall through to a non-CJK tier — in
        // both cases the Pangu tier-1 path must not claim a match.
        if (candidates.length > 0) {
            // Whatever tier surfaced the candidate, its snippet must be a
            // verbatim slice of the note (i.e. preserve the boundary space).
            const snippet = candidates[0].snippet.replace(/^…|…$/g, '');
            expect(simplified.indexOf(snippet)).toBeGreaterThanOrEqual(0);
        }
    });
});

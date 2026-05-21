import { describe, it, expect } from 'vitest';

import { findWindowCandidates } from '../../../src/utils/editNoteHints';

describe('findWindowCandidates', () => {
    it('locates a region whose words are spread across many lines (Markdown row vs HTML cells)', () => {
        // old_string is a Markdown table row; the rendered note splits each
        // cell onto its own line, so no single line carries enough words for
        // the per-line scorer — only multi-line window scoring finds it.
        const simplified = [
            '<h2>Task Log</h2>',
            '<p>Some unrelated introductory paragraph about scheduling.</p>',
            '<table>',
            '<tbody>',
            '<tr>',
            '<td>',
            '<p>T-005</p>',
            '</td>',
            '<td>',
            '<p>Quote Log Torres 2013</p>',
            '</td>',
            '<td>',
            '<p>Critical tier Education Neoliberalism</p>',
            '</td>',
            '</tr>',
            '</tbody>',
            '</table>',
        ].join('\n');
        const oldString =
            '| T-005 | Quote Log Torres 2013 | Critical tier Education Neoliberalism |';

        const candidates = findWindowCandidates(simplified, oldString);

        expect(candidates.length).toBeGreaterThan(0);
        for (const c of candidates) {
            expect(c.via).toBe('fuzzy_window');
            // score is the region-level window overlap, shared by all lines.
            expect(c.score).toBeGreaterThanOrEqual(0.35);
        }
        // The returned anchors are the word-dense cell lines from the region.
        const snippets = candidates.map((c) => c.snippet).join('\n');
        expect(snippets).toContain('Quote Log Torres 2013');
    });

    it('returns [] when old_string has fewer than 3 content words', () => {
        const simplified = '<p>alpha beta gamma delta epsilon zeta eta theta</p>';
        expect(findWindowCandidates(simplified, 'the cat')).toEqual([]);
    });

    it('returns [] when no window clears the minimum overlap threshold', () => {
        const simplified = [
            '<p>The committee reviewed the quarterly budget projections.</p>',
            '<p>Attendance figures were stable across all departments.</p>',
        ].join('\n');
        // None of these content words appear in the note.
        const oldString = 'hippopotamus zebra giraffe elephant rhinoceros';
        expect(findWindowCandidates(simplified, oldString)).toEqual([]);
    });

    it('returns [] for empty old_string', () => {
        expect(findWindowCandidates('<p>some note text here</p>', '')).toEqual([]);
    });
});

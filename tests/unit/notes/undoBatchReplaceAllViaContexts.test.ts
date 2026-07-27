/**
 * Tests for `undoBatchReplaceAllViaContexts`, the batch-only str_replace_all
 * undo replay. Unlike the v1 helper it replaces, this walks occurrence
 * anchors one at a time against the CURRENT (evolving) string instead of
 * resolving every occurrence's range up front against a single snapshot —
 * see the function's doc comment in `react/utils/editNoteActions.ts` for the
 * capture/replay-order contract it relies on.
 */

import { describe, it, expect, vi } from 'vitest';

// =============================================================================
// Module Mocks (must be before imports) — minimal preamble so importing
// react/utils/editNoteActions.ts resolves; simplifier/expander/position
// lookups run with their REAL implementations since the function under test
// is pure and exercises them directly.
// =============================================================================

vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test-user' })),
}));

vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../react/utils/sourceUtils', () => ({
    clearNoteEditorSelection: vi.fn(),
}));

vi.mock('../../../react/store', () => ({
    store: { get: vi.fn(() => null), set: vi.fn(), sub: vi.fn() },
}));

vi.mock('../../../react/atoms/threads', () => ({
    currentThreadIdAtom: Symbol('currentThreadIdAtom'),
}));

vi.mock('../../../react/agents/agentActions', () => ({
    AgentAction: class {},
    updateAgentActionsAtom: Symbol('updateAgentActionsAtom'),
}));

vi.mock('../../../src/services/agentActionsService', () => ({
    agentActionsService: {
        updateAction: vi.fn().mockResolvedValue(undefined),
    },
}));

// =============================================================================
// Imports (real simplifier/position-lookup functions — NOT mocked)
// =============================================================================

import {
    undoBatchReplaceAllViaContexts,
    isBatchReplaceAllAlreadyUndone,
} from '../../../react/utils/editNoteActions';

const LIBRARY_ID = 1;

describe('undoBatchReplaceAllViaContexts', () => {
    it('restores a single occurrence via its context anchors', () => {
        const strippedHtml = '<p>H1</p>NEW<p>TAIL</p>';
        const result = undoBatchReplaceAllViaContexts(
            strippedHtml,
            'OLD',
            'NEW',
            [{ before: '<p>H1</p>', after: '<p>TAIL</p>' }],
            LIBRARY_ID,
        );
        expect(result).toBe('<p>H1</p>OLD<p>TAIL</p>');
    });

    it('replays occurrences one at a time against the evolving string when contexts quote a neighbor occurrence', () => {
        // Two occurrences of "NEW", captured per the replay-order contract:
        // occurrence 1's context assumes occurrence 0 (lower position) is
        // still applied; occurrence 0's context assumes occurrence 1 (higher
        // position, processed first in descending replay) is ALREADY
        // reverted. Neither context is findable against the ORIGINAL
        // fully-applied string alone — only against the string as it exists
        // partway through replay, which is exactly what this function walks.
        const strippedHtml = 'AAAANEWBBBBNEWCCCC';
        const occurrence0 = { before: 'AAAA', after: 'BBBBOLDCCCC' };
        const occurrence1 = { before: 'AAAANEWBBBB', after: 'CCCC' };

        const result = undoBatchReplaceAllViaContexts(
            strippedHtml,
            'OLD',
            'NEW',
            [occurrence1, occurrence0], // descending position order
            LIBRARY_ID,
        );
        expect(result).toBe('AAAAOLDBBBBOLDCCCC');
    });

    it('reinserts three contiguous deletions one at a time, separating each seam as it goes', () => {
        // All three occurrences of "OLD" sit back-to-back, so once deleted
        // they collapse onto the SAME zero-width point. Contexts are
        // captured in descending replay order: occurrence 2 (rightmost) is
        // captured and reverted first, which separates occurrence 1's seam
        // from occurrence 0's, and so on — each occurrence's `after` window
        // is pairwise distinct because it reflects a different number of
        // already-reinserted siblings.
        const strippedHtml = '<p>HEAD</p><p>TAIL</p>';
        const occurrence0 = { before: '<p>HEAD</p>', after: 'OLDOLD<p>TAIL</p>' };
        const occurrence1 = { before: '<p>HEAD</p>', after: 'OLD<p>TAIL</p>' };
        const occurrence2 = { before: '<p>HEAD</p>', after: '<p>TAIL</p>' };

        const result = undoBatchReplaceAllViaContexts(
            strippedHtml,
            'OLD',
            '',
            [occurrence2, occurrence1, occurrence0], // descending position order
            LIBRARY_ID,
        );
        expect(result).toBe('<p>HEAD</p>OLDOLDOLD<p>TAIL</p>');
    });

    it('skips an occurrence that is already restored without modifying it', () => {
        // occurrence1 (processed first, descending) is still applied and
        // gets spliced; occurrence0 (processed second) is already back to
        // undo_old_html and is left untouched.
        const strippedHtml = '<p>H1</p>OLD<p>SEP</p>NEW<p>TAIL</p>';
        const occurrence0 = { before: '<p>H1</p>', after: '<p>SEP</p>' };
        const occurrence1 = { before: '<p>SEP</p>', after: '<p>TAIL</p>' };

        const result = undoBatchReplaceAllViaContexts(
            strippedHtml,
            'OLD',
            'NEW',
            [occurrence1, occurrence0],
            LIBRARY_ID,
        );
        expect(result).toBe('<p>H1</p>OLD<p>SEP</p>OLD<p>TAIL</p>');
    });

    it('returns undefined when an occurrence context can no longer be located', () => {
        const strippedHtml = '<p>H1</p>NEW<p>TAIL</p>';
        const result = undoBatchReplaceAllViaContexts(
            strippedHtml,
            'OLD',
            'NEW',
            [{ before: '<p>NOPE</p>', after: '<p>ALSO-NOPE</p>' }],
            LIBRARY_ID,
        );
        expect(result).toBeUndefined();
    });

    it('returns undefined when the located region matches neither the applied nor the original fragment', () => {
        const strippedHtml = '<p>H1</p>SOMETHING-ELSE<p>TAIL</p>';
        const result = undoBatchReplaceAllViaContexts(
            strippedHtml,
            'OLD',
            'NEW',
            [{ before: '<p>H1</p>', after: '<p>TAIL</p>' }],
            LIBRARY_ID,
        );
        expect(result).toBeUndefined();
    });

    it('fails loud instead of silently skipping when two occurrences share a byte-identical context window', () => {
        // Both occurrences are wrapped in the exact same 'AAA' / 'BBB'
        // before/after text (a repeated template section), and undoOldHtml /
        // undoNewHtml are the same length ('OLD' / 'NEW'), so the post-splice
        // best-length search can't distinguish the restored occurrence from
        // the untouched one and re-resolves to the SAME leftmost match both
        // times. Without the duplicate-resolution guard this would splice
        // the left occurrence, then see undoOldHtml at that same position on
        // the second pass and silently skip it — leaving the right
        // occurrence applied while reporting success.
        const strippedHtml = 'AAANEWBBBAAANEWBBB';
        const occurrenceContext = { before: 'AAA', after: 'BBB' };

        const result = undoBatchReplaceAllViaContexts(
            strippedHtml,
            'OLD',
            'NEW',
            [occurrenceContext, occurrenceContext],
            LIBRARY_ID,
        );
        expect(result).toBeUndefined();
    });

    it('fails loud when two identical contexts both resolve onto the same already-restored region', () => {
        // Both occurrence records carry the exact same 'AAA' / 'BBB' anchors.
        // The document holds one already-restored 'OLD' region and one still-
        // applied 'NEW' region, both flanked by 'AAA'/'BBB'. Since undoOldHtml
        // and undoNewHtml are the same length, best-length scoring can't
        // distinguish them and resolves BOTH contexts to the same leftmost
        // ('OLD') region. The first pass skips it as already-restored; without
        // recording that skip as consumed, the second pass would resolve onto
        // the same 'OLD' region again, skip it too, and return the document
        // unchanged — silently leaving the right-hand 'NEW' occurrence applied
        // while reporting the whole record as already undone.
        const strippedHtml = 'AAAOLDBBBAAANEWBBB';
        const occurrenceContext = { before: 'AAA', after: 'BBB' };

        const result = undoBatchReplaceAllViaContexts(
            strippedHtml,
            'OLD',
            'NEW',
            [occurrenceContext, occurrenceContext],
            LIBRARY_ID,
        );
        expect(result).toBeUndefined();
    });

    it('fails loud when two identical contexts both resolve onto the same already-restored zero-width seam', () => {
        // An insertion-undo (undoOldHtml === '') always restores to a
        // zero-width point, so the consumed range recorded for it is also
        // zero-width. Two occurrence records with byte-identical 'AAA' /
        // 'BBB' anchors both target what should be distinct insertions, but
        // only one 'NEW' actually sits between them. The first pass splices
        // it away, collapsing the seam to a zero-width point; the second pass
        // resolves onto that same point. This exercises the zero-width
        // equality collision check directly (start === start), since the
        // strict-inequality overlap test can never flag two [s, s) ranges at
        // the same point as overlapping.
        const strippedHtml = 'AAANEWBBB';
        const occurrenceContext = { before: 'AAA', after: 'BBB' };

        const result = undoBatchReplaceAllViaContexts(
            strippedHtml,
            '',
            'NEW',
            [occurrenceContext, occurrenceContext],
            LIBRARY_ID,
        );
        expect(result).toBeUndefined();
    });

    it('fails loud when a context resolves inside the whitespace-padded extent of a skip-consumed region', () => {
        // An already-restored region is matched by NORMALIZED comparison, so
        // its resolved extent can be longer than undo_old_html itself — here
        // ' X' (leading space) normalizes equal to old 'X'. The consumed range
        // must record the full resolved extent [3,5), not a range sized to
        // undo_old_html: recording only [3,4) would leave the inner 'X' at
        // [4,5) uncovered, letting the second context skip it as another
        // independent already-restored occurrence and report success while a
        // still-applied occurrence elsewhere was never examined.
        const strippedHtml = 'QQQ XWWW';

        const result = undoBatchReplaceAllViaContexts(
            strippedHtml,
            'X',
            'NEW',
            [
                { before: 'QQQ', after: 'WWW' },
                { before: 'QQQ ', after: 'WWW' },
            ],
            LIBRARY_ID,
        );
        expect(result).toBeUndefined();
    });

    it('is idempotent across separate calls: re-running against an already-restored document skips every occurrence', () => {
        // This models a genuine retry (e.g. undo invoked twice): every
        // occurrence already holds undo_old_html and this run never splices
        // anything itself, so none of them can overlap a range this run
        // restored — the duplicate-resolution guard must not fire here.
        const strippedHtml = '<p>H1</p>OLD<p>SEP</p>OLD<p>TAIL</p>';
        const occurrence0 = { before: '<p>H1</p>', after: '<p>SEP</p>' };
        const occurrence1 = { before: '<p>SEP</p>', after: '<p>TAIL</p>' };

        const result = undoBatchReplaceAllViaContexts(
            strippedHtml,
            'OLD',
            'NEW',
            [occurrence1, occurrence0],
            LIBRARY_ID,
        );
        expect(result).toBe(strippedHtml);
    });
});

describe('isBatchReplaceAllAlreadyUndone', () => {
    it('returns false when the raw applied text is absent but its normalized form is present', () => {
        // The note holds the applied fragment in an entity-encoded form
        // (&#x27;) that ProseMirror normalization decodes to a literal
        // apostrophe. A raw-only presence check would miss it and, since the
        // original text is also present, incorrectly declare the record
        // undone.
        const strippedHtml = "<p>original text</p><p>Won&#x27;t</p>";
        const undoOldHtml = '<p>original text</p>';
        const undoNewHtml = "<p>Won't</p>";

        expect(isBatchReplaceAllAlreadyUndone(strippedHtml, undoOldHtml, undoNewHtml, LIBRARY_ID)).toBe(false);
    });

    it('returns true when the applied text is absent (raw and normalized) and the original text is present', () => {
        const strippedHtml = '<p>original text</p><p>Something else</p>';
        const undoOldHtml = '<p>original text</p>';
        const undoNewHtml = "<p>Won't</p>";

        expect(isBatchReplaceAllAlreadyUndone(strippedHtml, undoOldHtml, undoNewHtml, LIBRARY_ID)).toBe(true);
    });

    it('returns false when the raw applied text is present', () => {
        const strippedHtml = "<p>before</p><p>Won't</p><p>after</p>";
        const undoOldHtml = '<p>original text</p>';
        const undoNewHtml = "<p>Won't</p>";

        expect(isBatchReplaceAllAlreadyUndone(strippedHtml, undoOldHtml, undoNewHtml, LIBRARY_ID)).toBe(false);
    });

    it('returns true when the original text is present only in normalized form', () => {
        // Inter-tag whitespace differs (a newline PM may have inserted)
        // between the stored undo_old_html and the current note, so the raw
        // check misses it but the normalized check still finds it.
        const strippedHtml = '<p>A</p>\n<p>B</p><p>Something else</p>';
        const undoOldHtml = '<p>A</p><p>B</p>';
        const undoNewHtml = "<p>Won't</p>";

        expect(isBatchReplaceAllAlreadyUndone(strippedHtml, undoOldHtml, undoNewHtml, LIBRARY_ID)).toBe(true);
    });
});

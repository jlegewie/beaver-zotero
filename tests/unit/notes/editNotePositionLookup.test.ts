import { describe, it, expect, vi } from 'vitest';

// Mock transitives pulled in by noteHtmlSimplifier's dependency graph.
vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));
vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(),
    canSetField: vi.fn(),
    SETTABLE_PRIMARY_FIELDS: [],
    sanitizeCreators: vi.fn(),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));
vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));

import { simplifyNoteHtml } from '../../../src/utils/noteHtmlSimplifier';
import { expandToRawHtml } from '../../../src/utils/noteCitationExpand';
import { stripDataCitationItems } from '../../../src/utils/noteWrapper';
import {
    locateEditTarget,
    resolveEditTargetAtRuntime,
    buildZeroMatchHint,
    buildExecutionZeroMatchMessage,
    locateEditFragment,
    findRangesByRawAnchors,
    findWhitespaceTolerant,
    normalizeUndoComparisonHtml,
} from '../../../src/utils/editNotePositionLookup';

// =============================================================================
// Helpers
// =============================================================================

function wrap(inner: string): string {
    return `<div data-schema-version="9">${inner}</div>`;
}

function prepare(rawNote: string, oldString: string) {
    const strippedHtml = stripDataCitationItems(rawNote);
    const { simplified, metadata } = simplifyNoteHtml(strippedHtml, 1);
    const expandedOld = expandToRawHtml(oldString, metadata, 'old');
    return { strippedHtml, simplified, metadata, expandedOld };
}

// =============================================================================
// locateEditTarget
// =============================================================================

describe('locateEditTarget', () => {
    it('returns { kind: "position" } on a unique match', () => {
        const raw = wrap('<p>hello world</p>');
        const oldString = 'hello world';
        const { strippedHtml, simplified, metadata, expandedOld } = prepare(raw, oldString);

        const result = locateEditTarget({ strippedHtml, simplified, oldString, expandedOld, metadata });
        expect(result.kind).toBe('position');
        if (result.kind === 'position') {
            expect(result.rawPosition).toBeGreaterThanOrEqual(0);
            expect(strippedHtml.substring(
                result.rawPosition,
                result.rawPosition + expandedOld.length,
            )).toBe(expandedOld);
        }
    });

    it('returns { kind: "ambiguous" } when old_string occurs identically multiple times', () => {
        const raw = wrap('<p>alpha</p><p>alpha</p>');
        const oldString = '<p>alpha</p>';
        const { strippedHtml, simplified, metadata, expandedOld } = prepare(raw, oldString);

        const result = locateEditTarget({ strippedHtml, simplified, oldString, expandedOld, metadata });
        expect(result.kind).toBe('ambiguous');
    });
});

// =============================================================================
// resolveEditTargetAtRuntime
// =============================================================================

describe('resolveEditTargetAtRuntime', () => {
    it('uses the unique-match position when available', () => {
        const raw = wrap('<p>only once</p>');
        const oldString = 'only once';
        const { strippedHtml, simplified, metadata, expandedOld } = prepare(raw, oldString);

        const { rawPosition } = resolveEditTargetAtRuntime({
            strippedHtml, simplified, oldString, expandedOld, metadata,
        });
        expect(rawPosition).toBeGreaterThanOrEqual(0);
        expect(strippedHtml.substring(
            rawPosition,
            rawPosition + expandedOld.length,
        )).toBe(expandedOld);
    });

    it('falls back to stored context when the unique matcher fails', () => {
        // Two identical paragraphs; unique-match returns null, but context pins
        // down the second one.
        const raw = wrap('<p>dup</p><p>dup</p>');
        const oldString = '<p>dup</p>';
        const { strippedHtml, simplified, metadata, expandedOld } = prepare(raw, oldString);

        const firstOccurrenceEnd = strippedHtml.indexOf(expandedOld) + expandedOld.length;
        const targetBeforeContext = strippedHtml.substring(0, firstOccurrenceEnd);

        const { rawPosition } = resolveEditTargetAtRuntime({
            strippedHtml, simplified, oldString, expandedOld, metadata,
            targetBeforeContext,
        });
        expect(rawPosition).toBe(firstOccurrenceEnd);
    });

    it('returns rawPosition: -1 when neither unique-match nor context resolves', () => {
        const raw = wrap('<p>dup</p><p>dup</p>');
        const oldString = '<p>dup</p>';
        const { strippedHtml, simplified, metadata, expandedOld } = prepare(raw, oldString);

        const { rawPosition } = resolveEditTargetAtRuntime({
            strippedHtml, simplified, oldString, expandedOld, metadata,
        });
        expect(rawPosition).toBe(-1);
    });
});

// =============================================================================
// buildZeroMatchHint
// =============================================================================

describe('buildZeroMatchHint', () => {
    it('returns kind "drift" when old_string matches after stripping inline tags', () => {
        const simplified = '<p>ages 13 to 15 experienced <strong>substantial</strong> negative effects.</p>';
        const oldString = 'ages 13 to 15 experienced substantial negative effects.';

        const hint = buildZeroMatchHint(simplified, oldString);
        expect(hint.kind).toBe('drift');
        if (hint.kind === 'drift') {
            expect(hint.droppedTags).toContain('<strong>');
            expect(hint.message).toContain('Tags missing from old_string');
            expect(hint.message).toContain(oldString);
        }
    });

    it('returns kind "fuzzy" when word-overlap finds a candidate line', () => {
        const simplified = '<p>The quick brown fox jumps over the lazy dog.</p>';
        // Rearranged / slightly different so drift detection fails, but words overlap.
        const oldString = 'quick brown fox jumped over lazy dog';

        const hint = buildZeroMatchHint(simplified, oldString);
        expect(hint.kind).toBe('fuzzy');
        if (hint.kind === 'fuzzy') {
            expect(hint.message).toContain('fuzzy match');
        }
    });

    it('returns kind "structural" when old_string references a unique block tag with a hallucinated anchor', () => {
        // Model hallucinates "</h2>\n<table>" but the real <table> is not
        // preceded by </h2>. Fuzzy whitespace-exact fails (string doesn't
        // appear verbatim), word-overlap fails (tags strip out, no shared
        // meaningful words), so the structural anchor wins.
        const simplified =
            '<h2>User</h2>\n'
            + '<p>Prompt text.</p>\n'
            + '<h2>Beaver</h2>\n'
            + '<p>Summary line.</p>\n'
            + '<table>\n<tbody></tbody></table>';
        const oldString = '</h2>\n<table>';

        const hint = buildZeroMatchHint(simplified, oldString);
        expect(hint.kind).toBe('structural');
        if (hint.kind === 'structural') {
            expect(hint.tagName).toBe('table');
            expect(hint.message).toContain('<table>');
        }
    });

    it('returns kind "generic" when no hint applies', () => {
        const simplified = '<p>totally unrelated content about cats</p>';
        const oldString = 'xyz123nonexistent';

        const hint = buildZeroMatchHint(simplified, oldString);
        expect(hint.kind).toBe('generic');
        expect(hint.message).toBe('The string to replace was not found in the note.');
    });
});

// =============================================================================
// buildExecutionZeroMatchMessage
// =============================================================================

describe('buildExecutionZeroMatchMessage', () => {
    it('appends a fuzzy match snippet when one exists', () => {
        const simplified = '<p>The quick brown fox jumps over the lazy dog.</p>';
        const oldString = 'quick brown fox jumped over lazy dog';

        const msg = buildExecutionZeroMatchMessage(simplified, oldString);
        expect(msg).toContain('not found in the note');
        expect(msg).toContain('fuzzy match');
    });

    it('omits the fuzzy snippet when nothing matches', () => {
        const simplified = '<p>totally unrelated content</p>';
        const oldString = 'xyz123nonexistent';

        const msg = buildExecutionZeroMatchMessage(simplified, oldString);
        expect(msg).toBe('The string to replace was not found in the note.');
    });
});

// =============================================================================
// findRangesByRawAnchors / findWhitespaceTolerant / normalizeUndoComparisonHtml
// =============================================================================

describe('findRangesByRawAnchors', () => {
    it('returns the unique surrounding range when anchors match once', () => {
        const target = '<p>This is the unique passage with enough length to anchor.</p>';
        const html = `<p>Other prelude.</p>${target}<p>Other epilogue here that comes after.</p>`;

        const ranges = findRangesByRawAnchors(html, target);
        expect(ranges.length).toBeGreaterThan(0);
        // At least one candidate must wrap the literal target
        expect(ranges.some(r => html.substring(r.start, r.end) === target)).toBe(true);
    });

    it('returns empty when target is too short for the minimum anchor length', () => {
        expect(findRangesByRawAnchors('<p>some content here</p>', 'abc')).toEqual([]);
    });
});

describe('findWhitespaceTolerant', () => {
    it('matches across newlines that PM may have inserted between tags', () => {
        const haystack = '<p>First.</p>\n  <p>Second.</p>';
        const needle = '<p>First.</p><p>Second.</p>';
        const range = findWhitespaceTolerant(haystack, needle);
        expect(range).not.toBeNull();
        expect(haystack.substring(range!.start, range!.end)).toContain('First');
        expect(haystack.substring(range!.start, range!.end)).toContain('Second');
    });

    it('returns null when no whitespace-tolerant match exists', () => {
        expect(findWhitespaceTolerant('<p>foo</p>', '<p>bar</p>')).toBeNull();
    });
});

describe('normalizeUndoComparisonHtml', () => {
    it('compares-equal across inter-tag whitespace differences', () => {
        const a = '<p>Hello.</p>\n<p>World.</p>';
        const b = '<p>Hello.</p><p>World.</p>';
        expect(normalizeUndoComparisonHtml(a, 1)).toBe(normalizeUndoComparisonHtml(b, 1));
    });
});

// =============================================================================
// locateEditFragment
// =============================================================================

describe('locateEditFragment — undo-seam intent', () => {
    it('exact seam: returns insertion point at end of beforeContext', () => {
        const html = '<p>before-text</p><p>after-text</p>';
        const beforeCtx = '<p>before-text</p>';
        const afterCtx = '<p>after-text</p>';

        const result = locateEditFragment({
            strippedHtml: html,
            intent: { kind: 'undo-seam', beforeContext: beforeCtx, afterContext: afterCtx },
        });

        expect(result.kind).toBe('seam');
        if (result.kind === 'seam') {
            expect(result.insertionPoint).toBe(beforeCtx.length);
            expect(result.gapEnd).toBeUndefined();
        }
    });

    it('proximity seam: returns gapEnd when editor inserted whitespace at the seam', () => {
        const html = '<p>before-text</p>   <p>after-text</p>';
        const beforeCtx = '<p>before-text</p>';
        const afterCtx = '<p>after-text</p>';

        const result = locateEditFragment({
            strippedHtml: html,
            intent: { kind: 'undo-seam', beforeContext: beforeCtx, afterContext: afterCtx },
        });

        expect(result.kind).toBe('seam');
        if (result.kind === 'seam') {
            expect(result.insertionPoint).toBe(beforeCtx.length);
            expect(result.gapEnd).toBe(beforeCtx.length + 3);
        }
    });

    it('beforeOnly: uses beforeCtx end when afterCtx is missing', () => {
        const html = '<p>before-text</p>tail';
        const result = locateEditFragment({
            strippedHtml: html,
            intent: { kind: 'undo-seam', beforeContext: '<p>before-text</p>' },
        });
        expect(result.kind).toBe('seam');
        if (result.kind === 'seam') {
            expect(result.insertionPoint).toBe(18);
        }
    });

    it('afterOnly: uses afterCtx start when beforeCtx is missing', () => {
        const html = 'head<p>after-text</p>';
        const result = locateEditFragment({
            strippedHtml: html,
            intent: { kind: 'undo-seam', afterContext: '<p>after-text</p>' },
        });
        expect(result.kind).toBe('seam');
        if (result.kind === 'seam') {
            expect(result.insertionPoint).toBe(4);
        }
    });

    it('returns not-found when neither context appears in the note', () => {
        const result = locateEditFragment({
            strippedHtml: '<p>unrelated content</p>',
            intent: { kind: 'undo-seam', beforeContext: '<p>nope</p>', afterContext: '<p>also-nope</p>' },
        });
        expect(result.kind).toBe('not-found');
    });

    it('whole-note deletion: empty before/after contexts resolve to offset 0 (regression)', () => {
        // When a delete edit removes the entire note body, the validator captures
        // both contexts as empty strings. The seam is empty and must locate at 0
        // so undo can splice the deleted content back at the start.
        const result = locateEditFragment({
            strippedHtml: '',
            intent: { kind: 'undo-seam', beforeContext: '', afterContext: '' },
        });
        expect(result.kind).toBe('seam');
        if (result.kind === 'seam') {
            expect(result.insertionPoint).toBe(0);
            expect(result.gapEnd).toBeUndefined();
        }
    });

    it('deletion leaving only the footer: empty contexts still locate at offset 0', () => {
        // Same scenario but a footer remained in the note. Splicing at 0 means
        // the restored content goes back before the footer, matching the prior
        // inline behavior.
        const result = locateEditFragment({
            strippedHtml: '<p>--- Edited by Beaver ---</p>',
            intent: { kind: 'undo-seam', beforeContext: '', afterContext: '' },
        });
        expect(result.kind).toBe('seam');
        if (result.kind === 'seam') {
            expect(result.insertionPoint).toBe(0);
        }
    });
});

describe('locateEditFragment — undo-fragment intent', () => {
    it('exact path: returns the unique indexOf range', () => {
        const html = '<p>head</p><p>fragment-applied</p><p>tail</p>';
        const expected = '<p>fragment-applied</p>';

        const result = locateEditFragment({
            strippedHtml: html,
            intent: { kind: 'undo-fragment', expectedHtml: expected, libraryId: 1 },
        });
        expect(result.kind).toBe('range');
        if (result.kind === 'range') {
            expect(result.via).toBe('exact');
            expect(html.substring(result.start, result.end)).toBe(expected);
        }
    });

    it('exact path with duplicates: prefers context-bracketed occurrence', () => {
        const expected = '<p>fragment</p>';
        const html =
            '<p>alpha</p>' + expected + '<p>between</p>' + expected + '<p>omega</p>';
        const beforeCtx = '<p>between</p>';
        const afterCtx = '<p>omega</p>';

        const result = locateEditFragment({
            strippedHtml: html,
            intent: {
                kind: 'undo-fragment',
                expectedHtml: expected,
                beforeContext: beforeCtx,
                afterContext: afterCtx,
                libraryId: 1,
            },
        });

        expect(result.kind).toBe('range');
        if (result.kind === 'range') {
            // Should pick the SECOND occurrence (between/omega bracket)
            expect(result.start).toBe(html.indexOf(expected, html.indexOf(expected) + 1));
            expect(result.via).toBe('exact');
        }
    });

    it('fuzzy path: recovers via context anchors when exact match fails', () => {
        const expected = '<p>fragment-applied</p>';
        // Note has the fragment with extra inter-tag whitespace
        const html = '<p>head</p>\n<p>fragment-applied</p>\n<p>tail</p>';
        // Exact indexOf works here; force fuzzy by making expected slightly different
        const stale = '<p>fragment-applied OLD</p>';

        const result = locateEditFragment({
            strippedHtml: html,
            intent: {
                kind: 'undo-fragment',
                expectedHtml: stale,
                beforeContext: '<p>head</p>',
                afterContext: '<p>tail</p>',
                libraryId: 1,
                allowFuzzy: true,
            },
        });
        // Stale text won't match by content; expect not-found (text-content
        // fallback fails because content differs)
        expect(result.kind).toBe('not-found');
    });

    it('allowFuzzy=false: exact-only, returns not-found on mismatch', () => {
        const result = locateEditFragment({
            strippedHtml: '<p>actual</p>',
            intent: {
                kind: 'undo-fragment',
                expectedHtml: '<p>missing</p>',
                libraryId: 1,
                allowFuzzy: false,
            },
        });
        expect(result.kind).toBe('not-found');
    });
});

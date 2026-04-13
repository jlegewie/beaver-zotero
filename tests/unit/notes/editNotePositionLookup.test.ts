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

import {
    simplifyNoteHtml,
    expandToRawHtml,
    stripDataCitationItems,
} from '../../../src/utils/noteHtmlSimplifier';
import {
    locateEditTarget,
    resolveEditTargetAtRuntime,
    buildZeroMatchHint,
    buildExecutionZeroMatchMessage,
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

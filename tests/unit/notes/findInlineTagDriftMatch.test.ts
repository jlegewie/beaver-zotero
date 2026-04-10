import { describe, it, expect, vi } from 'vitest';

// Mock transitive dependencies that pull in Supabase/Zotero APIs
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
vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn(),
    getDeferredToolPreference: vi.fn(),
    resolveToPdfAttachment: vi.fn(),
    validateZoteroItemReference: vi.fn(),
    backfillMetadataForError: vi.fn(),
}));
vi.mock('../../../src/utils/logger', () => ({
    logger: vi.fn(),
}));
vi.mock('../../../react/utils/batchFindExistingReferences', () => ({
    batchFindExistingReferences: vi.fn().mockResolvedValue([]),
    BatchReferenceCheckItem: {},
}));

import { findInlineTagDriftMatch } from '../../../src/utils/noteHtmlSimplifier';


// =============================================================================
// Happy path: single dropped tag
// =============================================================================

describe('findInlineTagDriftMatch — single dropped tag', () => {
    it('detects dropped <strong> wrapper around an inline word', () => {
        const simplified = '<p>ages 13 to 15 experienced <strong>substantial</strong> negative effects.</p>';
        const oldString = 'ages 13 to 15 experienced substantial negative effects.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.noteSpan).toBe('ages 13 to 15 experienced <strong>substantial</strong> negative effects.');
        expect(result!.droppedTags).toEqual(['<strong>', '</strong>']);
    });

    it('detects dropped <em> wrapper', () => {
        const simplified = '<p>The <em>quick</em> brown fox.</p>';
        const oldString = 'The quick brown fox.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.noteSpan).toBe('The <em>quick</em> brown fox.');
        expect(result!.droppedTags).toEqual(['<em>', '</em>']);
    });

    it('detects dropped <code> wrapper', () => {
        const simplified = '<p>Call <code>foo()</code> to start.</p>';
        const oldString = 'Call foo() to start.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.noteSpan).toBe('Call <code>foo()</code> to start.');
        expect(result!.droppedTags).toEqual(['<code>', '</code>']);
    });
});


// =============================================================================
// Multiple dropped tags
// =============================================================================

describe('findInlineTagDriftMatch — multiple dropped tags', () => {
    it('detects multiple dropped wrappers in the same span', () => {
        const simplified = '<p>The <strong>quick</strong> brown <em>fox</em> jumps.</p>';
        const oldString = 'The quick brown fox jumps.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.noteSpan).toBe('The <strong>quick</strong> brown <em>fox</em> jumps.');
        expect(result!.droppedTags).toEqual(['<strong>', '</strong>', '<em>', '</em>']);
    });

    it('reports only the dropped tags when old_string has some but not all', () => {
        const simplified = '<p>The <strong>quick</strong> brown <em>fox</em> jumps.</p>';
        // Model kept <strong> but dropped <em>
        const oldString = 'The <strong>quick</strong> brown fox jumps.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.droppedTags).toEqual(['<em>', '</em>']);
    });
});


// =============================================================================
// Negative cases
// =============================================================================

describe('findInlineTagDriftMatch — no drift', () => {
    it('returns null when old_string matches the note exactly', () => {
        const simplified = '<p>The <strong>quick</strong> brown fox.</p>';
        const oldString = 'The <strong>quick</strong> brown fox.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).toBeNull();
    });

    it('returns null when old_string is entirely absent', () => {
        const simplified = '<p>Lorem ipsum dolor sit amet.</p>';
        const oldString = 'Completely unrelated text.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).toBeNull();
    });

    it('returns null when match is ambiguous in stripped form', () => {
        const simplified = '<p>The <strong>quick</strong> brown fox. The quick brown fox.</p>';
        const oldString = 'The quick brown fox.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).toBeNull();
    });

    it('returns null when old_string has MORE tags than the note (no drops)', () => {
        const simplified = '<p>The quick brown fox.</p>';
        const oldString = 'The <strong>quick</strong> brown fox.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).toBeNull();
    });

    it('returns null for empty old_string', () => {
        const simplified = '<p>The quick brown fox.</p>';
        expect(findInlineTagDriftMatch(simplified, '')).toBeNull();
        expect(findInlineTagDriftMatch(simplified, '   ')).toBeNull();
    });

    it('returns null when only block-level tag differences exist', () => {
        // <p> is not in the inline format tag list — drift detection skips it
        const simplified = '<p>The quick brown fox.</p>';
        const oldString = 'The quick brown fox.';

        // The stripped forms don't match because <p>...</p> is preserved.
        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).toBeNull();
    });
});


// =============================================================================
// Real-world case from failed-edits-12.md (the case that motivated this helper)
// =============================================================================

describe('findInlineTagDriftMatch — real-world case', () => {
    it('detects drift in the failed Operation Impact note edit', () => {
        const simplified =
            '<li>\n'
            + '<strong>Effect increases with age</strong>: The negative effect of aggressive policing intensifies as students grow older. African American boys ages 9 and 10 showed no discernible effect, age 12 showed a modest negative effect, and ages 13 to 15 experienced <strong>substantial</strong> negative effects. The point estimates ranged from -0.098 to -0.150.\n'
            + '</li>';
        const oldString =
            'African American boys ages 9 and 10 showed no discernible effect, age 12 showed a modest negative effect, and ages 13 to 15 experienced substantial negative effects.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.noteSpan).toBe(
            'African American boys ages 9 and 10 showed no discernible effect, age 12 showed a modest negative effect, and ages 13 to 15 experienced <strong>substantial</strong> negative effects.',
        );
        expect(result!.droppedTags).toEqual(['<strong>', '</strong>']);
    });
});


// =============================================================================
// Edge cases
// =============================================================================

describe('findInlineTagDriftMatch — edge cases', () => {
    it('preserves case-insensitive tag matching', () => {
        const simplified = '<p>The <STRONG>quick</STRONG> brown fox.</p>';
        const oldString = 'The quick brown fox.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.droppedTags).toEqual(['<STRONG>', '</STRONG>']);
    });

    it('handles tags with attributes', () => {
        const simplified = '<p>The <strong class="highlight">quick</strong> brown fox.</p>';
        const oldString = 'The quick brown fox.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.droppedTags).toEqual(['<strong class="highlight">', '</strong>']);
    });

    it('handles drift at the start of the note span', () => {
        const simplified = '<p><strong>Important:</strong> read this carefully.</p>';
        const oldString = 'Important: read this carefully.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.noteSpan).toBe('<strong>Important:</strong> read this carefully.');
        expect(result!.droppedTags).toEqual(['<strong>', '</strong>']);
    });

    it('handles drift at the end of the note span', () => {
        const simplified = '<p>This is <strong>important.</strong></p>';
        const oldString = 'This is important.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.noteSpan).toBe('This is <strong>important.</strong>');
        expect(result!.droppedTags).toEqual(['<strong>', '</strong>']);
    });

    it('handles nested inline tags', () => {
        const simplified = '<p>The <strong><em>very</em> important</strong> point.</p>';
        const oldString = 'The very important point.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        // Both wrappers should be reported as dropped
        expect(result!.droppedTags).toContain('<strong>');
        expect(result!.droppedTags).toContain('</strong>');
        expect(result!.droppedTags).toContain('<em>');
        expect(result!.droppedTags).toContain('</em>');
    });
});

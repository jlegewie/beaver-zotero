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

import { findInlineTagDriftMatch } from '../../../src/utils/editNoteHints';


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


// =============================================================================
// <span> drift (text collapsed across inline color/background/strike spans)
// =============================================================================

describe('findInlineTagDriftMatch — dropped <span> wrappers', () => {
    it('detects a single dropped <span> wrapper around a phrase', () => {
        const simplified = '<p>Call <span style="color: rgb(255, 0, 0);">attention</span> to this.</p>';
        const oldString = 'Call attention to this.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.noteSpan).toBe(
            'Call <span style="color: rgb(255, 0, 0);">attention</span> to this.',
        );
        expect(result!.droppedTags).toEqual([
            '<span style="color: rgb(255, 0, 0);">',
            '</span>',
        ]);
    });

    it('detects drift when background-color span breaks text continuity', () => {
        const simplified =
            '<p>The term <span style="background-color: rgb(255, 255, 0);">gradient descent</span> is central here.</p>';
        const oldString = 'The term gradient descent is central here.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.droppedTags).toContain('<span style="background-color: rgb(255, 255, 0);">');
        expect(result!.droppedTags).toContain('</span>');
    });

    it('detects nested <strong><span> drift (color + bold mixed)', () => {
        const simplified =
            '<p><strong><span style="color: rgb(0, 0, 255);">Important</span></strong>: read this.</p>';
        const oldString = 'Important: read this.';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.droppedTags).toContain('<strong>');
        expect(result!.droppedTags).toContain('</strong>');
        expect(result!.droppedTags).toContain('<span style="color: rgb(0, 0, 255);">');
        expect(result!.droppedTags).toContain('</span>');
    });
});


// =============================================================================
// Real-world case from failed-edits-22.md (the case that motivated adding
// <span> to INLINE_FORMAT_TAG_NAMES)
// =============================================================================

describe('findInlineTagDriftMatch — failed-edits-22 regression', () => {
    // Matches the exact simplified HTML returned by read_note in
    // failed-edits-22.md for note 1-K2AHASMA. "📅" sits inside its own color
    // <span>, then a <strong><span> opens again for the rest of the Chinese
    // field template. The model collapses the whole line to plain text and
    // drops every wrapper.
    const simplified =
        '<p>'
        + '<span style="color: rgb(47, 47, 79);">📅</span>'
        + '<strong><span style="color: rgb(47, 47, 79);">'
        + '发表时间：<br>🔢期刊会议：<br>🎯方向分类： <br>'
        + '</span></strong>'
        + '</p>';

    it('detects the collapsed-across-span Chinese template header drift', () => {
        // Exact old_string the model sent in failed-edits-22.md
        const oldString = '📅发表时间：<br>🔢期刊会议：<br>🎯方向分类： <br>';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();

        // The span/strong wrappers the model dropped must be reported.
        expect(result!.droppedTags).toContain('<span style="color: rgb(47, 47, 79);">');
        expect(result!.droppedTags).toContain('</span>');
        expect(result!.droppedTags).toContain('<strong>');

        // The <br>s that ARE present in both sides must NOT be reported as
        // missing — the model included all three.
        expect(result!.droppedTags).not.toContain('<br>');

        // The reported noteSpan must include at least one of the <span>
        // wrappers so the model has something concrete to copy back. It
        // starts at the opening <span> immediately after <p>.
        expect(result!.noteSpan.startsWith('<span style="color: rgb(47, 47, 79);">📅')).toBe(true);
    });

    it('covers the full paragraph when model keeps the <p> wrapping', () => {
        // Same note, but the model included <p>...</p> in old_string. The
        // trailing </p> anchors the walker past all inline wrappers, so the
        // noteSpan covers the full paragraph including the trailing
        // <br></span></strong>.
        const oldString =
            '<p>📅发表时间：<br>🔢期刊会议：<br>🎯方向分类： <br></p>';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.noteSpan).toBe(simplified);
        expect(result!.droppedTags).toContain('<span style="color: rgb(47, 47, 79);">');
        expect(result!.droppedTags).toContain('<strong>');
        expect(result!.droppedTags).toContain('</strong>');
    });
});


// =============================================================================
// <br> void element (failed-edits-17.md)
// =============================================================================

describe('findInlineTagDriftMatch — <br> void element', () => {
    it('detects a dropped trailing <br> before a closing wrapper', () => {
        // The model copied the text but dropped the final <br> before </span>.
        const simplified =
            '<p><strong><span>发表时间：<br>期刊会议：<br>方向分类： <br></span></strong></p>';
        const oldString =
            '<p><strong><span>发表时间：<br>期刊会议：<br>方向分类： </span></strong></p>';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.droppedTags).toEqual(['<br>']);
        expect(result!.noteSpan).toContain('方向分类： <br></span>');
    });

    it('detects a dropped interior <br>', () => {
        const simplified = '<p>Line A<br>Line B<br>Line C</p>';
        // Model dropped the middle <br>
        const oldString = '<p>Line A<br>Line BLine C</p>';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.droppedTags).toEqual(['<br>']);
    });

    it('reports <br> vs <br/> as a drop (token-level comparison)', () => {
        // Post-PM form is <br>, but a model might emit <br/>. The droppedTags
        // multiset compares full tag tokens, so these are treated as distinct
        // — same as how `<strong class="foo">` differs from `<strong>`. The
        // model gets a pointed "you have <br/>, note has <br>" error and
        // copies the canonical form on retry. Acceptable minor cost.
        const simplified = '<p>A<br>B</p>';
        const oldString = '<p>A<br/>B</p>';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.droppedTags).toEqual(['<br>']);
    });

    it('returns null when <br> counts match exactly', () => {
        const simplified = '<p>A<br>B<br>C</p>';
        const oldString = '<p>A<br>B<br>C</p>';

        const result = findInlineTagDriftMatch(simplified, oldString);
        expect(result).toBeNull();
    });
});

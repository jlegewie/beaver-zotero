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

import { stripSpuriousWrappingTags } from '../../../src/utils/editNoteStrippers';


// =============================================================================
// Leading opening tag only
// =============================================================================

describe('stripSpuriousWrappingTags — leading-only', () => {
    it('returns leading-only candidate when only the leading tag is shared', () => {
        // old starts with <p>, new starts with <p>
        // old ends with </p>, but new does NOT end with </p> → only leading
        const candidates = stripSpuriousWrappingTags(
            '<p>Some text.</p>',
            '<p>Some text.</p>\n<p>New paragraph.</p>',
        );
        // Leading-only candidate should be first
        expect(candidates.length).toBeGreaterThanOrEqual(1);
        expect(candidates[0].strippedOld).toBe('Some text.</p>');
        expect(candidates[0].strippedNew).toBe('Some text.</p>\n<p>New paragraph.</p>');
    });

    it('does not strip when old and new have different leading tags', () => {
        const candidates = stripSpuriousWrappingTags(
            '<p>Text</p>',
            '<h3>Text</h3>',
        );
        expect(candidates).toHaveLength(0);
    });

    it('does not strip when strings do not start with a tag', () => {
        const candidates = stripSpuriousWrappingTags(
            'plain text here',
            'new plain text here',
        );
        expect(candidates).toHaveLength(0);
    });

    it('strips shared leading tag with attributes', () => {
        const candidates = stripSpuriousWrappingTags(
            '<p class="indent">Some text',
            '<p class="indent">New text',
        );
        expect(candidates.length).toBeGreaterThanOrEqual(1);
        expect(candidates[0].strippedOld).toBe('Some text');
        expect(candidates[0].strippedNew).toBe('New text');
    });
});


// =============================================================================
// Trailing closing tag only
// =============================================================================

describe('stripSpuriousWrappingTags — trailing-only', () => {
    it('strips shared trailing </p> when no shared leading tag', () => {
        const candidates = stripSpuriousWrappingTags(
            'Some text in paragraph.</p>',
            'New text in paragraph.</p>',
        );
        // No leading tag → trailing-only is the first candidate
        expect(candidates.length).toBeGreaterThanOrEqual(1);
        expect(candidates[0].strippedOld).toBe('Some text in paragraph.');
        expect(candidates[0].strippedNew).toBe('New text in paragraph.');
    });

    it('strips trailing tag with trailing whitespace', () => {
        const candidates = stripSpuriousWrappingTags(
            'Some text.</p>\n\n',
            'New text.</p>\n\n',
        );
        expect(candidates.length).toBeGreaterThanOrEqual(1);
        expect(candidates[0].strippedOld).toBe('Some text.');
        expect(candidates[0].strippedNew).toBe('New text.');
    });

    it('strips trailing tag when whitespace differs between old and new', () => {
        const candidates = stripSpuriousWrappingTags(
            'Some text.</p>\n\n',
            'New text.</p>\n',
        );
        expect(candidates.length).toBeGreaterThanOrEqual(1);
        expect(candidates[0].strippedOld).toBe('Some text.');
        expect(candidates[0].strippedNew).toBe('New text.');
    });

    it('does not strip when old and new have different trailing tags', () => {
        const candidates = stripSpuriousWrappingTags(
            'Text</p>',
            'Text</h3>',
        );
        expect(candidates).toHaveLength(0);
    });

    it('strips trailing tag even when leading tags differ', () => {
        // old starts with <p>, new does not → no leading strip
        // both end with </p> → trailing-only candidate
        const candidates = stripSpuriousWrappingTags(
            '<p>Text</p>',
            'Text</p>',
        );
        expect(candidates.length).toBeGreaterThanOrEqual(1);
        expect(candidates[0].strippedOld).toBe('<p>Text');
        expect(candidates[0].strippedNew).toBe('Text');
    });
});


// =============================================================================
// Candidate ordering (leading-only, trailing-only, both)
// =============================================================================

describe('stripSpuriousWrappingTags — candidate ordering', () => {
    it('returns 3 candidates when both leading and trailing are shared', () => {
        const candidates = stripSpuriousWrappingTags(
            '<p>Complete paragraph text.</p>',
            '<p>New paragraph text.</p>',
        );
        expect(candidates).toHaveLength(3);
        // 1. Leading-only
        expect(candidates[0].strippedOld).toBe('Complete paragraph text.</p>');
        expect(candidates[0].strippedNew).toBe('New paragraph text.</p>');
        // 2. Trailing-only
        expect(candidates[1].strippedOld).toBe('<p>Complete paragraph text.');
        expect(candidates[1].strippedNew).toBe('<p>New paragraph text.');
        // 3. Both
        expect(candidates[2].strippedOld).toBe('Complete paragraph text.');
        expect(candidates[2].strippedNew).toBe('New paragraph text.');
    });

    it('returns 3 candidates for <h3>...</h3> wrapping', () => {
        const candidates = stripSpuriousWrappingTags(
            '<h3>Section Title</h3>',
            '<h3>New Section Title</h3>',
        );
        expect(candidates).toHaveLength(3);
        expect(candidates[0].strippedOld).toBe('Section Title</h3>');
        expect(candidates[1].strippedOld).toBe('<h3>Section Title');
        expect(candidates[2].strippedOld).toBe('Section Title');
    });

    it('returns 3 candidates for <li>...</li> with trailing whitespace', () => {
        const candidates = stripSpuriousWrappingTags(
            '<li>List item text.</li>\n',
            '<li>Updated item text.</li>\n',
        );
        expect(candidates).toHaveLength(3);
        expect(candidates[0].strippedOld).toBe('List item text.</li>\n');
        expect(candidates[1].strippedOld).toBe('<li>List item text.');
        expect(candidates[2].strippedOld).toBe('List item text.');
    });

    it('returns 1 candidate when only leading tag is shared', () => {
        const candidates = stripSpuriousWrappingTags(
            '<p>Text without closing tag',
            '<p>New text without closing tag',
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].strippedOld).toBe('Text without closing tag');
    });

    it('returns 1 candidate when only trailing tag is shared', () => {
        const candidates = stripSpuriousWrappingTags(
            'Text without opening tag.</p>',
            'New text without opening tag.</p>',
        );
        expect(candidates).toHaveLength(1);
        expect(candidates[0].strippedOld).toBe('Text without opening tag.');
    });
});


// =============================================================================
// Real-world scenario
// =============================================================================

describe('stripSpuriousWrappingTags — real-world case', () => {
    it('LLM wraps mid-paragraph selection in <p>...</p>\\n\\n', () => {
        const oldStr = '<p>Die Studie schließt mit dem Appell, die sozialen Kosten zu evaluieren.</p>\n\n';
        const newStr = '<p>Die Studie schließt mit dem Appell, die sozialen Kosten zu evaluieren.</p>\n\n<h2>English Summary</h2>\n<p>Summary text.</p>\n\n';
        const candidates = stripSpuriousWrappingTags(oldStr, newStr);

        // Should have at least leading-only candidate
        expect(candidates.length).toBeGreaterThanOrEqual(1);

        // First candidate: leading-only (preserves correct </p>)
        expect(candidates[0].strippedOld).toBe(
            'Die Studie schließt mit dem Appell, die sozialen Kosten zu evaluieren.</p>\n\n',
        );
        expect(candidates[0].strippedNew).toBe(
            'Die Studie schließt mit dem Appell, die sozialen Kosten zu evaluieren.</p>\n\n<h2>English Summary</h2>\n<p>Summary text.</p>\n\n',
        );

        // new_string ends with </p>\n\n so trailing is also shared → 3 candidates
        expect(candidates).toHaveLength(3);

        // Third candidate: both stripped
        expect(candidates[2].strippedOld).toBe(
            'Die Studie schließt mit dem Appell, die sozialen Kosten zu evaluieren.',
        );
    });
});


// =============================================================================
// Edge cases
// =============================================================================

describe('stripSpuriousWrappingTags — edge cases', () => {
    it('filters out both-stripped candidate when it would leave empty old_string', () => {
        const candidates = stripSpuriousWrappingTags(
            '<p></p>',
            '<p>New content</p>',
        );
        // Leading-only → '</p>', trailing-only → '<p>' — both non-empty
        // Both → '' — filtered out
        expect(candidates).toHaveLength(2);
        expect(candidates.find(c => c.strippedOld === '')).toBeUndefined();
    });

    it('filters out both-stripped candidate when it would leave whitespace-only old_string', () => {
        const candidates = stripSpuriousWrappingTags(
            '<p>  </p>',
            '<p>New content</p>',
        );
        // Leading-only → '  </p>', trailing-only → '<p>  ' — both non-empty
        // Both → '  ' — filtered out (whitespace-only)
        expect(candidates).toHaveLength(2);
        expect(candidates.find(c => c.strippedOld.trim() === '')).toBeUndefined();
    });

    it('handles self-closing leading tags', () => {
        const candidates = stripSpuriousWrappingTags(
            '<br/>Some text',
            '<br/>New text',
        );
        expect(candidates.length).toBeGreaterThanOrEqual(1);
        expect(candidates[0].strippedOld).toBe('Some text');
        expect(candidates[0].strippedNew).toBe('New text');
    });

    it('strips outer wrapping only, not nested tags', () => {
        const candidates = stripSpuriousWrappingTags(
            '<p><strong>Bold text</strong></p>',
            '<p><strong>New bold text</strong></p>',
        );
        expect(candidates).toHaveLength(3);
        // Leading-only: strip <p> but keep </p>
        expect(candidates[0].strippedOld).toBe('<strong>Bold text</strong></p>');
        // Trailing-only: keep <p> but strip </p>
        expect(candidates[1].strippedOld).toBe('<p><strong>Bold text</strong>');
        // Both: strip both
        expect(candidates[2].strippedOld).toBe('<strong>Bold text</strong>');
        expect(candidates[2].strippedNew).toBe('<strong>New bold text</strong>');
    });
});

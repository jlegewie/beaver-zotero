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

import { findStructuralAnchorHint } from '../../../src/utils/editNoteHints';


// =============================================================================
// Happy path: unique structural anchor recoverable
// =============================================================================

describe('findStructuralAnchorHint — unique anchor', () => {
    it('returns context around the unique <table> referenced in old_string', () => {
        const simplified =
            '<h2>User</h2>\n'
            + '<p>Prompt text.</p>\n'
            + '<h2>Beaver</h2>\n'
            + '<p>Here are the 5 most recent ones:</p>\n'
            + '<table>\n'
            + '<tbody>\n'
            + '<tr><td>2025</td><td>Some paper</td></tr>\n'
            + '</tbody>\n'
            + '</table>\n'
            + '<p>Summary line.</p>';
        // Model hallucinated this anchor — </h2> is not adjacent to <table>.
        const oldString = '</h2>\n<table>';

        const result = findStructuralAnchorHint(simplified, oldString);
        expect(result).not.toBeNull();
        // h2 is ambiguous (2 occurrences), so the hint should anchor on <table>.
        expect(result!.tagName).toBe('table');
        // Context must include the real predecessor and the table opener itself.
        expect(result!.context).toContain('<table>');
        expect(result!.context).toContain('most recent');
    });

    it('returns context for a single <blockquote> anchor', () => {
        const simplified =
            '<p>Intro paragraph.</p>\n'
            + '<blockquote>\n'
            + '<p>A famous quote.</p>\n'
            + '</blockquote>\n'
            + '<p>Outro.</p>';
        const oldString = '<blockquote>';

        const result = findStructuralAnchorHint(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.tagName).toBe('blockquote');
        expect(result!.context).toContain('<blockquote>');
    });

    it('uses the first unique tag when multiple candidates appear', () => {
        const simplified =
            '<p>Intro.</p>\n'
            + '<ul>\n'
            + '<li>item</li>\n'
            + '</ul>\n'
            + '<p>Between.</p>\n'
            + '<table>\n'
            + '<tbody></tbody>\n'
            + '</table>\n'
            + '<p>After.</p>';
        // <ul> and <table> are both unique — prefer the one mentioned first.
        const oldString = '</ul>\n<table>';

        const result = findStructuralAnchorHint(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.tagName).toBe('ul');
    });

    it('handles opening tags with attributes', () => {
        const simplified =
            '<p>Intro.</p>\n'
            + '<table class="data" id="t1">\n'
            + '<tbody></tbody>\n'
            + '</table>';
        const oldString = '<table>';

        const result = findStructuralAnchorHint(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.tagName).toBe('table');
        expect(result!.context).toContain('<table class="data" id="t1">');
    });

    it('treats tag name match case-insensitively', () => {
        const simplified =
            '<p>Intro.</p>\n'
            + '<TABLE>\n'
            + '<tbody></tbody>\n'
            + '</TABLE>';
        const oldString = '<table>';

        const result = findStructuralAnchorHint(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.tagName).toBe('table');
    });

    it('aligns context to line boundaries and truncates with ellipsis', () => {
        const simplified =
            '<p>Line one.</p>\n'
            + '<p>Line two.</p>\n'
            + '<hr>\n'
            + '<p>Line four.</p>\n'
            + '<p>Line five.</p>';
        const oldString = '<hr>';

        const result = findStructuralAnchorHint(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.tagName).toBe('hr');
        // <hr> is near the middle — both sides should show complete lines.
        expect(result!.context).toContain('<hr>');
    });
});


// =============================================================================
// Negative cases — should return null
// =============================================================================

describe('findStructuralAnchorHint — no hint', () => {
    it('returns null when the referenced tag appears multiple times', () => {
        const simplified =
            '<h2>User</h2>\n'
            + '<p>Prompt.</p>\n'
            + '<h2>Beaver</h2>\n'
            + '<p>Answer.</p>';
        const oldString = '<h2>';

        expect(findStructuralAnchorHint(simplified, oldString)).toBeNull();
    });

    it('returns null when the referenced tag does not exist in the note', () => {
        const simplified = '<p>Just some paragraphs.</p>\n<p>No table here.</p>';
        const oldString = '<table>';

        expect(findStructuralAnchorHint(simplified, oldString)).toBeNull();
    });

    it('returns null when old_string has no recognized structural tags', () => {
        const simplified =
            '<p>Intro.</p>\n'
            + '<table>\n'
            + '<tbody></tbody>\n'
            + '</table>';
        const oldString = 'just plain text with no tags';

        expect(findStructuralAnchorHint(simplified, oldString)).toBeNull();
    });

    it('returns null for inline-only tags (not in the structural list)', () => {
        const simplified = '<p>Some <strong>bold</strong> text.</p>';
        // <p> and <strong> are not structural anchor tags.
        const oldString = '<strong>bold</strong>';

        expect(findStructuralAnchorHint(simplified, oldString)).toBeNull();
    });

    it('returns null for empty old_string', () => {
        const simplified = '<p>Some text.</p>\n<table></table>';
        expect(findStructuralAnchorHint(simplified, '')).toBeNull();
    });

    it('falls through to the next candidate when the first is ambiguous', () => {
        const simplified =
            '<h2>First</h2>\n'
            + '<p>A.</p>\n'
            + '<h2>Second</h2>\n'
            + '<p>B.</p>\n'
            + '<table>\n'
            + '<tbody></tbody>\n'
            + '</table>';
        // h2 is ambiguous (2 matches), but table is unique — use table.
        const oldString = '</h2>\n<table>';

        const result = findStructuralAnchorHint(simplified, oldString);
        expect(result).not.toBeNull();
        expect(result!.tagName).toBe('table');
    });
});


// =============================================================================
// Real-world case from failed-edits-16.md
// =============================================================================

describe('findStructuralAnchorHint — real-world case', () => {
    it('produces an actionable hint for the </h2><table> hallucination', () => {
        const simplified =
            '<h2>User ↗</h2>\n'
            + '<p>search for external research by legewie</p>\n'
            + '<hr>\n'
            + '<h2>Beaver</h2>\n'
            + '<p>I\'ll search for recent publications.</p>\n'
            + '<p>I wasn\'t able to search external databases, but I found several publications by <strong>Joscha Legewie</strong> in your library. Here are the <strong>5 most recent</strong> ones:</p>\n'
            + '<table>\n'
            + '<tbody>\n'
            + '<tr><th>Year</th><th>Title</th></tr>\n'
            + '<tr><td>2025</td><td>Some paper</td></tr>\n'
            + '</tbody>\n'
            + '</table>\n'
            + '<p>Summary paragraph.</p>';
        const oldString = '</h2>\n<table>';

        const result = findStructuralAnchorHint(simplified, oldString);
        expect(result).not.toBeNull();
        // Multiple <h2> but exactly one <table> — hint must anchor on table.
        expect(result!.tagName).toBe('table');
        // The real predecessor ("most recent") must be visible in the context
        // so the model can rewrite old_string against real surrounding content.
        expect(result!.context).toContain('<table>');
        expect(result!.context).toContain('most recent');
    });
});

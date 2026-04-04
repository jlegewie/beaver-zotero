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

import { stripPartialSimplifiedElements } from '../../../src/utils/noteHtmlSimplifier';

// =============================================================================
// Helper
// =============================================================================

const CITATION_TAG = '<citation item_id="1-FQSW6YKU" page="237" label="(Legewie, 2018)" ref="c_FQSW6YKU_0"/>';

function makeSimplified(before: string, after: string): string {
    return before + CITATION_TAG + after;
}


// =============================================================================
// Leading partial element (starts with />)
// =============================================================================

describe('stripPartialSimplifiedElements — leading fragment', () => {
    it('strips leading /> from old_string when it is the tail of a citation', () => {
        const simplified = makeSimplified('Some text ', '—ein theoretisch relevant');
        const oldString = '/>—ein theoretisch';
        // Position where old_string starts in simplified
        const pos = simplified.indexOf(oldString);
        expect(pos).toBeGreaterThan(0);

        const result = stripPartialSimplifiedElements(oldString, '/>. Ein theoretisch', simplified, pos);
        expect(result).not.toBeNull();
        expect(result!.strippedOld).toBe('—ein theoretisch');
        expect(result!.strippedNew).toBe('. Ein theoretisch');
        expect(result!.leadingStrip).toBe(2);
        expect(result!.trailingStrip).toBe(0);
    });

    it('strips a longer leading fragment (attribute tail + />)', () => {
        const simplified = makeSimplified('Text ', ' more text');
        // old_string starts deeper inside the citation tag
        const oldString = 'ref="c_FQSW6YKU_0"/> more';
        const pos = simplified.indexOf(oldString);
        expect(pos).toBeGreaterThan(0);

        const result = stripPartialSimplifiedElements(oldString, 'ref="c_FQSW6YKU_0"/> changed', simplified, pos);
        expect(result).not.toBeNull();
        expect(result!.strippedOld).toBe(' more');
        expect(result!.strippedNew).toBe(' changed');
        expect(result!.leadingStrip).toBe(oldString.length - ' more'.length);
    });

    it('does not strip new_string leading fragment when new_string does not share it', () => {
        const simplified = makeSimplified('Text ', '—ein relevant');
        const oldString = '/>—ein relevant';
        const pos = simplified.indexOf(oldString);

        const result = stripPartialSimplifiedElements(oldString, 'replaced text', simplified, pos);
        expect(result).not.toBeNull();
        expect(result!.strippedOld).toBe('—ein relevant');
        expect(result!.strippedNew).toBe('replaced text'); // unchanged
    });

    it('returns null when no element boundary is involved', () => {
        const simplified = 'This is plain text without citations';
        const oldString = 'plain text';
        const pos = simplified.indexOf(oldString);

        const result = stripPartialSimplifiedElements(oldString, 'simple text', simplified, pos);
        expect(result).toBeNull();
    });

    it('returns null when old_string is entirely inside a tag (stripped to empty)', () => {
        const simplified = makeSimplified('Text ', ' more');
        // old_string is just the tag closing characters
        const oldString = '/>';
        const pos = simplified.indexOf(oldString);

        const result = stripPartialSimplifiedElements(oldString, '', simplified, pos);
        expect(result).toBeNull(); // stripped to empty
    });

    it('does not strip regular HTML tags (only simplified-only elements)', () => {
        const simplified = '<p>Some <strong>bold</strong> text</p>';
        // old_string starts inside a regular <strong> tag boundary
        const oldString = '>bold</strong>';
        const pos = simplified.indexOf(oldString);
        expect(pos).toBeGreaterThan(0);

        const result = stripPartialSimplifiedElements(oldString, '>italic</strong>', simplified, pos);
        expect(result).toBeNull(); // <strong> is not a simplified-only element
    });
});


// =============================================================================
// Trailing partial element (ends with partial <citation...)
// =============================================================================

describe('stripPartialSimplifiedElements — trailing fragment', () => {
    it('strips trailing partial citation opening from old_string', () => {
        const simplified = makeSimplified('Some text here ', ' after');
        // old_string includes the beginning of the citation tag
        const oldString = 'text here <citation item_id="1-FQSW6YKU"';
        const pos = simplified.indexOf(oldString);
        expect(pos).toBeGreaterThan(-1);

        const result = stripPartialSimplifiedElements(
            oldString, 'text here replacement', simplified, pos,
        );
        expect(result).not.toBeNull();
        expect(result!.strippedOld).toBe('text here ');
        expect(result!.trailingStrip).toBeGreaterThan(0);
    });

    it('does not strip trailing regular HTML tag fragment', () => {
        const simplified = '<p>Text before <strong>bo';
        const oldString = '<strong>bo';
        const pos = simplified.indexOf(oldString);

        const result = stripPartialSimplifiedElements(oldString, 'replacement', simplified, pos);
        expect(result).toBeNull(); // <strong> is not a simplified-only element
    });
});


// =============================================================================
// Both leading and trailing
// =============================================================================

describe('stripPartialSimplifiedElements — both boundaries', () => {
    it('strips both leading and trailing fragments', () => {
        const citation1 = '<citation item_id="1-AAA" ref="c_AAA_0"/>';
        const citation2 = '<citation item_id="1-BBB" ref="c_BBB_0"/>';
        const simplified = `Text before ${citation1} middle text ${citation2} after`;
        const oldString = '/> middle text <citation item_id="1-BBB"';
        const pos = simplified.indexOf(oldString);
        expect(pos).toBeGreaterThan(0);

        const result = stripPartialSimplifiedElements(
            oldString, '/> changed text <citation item_id="1-BBB"', simplified, pos,
        );
        expect(result).not.toBeNull();
        expect(result!.strippedOld).toBe(' middle text ');
        expect(result!.strippedNew).toBe(' changed text ');
        expect(result!.leadingStrip).toBe(2);
        expect(result!.trailingStrip).toBeGreaterThan(0);
    });
});


// =============================================================================
// annotation-image and image elements
// =============================================================================

describe('stripPartialSimplifiedElements — other element types', () => {
    it('strips leading /> from annotation-image tag', () => {
        const simplified = 'Text <annotation-image id="ai_1" alt="fig"/> after image';
        const oldString = '/> after image';
        const pos = simplified.indexOf(oldString);

        const result = stripPartialSimplifiedElements(oldString, '/> new text', simplified, pos);
        expect(result).not.toBeNull();
        expect(result!.strippedOld).toBe(' after image');
        expect(result!.strippedNew).toBe(' new text');
    });

    it('strips leading /> from image tag', () => {
        const simplified = 'Text <image id="i_1"/> after image';
        const oldString = '/> after image';
        const pos = simplified.indexOf(oldString);

        const result = stripPartialSimplifiedElements(oldString, '/> new text', simplified, pos);
        expect(result).not.toBeNull();
        expect(result!.strippedOld).toBe(' after image');
        expect(result!.strippedNew).toBe(' new text');
    });

    it('strips trailing partial annotation tag', () => {
        const simplified = 'Before <annotation id="a_1">highlighted text</annotation> after';
        const oldString = 'Before <annotation id=';
        const pos = simplified.indexOf(oldString);

        const result = stripPartialSimplifiedElements(oldString, 'Before replacement', simplified, pos);
        expect(result).not.toBeNull();
        expect(result!.strippedOld).toBe('Before ');
    });
});

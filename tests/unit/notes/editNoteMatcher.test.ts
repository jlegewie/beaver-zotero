import { describe, it, expect, vi } from 'vitest';

// =============================================================================
// Module mocks
// =============================================================================
// Stub the supabase / agentDataProvider utils transitive deps that the real
// noteHtmlSimplifier module pulls in via zoteroUtils → apiService → supabase.
// These stubs are only here to let the module load in a unit-test harness.

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn(() => 'unavailable'),
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(() => ''),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

// Identity expansion: simplified == raw for these tests. All other primitives
// (entity encode/decode, NFKC via String.prototype, countOccurrences, strip*)
// are exercised for real — they encapsulate the behavior we want to verify.
vi.mock('../../../src/utils/noteCitationExpand', async () => {
    const actual = await vi.importActual<typeof import('../../../src/utils/noteCitationExpand')>(
        '../../../src/utils/noteCitationExpand'
    );
    return {
        ...actual,
        expandToRawHtml: vi.fn((str: string) => str),
    };
});

// =============================================================================
// Imports
// =============================================================================

import {
    findBestMatch,
    expandBase,
    type MatchInput,
    type BaseExpansion,
} from '../../../src/services/agentDataProvider/actions/editNoteMatcher';
import type { EditNoteOperation } from '../../../react/types/agentActions/editNote';

// =============================================================================
// Helpers
// =============================================================================

function makeInput(overrides: Partial<MatchInput>): MatchInput {
    const simplified = overrides.simplified ?? overrides.strippedHtml ?? '';
    return {
        oldString: '',
        newString: '',
        operation: 'str_replace' as EditNoteOperation,
        metadata: { elements: new Map() } as any,
        simplified,
        strippedHtml: overrides.strippedHtml ?? simplified,
        externalRefContext: { externalRefs: new Map(), externalItemMapping: new Map() } as any,
        ...overrides,
    };
}

function match(input: MatchInput): ReturnType<typeof findBestMatch> {
    const base: BaseExpansion = expandBase(input);
    return findBestMatch(input, base);
}

// =============================================================================
// Per-strategy coverage
// =============================================================================

describe('findBestMatch strategies', () => {
    it('exact: returns the base match when expandedOld is found verbatim', () => {
        const result = match(makeInput({
            oldString: 'hello',
            newString: 'hi',
            strippedHtml: '<p>hello world</p>',
        }));
        expect(result?.strategy).toBe('exact');
        expect(result?.matchCount).toBe(1);
        expect(result?.expandedOld).toBe('hello');
        expect(result?.expandedNew).toBe('hi');
        expect(result?.normalizeAnchor('abc')).toBe('abc');
    });

    it('entity_decode: matches when note has decoded form but needle has entities', () => {
        const result = match(makeInput({
            oldString: 'it&#x27;s',
            newString: 'it&#x27;s was',
            strippedHtml: "<p>it's fine</p>",
        }));
        expect(result?.strategy).toBe('entity_decode');
        expect(result?.expandedOld).toBe("it's");
        expect(result?.expandedNew).toBe("it's was");
    });

    it('entity_encode: matches when note has entity-encoded form but needle has literal char', () => {
        const result = match(makeInput({
            oldString: "it's",
            newString: "it's was",
            strippedHtml: '<p>it&#x27;s fine</p>',
        }));
        expect(result?.strategy).toBe('entity_encode');
        expect(result?.expandedOld).toMatch(/&#x27;|&#39;|&apos;/);
        // normalizeAnchor re-applies the same entity form
        expect(result?.normalizeAnchor("it's")).not.toBe("it's");
    });

    it('nfkc: matches when note has half-width form but needle has full-width', () => {
        const result = match(makeInput({
            oldString: '（ア）',  // full-width parens
            newString: '（イ）',
            strippedHtml: '<p>(ア)</p>',  // half-width parens
        }));
        expect(result?.strategy).toBe('nfkc');
        expect(result?.expandedOld).toBe('(ア)');
        expect(result?.normalizeAnchor('（テスト）')).toBe('(テスト)');
    });

    it('trim_trailing_newlines: strips extra \\n from old_string and new_string', () => {
        const result = match(makeInput({
            oldString: 'hello\n\n',
            newString: 'hi\n\n',
            strippedHtml: '<p>hello world</p>',
        }));
        expect(result?.strategy).toBe('trim_trailing_newlines');
        expect(result?.oldString).toBe('hello');
        expect(result?.newString).toBe('hi');
    });

    it('trim_trailing_newlines: does not trim new_string for insert_after', () => {
        const result = match(makeInput({
            operation: 'insert_after' as EditNoteOperation,
            oldString: 'hello\n\n',
            newString: 'payload\n\n',
            strippedHtml: '<p>hello world</p>',
        }));
        expect(result?.strategy).toBe('trim_trailing_newlines');
        expect(result?.oldString).toBe('hello');
        expect(result?.newString).toBe('payload\n\n');  // untouched for insert
    });

    it('trim_trailing_newlines: trims merged insert_after replacement during execution', () => {
        const result = match(makeInput({
            operation: 'insert_after' as EditNoteOperation,
            oldString: 'hello\n\n',
            newString: 'hello\n\n world',
            strippedHtml: '<p>hello world</p>',
        }));
        expect(result?.strategy).toBe('trim_trailing_newlines');
        expect(result?.oldString).toBe('hello');
        expect(result?.newString).toBe('hello world');
    });

    it('trim_trailing_newlines: trims merged insert_before replacement during execution', () => {
        const result = match(makeInput({
            operation: 'insert_before' as EditNoteOperation,
            oldString: 'hello\n\n',
            newString: 'world hello\n\n',
            strippedHtml: '<p>hello world</p>',
        }));
        expect(result?.strategy).toBe('trim_trailing_newlines');
        expect(result?.oldString).toBe('hello');
        expect(result?.newString).toBe('world hello');
    });

    it('json_unescape: converts literal \\\\n / \\\\" escapes to real chars', () => {
        const result = match(makeInput({
            oldString: 'hello\\nworld',  // literal backslash-n
            newString: 'hi\\nthere',
            strippedHtml: '<p>hello\nworld extra</p>',  // real newline
        }));
        expect(result?.strategy).toBe('json_unescape');
        expect(result?.oldString).toBe('hello\nworld');
        expect(result?.newString).toBe('hi\nthere');
    });

    it('spurious_wrap_strip: unwraps matching <p>…</p> when note has bare text', () => {
        const result = match(makeInput({
            oldString: '<p>hello</p>',
            newString: '<p>hi</p>',
            strippedHtml: 'hello world',
        }));
        expect(result?.strategy).toBe('spurious_wrap_strip');
        expect(result?.oldString).toBe('hello');
        expect(result?.newString).toBe('hi');
    });
});

// =============================================================================
// Priority ordering
// =============================================================================

describe('findBestMatch priority', () => {
    it('picks exact over trim_trailing_newlines when both would match', () => {
        // If exact matches, trim is never tried. `hello` exists in the html
        // both as `hello\n\n` (exact) and `hello` (trimmed).
        const result = match(makeInput({
            oldString: 'hello\n\n',
            newString: 'hi\n\n',
            strippedHtml: '<p>hello\n\n world</p>',
        }));
        expect(result?.strategy).toBe('exact');
        expect(result?.oldString).toBe('hello\n\n');
    });

    it('picks entity_decode before spurious_wrap_strip', () => {
        // Both could theoretically apply, but entity_decode ranks higher.
        const result = match(makeInput({
            oldString: 'it&#x27;s',
            newString: "it's",
            strippedHtml: "<p>it's fine</p>",
        }));
        expect(result?.strategy).toBe('entity_decode');
    });

    it('falls through decode/encode/nfkc to trim when none of those apply', () => {
        const result = match(makeInput({
            oldString: 'plain\n',
            newString: 'replaced',
            strippedHtml: '<p>plain text</p>',
        }));
        expect(result?.strategy).toBe('trim_trailing_newlines');
    });
});

// =============================================================================
// No-match
// =============================================================================

describe('findBestMatch nothing matches', () => {
    it('returns null when no strategy can find old_string', () => {
        const result = match(makeInput({
            oldString: 'this text does not exist',
            newString: 'replacement',
            strippedHtml: '<p>totally unrelated content</p>',
        }));
        expect(result).toBeNull();
    });

    it('returns null for empty old_string', () => {
        const result = match(makeInput({
            oldString: '',
            newString: 'x',
            strippedHtml: '<p>hello</p>',
        }));
        // exact strategy's countOccurrences of '' returns 0 (guarded by
        // countOccurrences itself), so no strategy matches.
        expect(result).toBeNull();
    });
});

// =============================================================================
// Multi-match behavior
// =============================================================================

describe('findBestMatch multi-match', () => {
    it('returns matchCount > 1 when str_replace_all has multiple occurrences', () => {
        const result = match(makeInput({
            operation: 'str_replace_all' as EditNoteOperation,
            oldString: 'hello',
            newString: 'hi',
            strippedHtml: '<p>hello hello hello</p>',
        }));
        expect(result?.strategy).toBe('exact');
        expect(result?.matchCount).toBe(3);
    });

    it('returns matchCount > 1 for str_replace — disambiguation is caller-level', () => {
        const result = match(makeInput({
            operation: 'str_replace' as EditNoteOperation,
            oldString: 'dup',
            newString: 'new',
            strippedHtml: '<p>dup and dup</p>',
        }));
        expect(result?.strategy).toBe('exact');
        expect(result?.matchCount).toBe(2);
        expect(result?.rawPositionHint).toBeUndefined();
    });
});

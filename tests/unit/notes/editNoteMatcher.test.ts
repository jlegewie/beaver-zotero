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
import { expandToRawHtml } from '../../../src/utils/noteCitationExpand';
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

    it('markdown_to_html: converts **bold** in old_string to <strong>', () => {
        const result = match(makeInput({
            oldString: 'the **important** part',
            newString: 'the **critical** part',
            strippedHtml: '<p>the <strong>important</strong> part</p>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('the <strong>important</strong> part');
        expect(result?.newString).toBe('the <strong>critical</strong> part');
        expect(result?.matchCount).toBe(1);
    });

    it('markdown_to_html: converts __bold__ (GFM alt syntax) to <strong>', () => {
        const result = match(makeInput({
            oldString: 'the __important__ part',
            newString: 'the __critical__ part',
            strippedHtml: '<p>the <strong>important</strong> part</p>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('the <strong>important</strong> part');
        expect(result?.newString).toBe('the <strong>critical</strong> part');
    });

    it('markdown_to_html: converts ATX headings on their own line', () => {
        const result = match(makeInput({
            oldString: '## 系统组件',
            newString: '## 核心组件',
            strippedHtml: '<h2>系统组件</h2>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('<h2>系统组件</h2>');
        expect(result?.newString).toBe('<h2>核心组件</h2>');
    });

    it('markdown_to_html: handles multiple heading levels (# through ######)', () => {
        const result = match(makeInput({
            oldString: '#### a',
            newString: '#### b',
            strippedHtml: '<h4>a</h4>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('<h4>a</h4>');
    });

    it('markdown_to_html: strips optional ATX closing fence (## Title ##)', () => {
        // CommonMark: closing `#+` preceded by whitespace is not part of the
        // heading text. Without stripping it, `## Title ##` would convert to
        // `<h2>Title ##</h2>` and never match the rendered `<h2>Title</h2>`.
        const result = match(makeInput({
            oldString: '## Title ##',
            newString: '## NewTitle ###',
            strippedHtml: '<h2>Title</h2>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('<h2>Title</h2>');
        expect(result?.newString).toBe('<h2>NewTitle</h2>');
    });

    it('markdown_to_html: accepts tab between # and heading text (CommonMark)', () => {
        const result = match(makeInput({
            oldString: '##\tHeading',
            newString: '##\tNew',
            strippedHtml: '<h2>Heading</h2>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('<h2>Heading</h2>');
        expect(result?.newString).toBe('<h2>New</h2>');
    });

    it('markdown_to_html: accepts up to 3 leading spaces before # (CommonMark)', () => {
        const result = match(makeInput({
            oldString: '   ## Heading',
            newString: '   ## New',
            strippedHtml: '<h2>Heading</h2>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('<h2>Heading</h2>');
    });

    it('markdown_to_html: rejects 4+ leading spaces (would be a code block in CommonMark)', () => {
        const result = match(makeInput({
            oldString: '    ## Heading',
            newString: '    ## New',
            strippedHtml: '<h2>Heading</h2>',
        }));
        expect(result).toBeNull();
    });

    it('markdown_to_html: rejects # without trailing whitespace (#Heading is not ATX)', () => {
        const result = match(makeInput({
            oldString: '##Heading',
            newString: '##New',
            strippedHtml: '<h2>Heading</h2>',
        }));
        expect(result).toBeNull();
    });

    it('markdown_to_html: trims trailing whitespace from heading text', () => {
        // CommonMark strips trailing whitespace from heading text. Without
        // this, `<h2>Heading   </h2>` would not match the rendered `<h2>Heading</h2>`.
        const result = match(makeInput({
            oldString: '## Heading   ',
            newString: '## New   ',
            strippedHtml: '<h2>Heading</h2>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('<h2>Heading</h2>');
        expect(result?.newString).toBe('<h2>New</h2>');
    });

    it('markdown_to_html: absorbs CRLF \\r so heading text never carries it', () => {
        // Stored notes use LF line endings. If model sends CRLF, the captured
        // heading text must still produce `<h2>Heading</h2>` and not
        // `<h2>Heading\r</h2>`, which would never match.
        const result = match(makeInput({
            oldString: '## Heading\r\nNext line',
            newString: '## New\r\nNext line',
            strippedHtml: '<h2>Heading</h2>\nNext line',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('<h2>Heading</h2>\nNext line');
    });

    it('markdown_to_html: keeps trailing # when not preceded by whitespace (## Section#5)', () => {
        // CommonMark requires whitespace before the closing fence; `Section#5`
        // must stay intact in the heading text.
        const result = match(makeInput({
            oldString: '## Section#5',
            newString: '## Section#6',
            strippedHtml: '<h2>Section#5</h2>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('<h2>Section#5</h2>');
        expect(result?.newString).toBe('<h2>Section#6</h2>');
    });

    it('markdown_to_html: does not convert markdown inside HTML tag attributes', () => {
        // `**x**` inside a tag attribute stays literal — attribute safety via
        // split-on-tags. The `<citation .../>` tag itself is unchanged.
        const result = match(makeInput({
            oldString: 'pre <citation label="**x**"/> **real** post',
            newString: 'pre <citation label="**x**"/> **changed** post',
            strippedHtml: 'pre <citation label="**x**"/> <strong>real</strong> post',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('pre <citation label="**x**"/> <strong>real</strong> post');
        expect(result?.newString).toBe('pre <citation label="**x**"/> <strong>changed</strong> post');
    });

    it('markdown_to_html: returns null when old_string has no markdown markers', () => {
        // Plain text without markdown falls through past markdown_to_html to null.
        const result = match(makeInput({
            oldString: 'plain text not in note',
            newString: 'replacement',
            strippedHtml: '<p>totally different content</p>',
        }));
        expect(result).toBeNull();
    });

    it('markdown_to_html: returns null when converted markdown still does not match', () => {
        const result = match(makeInput({
            oldString: '**missing**',
            newString: '**new**',
            strippedHtml: '<p>no match here</p>',
        }));
        expect(result).toBeNull();
    });

    it('markdown_to_html: supports insert_after with markdown old_string', () => {
        // Validation-time: new_string is the bare payload (no merge yet).
        const result = match(makeInput({
            operation: 'insert_after' as EditNoteOperation,
            oldString: '**title**',
            newString: ' tail',
            strippedHtml: '<p><strong>title</strong> body</p>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('<strong>title</strong>');
        expect(result?.newString).toBe(' tail');
    });

    it('markdown_to_html: symmetrically converts merged insert_after new_string', () => {
        // Execution-time: new_string = old + injected (merged by caller).
        // Converting both sides keeps the prefix aligned.
        const result = match(makeInput({
            operation: 'insert_after' as EditNoteOperation,
            oldString: '**title**',
            newString: '**title** injected',
            strippedHtml: '<p><strong>title</strong> body</p>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('<strong>title</strong>');
        expect(result?.newString).toBe('<strong>title</strong> injected');
        // Replacement must start with the transformed anchor so the merged
        // form still "inserts after" the anchor in raw HTML space.
        expect(result?.newString.startsWith(result!.oldString)).toBe(true);
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

    it('prefers exact over markdown_to_html when old_string already has <strong>', () => {
        // Regression guard: markdown_to_html must never shadow an exact match.
        const result = match(makeInput({
            oldString: 'the <strong>important</strong> part',
            newString: 'replacement',
            strippedHtml: '<p>the <strong>important</strong> part here</p>',
        }));
        expect(result?.strategy).toBe('exact');
    });

    it('markdown_to_html runs last: tried only after all other strategies fail', () => {
        // Construct a case where only markdown_to_html can win by making all
        // earlier strategies definitively fail.
        const result = match(makeInput({
            oldString: '**x**',
            newString: '**y**',
            strippedHtml: '<p><strong>x</strong></p>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
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

// =============================================================================
// Production replay: real old_string_not_found failures from thread analysis
// (see /tmp/beaver-threads/diff_detailed.json). Each seeds the haystack with
// the actual rendered HTML from create_note's note_content and the needle
// with the markdown the model submitted.
// =============================================================================

describe('markdown_to_html production replay', () => {
    it('CJK bold: model sent **扩展** but note has <strong>扩展</strong>', () => {
        const result = match(makeInput({
            oldString: '该研究**扩展**了现有光操控文献中的观点',
            newString: '该研究**深化**了现有光操控文献中的观点',
            strippedHtml:
                '<p>一、研究主要内容</p>\n'
                + '<p>本文研究了<strong>在外部光照下的旋转粒子动力学</strong>，'
                + '该研究<strong>扩展</strong>了现有光操控文献中的观点，'
                + '突破了经典系统中无法实现净光放大的传统认知。</p>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('该研究<strong>扩展</strong>了现有光操控文献中的观点');
        expect(result?.newString).toBe('该研究<strong>深化</strong>了现有光操控文献中的观点');
    });

    it('English inline bold: **Key insight:** matches rendered <strong>Key insight:</strong>', () => {
        const result = match(makeInput({
            oldString: '<p>**Key insight:** Recession gave way to **stagflation in India**</p>',
            newString: '<p>**Key insight:** Recession yielded to **stagflation**</p>',
            strippedHtml:
                '<p><strong>Key insight:</strong> Recession gave way to '
                + '<strong>stagflation in India</strong></p>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe(
            '<p><strong>Key insight:</strong> Recession gave way to <strong>stagflation in India</strong></p>',
        );
    });

    it('ATX heading: ## 系统组件与技术选择 matches rendered <h2>', () => {
        const result = match(makeInput({
            oldString: '## 系统组件与技术选择',
            newString: '## 核心系统组件',
            strippedHtml:
                '<p>强度，$\\rho$ 为密度。</p>\n'
                + '<h2>系统组件与技术选择</h2>\n'
                + '<h3>2.1 飞轮/转子材料</h3>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
        expect(result?.oldString).toBe('<h2>系统组件与技术选择</h2>');
    });
});

// =============================================================================
// whitespace_relaxed
// =============================================================================

describe('whitespace_relaxed strategy', () => {
    // -- Positive cases --

    it('matches when needle has an extra blank line between tags', () => {
        // Thread-1 production repro: model's old_string had <hr>\n\n<p>…
        // while note had <hr>\n<p>….
        const rawSlice = '<hr>\n<p><strong>Synthese :</strong> long body text anchor</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const result = match(makeInput({
            oldString: '<hr>\n\n<p><strong>Synthese :</strong> long body text anchor</p>',
            newString: '<p>REPLACED</p>',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('whitespace_relaxed');
        expect(result?.matchCount).toBe(1);
        expect(result?.expandedOld).toBe(rawSlice);
        expect(result?.oldString).toBe(rawSlice);
        expect(result?.expandedNew).toBe('<p>REPLACED</p>');
        expect(result?.normalizeAnchor('abc')).toBe('abc');
    });

    it('matches when needle has multiple spaces where note has single spaces', () => {
        // Pure ASCII whitespace drift — nfkc can't handle it (no full-width
        // chars), so this isolates the whitespace_relaxed path.
        const noteText = '<p>hello world with more padding text here for anchor</p>';
        const result = match(makeInput({
            oldString: 'hello   world with  more   padding text here for anchor',
            newString: 'hi there',
            strippedHtml: noteText,
        }));
        expect(result?.strategy).toBe('whitespace_relaxed');
        expect(result?.matchCount).toBe(1);
        expect(result?.expandedOld).toBe('hello world with more padding text here for anchor');
    });

    it('pins JS `\\s` matching \\u00A0 (NBSP) via normalizeWS', () => {
        // NBSP is also handled upstream by `nfkc`, so we assert the edit
        // succeeds — not that this specific strategy wins. This pins the
        // runtime behavior that NBSP is whitespace under `\s`.
        const result = match(makeInput({
            oldString: 'hello\u00A0world with more padding text here for anchor',
            newString: 'hi there',
            strippedHtml: '<p>hello world with more padding text here for anchor</p>',
        }));
        expect(result).not.toBeNull();
        // Either nfkc (which would normalize NBSP) or whitespace_relaxed is
        // acceptable — both produce a correct edit.
        expect(['nfkc', 'whitespace_relaxed']).toContain(result?.strategy);
    });

    it('matches when needle has a tab where note has spaces', () => {
        const html = '<p>key: value with enough chars after to pass the gate</p>';
        const result = match(makeInput({
            oldString: 'key:\tvalue with enough chars after to pass the gate',
            newString: 'replaced',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('whitespace_relaxed');
        expect(result?.expandedOld).toBe('key: value with enough chars after to pass the gate');
    });

    it('insert_after (validate form): expandedNew starts with actual raw slice', () => {
        const rawSlice = '<p>Anchor paragraph with plenty of text here</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const result = match(makeInput({
            operation: 'insert_after' as EditNoteOperation,
            oldString: '<p>Anchor  paragraph with plenty  of text here</p>',  // double spaces
            newString: '<p>Injected payload</p>',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('whitespace_relaxed');
        expect(result?.expandedOld).toBe(rawSlice);
        expect(result?.expandedNew.startsWith(rawSlice)).toBe(true);
        expect(result?.expandedNew.endsWith('<p>Injected payload</p>')).toBe(true);
    });

    it('insert_after (execute form, pre-merged newString): strips prefix before expanding', () => {
        const rawSlice = '<p>Anchor paragraph with plenty of text here</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const needle = '<p>Anchor  paragraph with plenty  of text here</p>';
        const merged = needle + '<p>Injected</p>';
        const result = match(makeInput({
            operation: 'insert_after' as EditNoteOperation,
            oldString: needle,
            newString: merged,  // already merged form (from normalized_action_data)
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('whitespace_relaxed');
        // Must be rawSlice + '<p>Injected</p>', NOT rawSlice + merged.
        expect(result?.expandedNew).toBe(rawSlice + '<p>Injected</p>');
    });

    it('insert_before (execute form, pre-merged newString): expandedNew ends with raw slice', () => {
        const rawSlice = '<p>Anchor paragraph with plenty of text here</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const needle = '<p>Anchor  paragraph with plenty  of text here</p>';
        const merged = '<p>Preamble</p>' + needle;
        const result = match(makeInput({
            operation: 'insert_before' as EditNoteOperation,
            oldString: needle,
            newString: merged,
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('whitespace_relaxed');
        expect(result?.expandedNew).toBe('<p>Preamble</p>' + rawSlice);
        expect(result?.expandedNew.endsWith(rawSlice)).toBe(true);
    });

    // -- Safety gates --

    it('rejects when normalized needle is shorter than the minimum length', () => {
        const result = match(makeInput({
            oldString: 'A B',  // normalized length 3, below threshold
            newString: 'X',
            strippedHtml: '<p>A    B here and more</p>',
        }));
        expect(result).toBeNull();
    });

    it('rejects when non-whitespace char count in needle is too low', () => {
        // Needle: 7 non-ws chars (a b c d e f g) — below 12. Must differ in
        // whitespace shape from the haystack so exact/trim don't grab it.
        const needle = 'a  b\n\n\n\nc  d   \t\t  e  f  g';
        const haystack = '<p>a b c d e f g</p>';  // single spaces
        expect(needle.length).toBeGreaterThanOrEqual(20);
        expect(needle.replace(/\s/g, '').length).toBeLessThan(12);
        const result = match(makeInput({
            oldString: needle,
            newString: 'x',
            strippedHtml: haystack,
        }));
        // Other strategies don't apply (no exact, no entity, no trim match on
        // this structure), so full chain returns null.
        expect(result).toBeNull();
    });

    it('rejects when needle has leading whitespace', () => {
        const result = match(makeInput({
            oldString: '  anchor paragraph with enough length here',
            newString: 'x',
            strippedHtml: '<p>anchor  paragraph with enough length here</p>',
        }));
        expect(result).toBeNull();
    });

    it('rejects when needle has trailing whitespace', () => {
        const result = match(makeInput({
            oldString: 'anchor paragraph with enough length here   ',
            newString: 'x',
            strippedHtml: '<p>anchor  paragraph with enough length here</p>',
        }));
        expect(result).toBeNull();
    });

    it('rejects when the regex finds multiple raw matches', () => {
        // Two ws-relaxed occurrences with whitespace shapes distinct from the
        // needle so `exact` misses and whitespace_relaxed sees 2.
        const result = match(makeInput({
            oldString: 'foo\n\nbar with enough chars after to pass gate',
            newString: 'x',
            strippedHtml:
                '<p>foo bar with enough chars after to pass gate</p>'
                + '<p>foo\tbar with enough chars after to pass gate</p>',
        }));
        expect(result).toBeNull();
    });

    it('rejects str_replace_all even when the normalized match is unique', () => {
        const rawSlice = '<p>Anchor paragraph with plenty of text here</p>';
        const result = match(makeInput({
            operation: 'str_replace_all' as EditNoteOperation,
            oldString: '<p>Anchor  paragraph with plenty  of text here</p>',
            newString: 'x',
            strippedHtml: `<div data-schema-version="9">${rawSlice}</div>`,
        }));
        expect(result).toBeNull();
    });

    it('rejects when needle differs from base.expandedOld (citation indirection)', () => {
        // Swap the identity `expandToRawHtml` mock for one that transforms the
        // needle, so `base.expandedOld !== input.oldString`. The strategy must
        // decline — it relies on simplified==raw for the needle to return
        // `expandedOld = actualRawSlice` safely.
        const mocked = vi.mocked(expandToRawHtml);
        // Only the first call (expandBase for oldString) rewrites; subsequent
        // calls fall back to identity.
        mocked.mockImplementationOnce(
            (s: string) => s.replace('CITE', '<span class="citation">X</span>'),
        );
        try {
            const result = match(makeInput({
                oldString: 'anchor CITE with enough body text to clear the length gate',
                newString: 'x',
                strippedHtml: '<p>anchor CITE with enough body  text to clear the length gate</p>',
            }));
            // whitespace_relaxed must refuse; no other strategy matches
            // because strippedHtml has literal 'CITE' while base.expandedOld
            // has the expanded span form. Full chain returns null.
            expect(result).toBeNull();
        } finally {
            mocked.mockImplementation((s: string) => s);
        }
    });

    it('rejects when needle has no whitespace at all', () => {
        // Defensive gate: exact would've handled any no-ws needle already.
        const result = match(makeInput({
            oldString: 'singletokenwithnowhitespace',
            newString: 'x',
            strippedHtml: '<p>singletokenwithnowhitespace here</p>',
        }));
        // `exact` should claim this — `whitespace_relaxed` is not responsible.
        expect(result?.strategy).toBe('exact');
    });

    it('rejects when needle length exceeds the ReDoS cap', () => {
        const chunk = 'abc def ';
        const huge = chunk.repeat(700);  // ~5600 chars > 5000 cap
        expect(huge.length).toBeGreaterThan(5000);
        const result = match(makeInput({
            oldString: huge,
            newString: 'x',
            strippedHtml: `<p>${huge.replace(/ /g, '\t')}</p>`,
        }));
        // Other strategies don't match either (no exact, no entity, etc.), so
        // the full chain returns null.
        expect(result).toBeNull();
    });

    // -- Priority / regression --

    it('exact wins over whitespace_relaxed when the needle matches byte-for-byte', () => {
        const rawSlice = '<p>Anchor paragraph with plenty of text here</p>';
        const result = match(makeInput({
            oldString: rawSlice,
            newString: 'x',
            strippedHtml: `<div data-schema-version="9">${rawSlice}</div>`,
        }));
        expect(result?.strategy).toBe('exact');
    });

    it('markdown_to_html wins over whitespace_relaxed when whitespace is unchanged', () => {
        // Needle uses markdown; note has same whitespace shape but HTML tags.
        // markdown_to_html ranks before whitespace_relaxed — regression guard.
        const result = match(makeInput({
            oldString: 'the **important** anchor with enough chars here',
            newString: 'replacement',
            strippedHtml: '<p>the <strong>important</strong> anchor with enough chars here</p>',
        }));
        expect(result?.strategy).toBe('markdown_to_html');
    });

    it('falls through to whitespace_relaxed only after all other strategies fail', () => {
        // No exact, no entity drift, no trim tail, no markdown — only ws diff.
        const rawSlice = '<p>Unique anchor phrase with enough chars to pass</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const result = match(makeInput({
            oldString: '<p>Unique  anchor  phrase  with  enough  chars  to  pass</p>',
            newString: 'x',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('whitespace_relaxed');
    });

    // -- Sanity invariants --

    it('normalizeAnchor is the identity function', () => {
        const rawSlice = '<p>Anchor paragraph with plenty of text here</p>';
        const result = match(makeInput({
            oldString: '<p>Anchor  paragraph  with  plenty  of text here</p>',
            newString: 'x',
            strippedHtml: `<div data-schema-version="9">${rawSlice}</div>`,
        }));
        expect(result?.strategy).toBe('whitespace_relaxed');
        expect(result?.normalizeAnchor('<p>before</p>')).toBe('<p>before</p>');
    });

    it('returned expandedOld is a literal substring of strippedHtml', () => {
        const rawSlice = '<p>Anchor paragraph with plenty of text here</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const result = match(makeInput({
            oldString: '<p>Anchor  paragraph  with  plenty of text here</p>',
            newString: 'x',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('whitespace_relaxed');
        // Executor's invariant: expandedOld must be in strippedHtml as-is.
        expect(html.indexOf(result!.expandedOld)).toBeGreaterThanOrEqual(0);
    });
});

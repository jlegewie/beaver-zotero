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
// quote_normalized
// =============================================================================

describe('quote_normalized strategy', () => {
    it('German low quotes: needle has "…" and haystack has „…"', () => {
        const rawSlice = '<p>Onfray, „Les sagesses antiques."</p>';
        const html = `<div data-schema-version="9">${rawSlice} other content</div>`;
        const result = match(makeInput({
            oldString: '<p>Onfray, "Les sagesses antiques."</p>',
            newString: '<p>Onfray, Les sagesses.</p>',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('quote_normalized');
        expect(result?.matchCount).toBe(1);
        // The returned expandedOld is the raw slice with curly quotes preserved.
        expect(result?.expandedOld).toBe(rawSlice);
        expect(result?.expandedNew).toBe('<p>Onfray, Les sagesses.</p>');
        // Anchors fold on their way to the executor's raw-space lookup.
        expect(result?.normalizeAnchor('„literal"')).toBe('"literal"');
    });

    it('English curly double quotes: \u201C…\u201D → "…"', () => {
        const rawSlice = '<p>\u201CImportant\u201D note here with body text</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const result = match(makeInput({
            oldString: '<p>"Important" note here with body text</p>',
            newString: '<p>updated</p>',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('quote_normalized');
        expect(result?.expandedOld).toBe(rawSlice);
    });

    it('French guillemets: «…» → "…"', () => {
        const rawSlice = '<p>Et «voilà» la preuve</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const result = match(makeInput({
            oldString: '<p>Et "voilà" la preuve</p>',
            newString: '<p>fini</p>',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('quote_normalized');
        expect(result?.expandedOld).toBe(rawSlice);
    });

    it('smart single quotes: it\u2019s → it\'s', () => {
        const rawSlice = '<p>it\u2019s a test sentence</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const result = match(makeInput({
            oldString: "<p>it's a test sentence</p>",
            newString: "<p>REPLACED</p>",
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('quote_normalized');
        expect(result?.expandedOld).toBe(rawSlice);
    });

    it('falls through to `exact` when both sides use ASCII quotes only', () => {
        const result = match(makeInput({
            oldString: '<p>"plain ASCII"</p>',
            newString: '<p>replaced</p>',
            strippedHtml: '<div data-schema-version="9"><p>"plain ASCII"</p></div>',
        }));
        expect(result?.strategy).toBe('exact');
    });

    it('`entity_decode` wins over `quote_normalized` (ordering regression)', () => {
        // Needle uses entity form, haystack has the decoded ASCII. entity_decode
        // should claim this case because it runs earlier in the chain.
        const result = match(makeInput({
            oldString: 'it&#x27;s fine',
            newString: 'it&#x27;s done',
            strippedHtml: "<p>it's fine here</p>",
        }));
        expect(result?.strategy).toBe('entity_decode');
    });

    it('rejects when mixed curly shapes fold to the same ASCII form (ambiguous)', () => {
        // Safety: when the model's ASCII needle folds to the same form as two
        // differently-quoted spans in the note (e.g., one „…" and one "…"),
        // picking the first folded position's raw slice would silently edit
        // the wrong one. The strategy refuses so the retry_prompt's candidate
        // hints can show both forms and the model can pick explicitly.
        // Both rawSlices must fold to the same text as the needle — same
        // surrounding letters, different quote styles.
        const rawSliceA = '<p>Quote \u201Etest case\u201D text</p>';
        const rawSliceB = '<p>Quote \u201Ctest case\u201D text</p>';
        const html = `<div data-schema-version="9">${rawSliceA}${rawSliceB}</div>`;
        const result = match(makeInput({
            oldString: '<p>Quote "test case" text</p>',
            newString: '<p>X</p>',
            strippedHtml: html,
        }));
        expect(result).toBeNull();
    });

    it('matches when distinct surrounding text disambiguates the folded form', () => {
        // Same haystack topology as the rejection case above, but here only
        // one folded occurrence matches — the other paragraph's letter
        // sequence differs. foldedCount = 1 so the uniqueness gate passes.
        const rawSlice = '<p>Quote \u201Etest case\u201D A text</p>';
        const html = `<div data-schema-version="9">${rawSlice}<p>Quote "test case" B text</p></div>`;
        const result = match(makeInput({
            oldString: '<p>Quote "test case" A text</p>',
            newString: '<p>X</p>',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('quote_normalized');
        expect(result?.matchCount).toBe(1);
        expect(result?.expandedOld).toBe(rawSlice);
    });

    it('rejects str_replace_all when folded matches carry different raw slices', () => {
        // Safety gate: splitting on actualRawSlice would miss occurrences with
        // a different curly shape. Both rawSlices must be non-ASCII so that
        // `exact` can't win before this strategy runs.
        const rawSliceA = '<p>\u201Etest case\u201D example text</p>';  // low-9 + curly close
        const rawSliceB = '<p>\u201Ctest case\u201D example text</p>';  // curly open + curly close
        const html = `<div data-schema-version="9">${rawSliceA}${rawSliceB}</div>`;
        const result = match(makeInput({
            operation: 'str_replace_all' as EditNoteOperation,
            oldString: '<p>"test case" example text</p>',
            newString: '<p>X</p>',
            strippedHtml: html,
        }));
        expect(result).toBeNull();
    });

    it('allows str_replace_all when all folded matches share the same raw slice', () => {
        // Two occurrences of the same curly shape → split/join works cleanly.
        // Use a curly-only slice so `exact` can't win.
        const rawSlice = '<p>\u201Etest\u201D repeat body</p>';
        const html = `<div data-schema-version="9">${rawSlice}${rawSlice}</div>`;
        const result = match(makeInput({
            operation: 'str_replace_all' as EditNoteOperation,
            oldString: '<p>"test" repeat body</p>',
            newString: '<p>X</p>',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('quote_normalized');
        expect(result?.matchCount).toBe(2);
    });

    it('returns null when no curly variants are present in either side', () => {
        // Defensive: foldedOld === base.expandedOld means nothing to do.
        const result = match(makeInput({
            oldString: 'ASCII only here',
            newString: 'something else',
            strippedHtml: '<p>totally different</p>',
        }));
        expect(result).toBeNull();
    });

    it('insert_after (execute form): preserves curly glyphs in the actual raw slice', () => {
        // Model wrote ASCII `"…"` in old_string, the note has German low
        // quotes. The merged newString (execute-time shape) starts with the
        // ASCII old_string prefix; if we naively expanded the whole merged
        // form, the inserted region would lose the note's `„…"` glyphs.
        const rawSlice = '<p>Foucault, \u201EHistoire\u201C</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const needle = '<p>Foucault, "Histoire"</p>';
        const merged = needle + '<p>Injected payload</p>';
        const result = match(makeInput({
            operation: 'insert_after' as EditNoteOperation,
            oldString: needle,
            newString: merged,
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('quote_normalized');
        // Must be rawSlice (with „…") + injected payload, NOT needle + injected.
        expect(result?.expandedNew).toBe(rawSlice + '<p>Injected payload</p>');
        expect(result?.expandedNew.startsWith(rawSlice)).toBe(true);
    });

    it('insert_before (execute form): preserves curly glyphs in the actual raw slice', () => {
        const rawSlice = '<p>Foucault, \u201EHistoire\u201C</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const needle = '<p>Foucault, "Histoire"</p>';
        const merged = '<p>Preamble</p>' + needle;
        const result = match(makeInput({
            operation: 'insert_before' as EditNoteOperation,
            oldString: needle,
            newString: merged,
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('quote_normalized');
        expect(result?.expandedNew).toBe('<p>Preamble</p>' + rawSlice);
        expect(result?.expandedNew.endsWith(rawSlice)).toBe(true);
    });

    it('insert_after (validate form): expandedNew still starts with the preserved raw slice', () => {
        // Validate-time shape: newString is just the raw injected payload,
        // not prefixed by oldString. Insert branch falls through to expanding
        // newString as-is, then concatenates with actualRawSlice.
        const rawSlice = '<p>Foucault, \u201EHistoire\u201C long enough body</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const result = match(makeInput({
            operation: 'insert_after' as EditNoteOperation,
            oldString: '<p>Foucault, "Histoire" long enough body</p>',
            newString: '<p>Injected payload</p>',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('quote_normalized');
        expect(result?.expandedNew.startsWith(rawSlice)).toBe(true);
        expect(result?.expandedNew.endsWith('<p>Injected payload</p>')).toBe(true);
    });

    it('normalizeAnchor folds curly quotes on target context strings', () => {
        const rawSlice = '<p>Onfray, „Les sagesses antiques."</p>';
        const html = `<div data-schema-version="9">${rawSlice}</div>`;
        const result = match(makeInput({
            oldString: '<p>Onfray, "Les sagesses antiques."</p>',
            newString: '<p>X</p>',
            strippedHtml: html,
        }));
        expect(result?.strategy).toBe('quote_normalized');
        // Executor calls normalizeAnchor on validator-supplied target_before/
        // after_context before matching. Curly shapes collapse to ASCII so
        // anchors can match no matter which quote style the validator stored.
        expect(result?.normalizeAnchor('Before „test" and')).toBe('Before "test" and');
        expect(result?.normalizeAnchor("after \u2018single\u2019")).toBe("after 'single'");
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
// Failure scenarios: real old_string_not_found failures. Each seeds the haystack
// with the actual rendered HTML from create_note's note_content and the needle
// with the markdown the model submitted.
// =============================================================================

describe('markdown_to_html failure scenarios', () => {
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
        // Failure scenario: model's old_string had <hr>\n\n<p>…
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

    it('matches when needle contains a citation and haystack shares the expanded form', () => {
        // Regression guard for the extended behavior: whitespace_relaxed now
        // builds the regex from `base.expandedOld` (raw space), so needles
        // that contain <citation>/<annotation>/math delimiters can still
        // match through whitespace drift. The needle's simplified form
        // differs from its expanded form, but the haystack carries the
        // expanded form — the strategy should find it.
        const mocked = vi.mocked(expandToRawHtml);
        mocked.mockImplementationOnce(
            (s: string) => s.replace('CITE', '<span class="citation">X</span>'),
        );
        try {
            const rawSlice
                = 'anchor <span class="citation">X</span> with enough body text to clear the length gate';
            const html = `<p>${rawSlice}</p>`;
            const result = match(makeInput({
                oldString: 'anchor CITE with enough body  text to clear the length gate',
                newString: 'x',
                strippedHtml: html,
            }));
            expect(result?.strategy).toBe('whitespace_relaxed');
            expect(html.indexOf(result!.expandedOld)).toBeGreaterThanOrEqual(0);
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

    it('matches a needle whose simplified form contains a `<citation>` tag', () => {
        // d35fc72d repro: the model's old_string differs from the note only
        // in whitespace, but contains a <citation> — so the pre-extension
        // gate `input.oldString !== base.expandedOld` used to reject it.
        const mocked = vi.mocked(expandToRawHtml);
        const expand = (s: string) =>
            s.replace(
                /<citation ref="([^"]+)" item_id="([^"]+)"\/>/g,
                '<span class="citation" data-ref="$1" data-item="$2">(…)</span>',
            );
        mocked.mockImplementation(expand);
        try {
            const rawSlice =
                '<p>Anchor paragraph intro '
                + '<span class="citation" data-ref="c_A_0" data-item="1-AAAAAAAA">(…)</span>'
                + ' with enough body text to clear the length gate</p>';
            const html = `<div data-schema-version="9">${rawSlice}</div>`;
            // Needle uses double whitespace where the note has single — classic
            // whitespace drift, now tolerated even with the <citation>.
            const needleWithDrift =
                '<p>Anchor   paragraph intro\n\n'
                + '<citation ref="c_A_0" item_id="1-AAAAAAAA"/>'
                + '  with enough body text to clear the length gate</p>';
            const result = match(makeInput({
                oldString: needleWithDrift,
                newString: '<p>REWRITTEN</p>',
                strippedHtml: html,
            }));
            expect(result?.strategy).toBe('whitespace_relaxed');
            // expandedOld is a literal slice of strippedHtml.
            expect(html.indexOf(result!.expandedOld)).toBeGreaterThanOrEqual(0);
        } finally {
            mocked.mockImplementation((s: string) => s);
        }
    });
});

// =============================================================================
// whitespace_relaxed with literal `&nbsp;` entity
// =============================================================================
//
// Failure scenario: the note's saved HTML contained literal `&nbsp;` (5 chars)
// as the text between words, while the model's old_string used regular spaces.
// The original `\s+` whitespace pattern matched U+00A0 the *character* but not
// the 5-char *string* `&nbsp;`, so the strategy refused. Folding `&nbsp;` into
// the whitespace class fixes both directions.

describe('whitespace_relaxed handles literal &nbsp; entity failure scenario', () => {
    it('matches model space against literal &nbsp; in haystack', () => {
        // Long enough to clear MIN_WS_RELAXED_NORMALIZED_LENGTH (20) and
        // MIN_WS_RELAXED_NON_WS_LENGTH (12).
        const needle = 'analyzed using linear mixed-effects models with FDR correction';
        const haystack = '<p>analyzed using&nbsp;linear mixed-effects models with FDR correction</p>';
        const result = match(makeInput({
            oldString: needle,
            newString: needle + ' replaced',
            strippedHtml: haystack,
        }));
        expect(result?.strategy).toBe('whitespace_relaxed');
        expect(result?.matchCount).toBe(1);
        // expandedOld is the actual raw slice (preserving `&nbsp;`).
        expect(result?.expandedOld).toContain('&nbsp;');
    });

    // Symmetric direction — proves the `hasWhitespaceOrNbsp()` gate works.
    // Without the gate change, this case would skip whitespace_relaxed
    // entirely (the old `/\s/.test(needle)` returns false for a needle
    // whose only whitespace is `&nbsp;`).
    it('matches model &nbsp; against regular space in haystack', () => {
        const needle = 'analyzed using&nbsp;linear mixed-effects models with FDR correction';
        const haystack = '<p>analyzed using linear mixed-effects models with FDR correction</p>';
        const result = match(makeInput({
            oldString: needle,
            newString: 'analyzed using&nbsp;linear mixed-effects models with FDR correction (added)',
            strippedHtml: haystack,
        }));
        expect(result?.strategy).toBe('whitespace_relaxed');
        expect(result?.matchCount).toBe(1);
        // The replacement should splice in the haystack's actual raw slice
        // (with regular spaces), not the model's `&nbsp;` form.
        expect(result?.expandedOld).not.toContain('&nbsp;');
    });
});

// =============================================================================
// tag_attribute_strip
// =============================================================================
//
// Failure scenario: when the model writes
// `<p style="font-size: 0.85em; margin-left: 2em;">⁴ <strong>…</strong>…</p>`
// in op=rewrite, Zotero's PM normalizer strips the inline `style` attribute,
// leaving `<p>⁴ <strong>…</strong>…</p>`. A subsequent edit_note that uses
// the model's original styled form fails. This strategy recovers by stripping
// attributes from block-level structural tags (p, h1–h6, blockquote).

describe('tag_attribute_strip strategy', () => {
    // ── When tag_attribute_strip is strictly necessary ──
    //
    // `spurious_wrap_strip` already handles the symmetric case where old and
    // new share the SAME wrapping tag (`<p style="x">…</p>` on both sides):
    // it strips the shared wrap and matches inner content. So
    // `tag_attribute_strip` only WINS the chain when old and new differ in
    // their leading or trailing tag, e.g. insert_after where the injected
    // payload has a bare `<p>`. Both strategies produce a correct edit when
    // they apply; the dedicated tests below isolate cases tag_attribute_strip
    // alone can solve.

    it('wins for str_replace when old and new have different leading tag attributes', () => {
        // Old has `<p style="x">`, new has plain `<p>` — they don't share the
        // leading tag so spurious_wrap_strip can't strip it. tag_attribute_strip
        // claims this by stripping the style off old's `<p>` to match the
        // haystack's bare `<p>`.
        const result = match(makeInput({
            oldString: '<p style="font-size: 0.85em;">⁴ footnote text.</p>',
            newString: '<p>⁴ footnote text. (added)</p>',
            strippedHtml: '<p>⁴ footnote text.</p>',
        }));
        expect(result?.strategy).toBe('tag_attribute_strip');
        expect(result?.expandedOld).toBe('<p>⁴ footnote text.</p>');
        expect(result?.expandedNew).toBe('<p>⁴ footnote text. (added)</p>');
        expect(result?.matchCount).toBe(1);
    });

    it('strips multiple attributes (style, class, id) on the same tag', () => {
        const result = match(makeInput({
            oldString: '<p id="x" class="y" style="z">body content here</p>',
            newString: '<h2>different shape</h2>',  // different leading tag
            strippedHtml: '<p>body content here</p>',
        }));
        expect(result?.strategy).toBe('tag_attribute_strip');
        expect(result?.expandedOld).toBe('<p>body content here</p>');
        expect(result?.expandedNew).toBe('<h2>different shape</h2>');
    });

    it('strips attributes from <h2> headings (asymmetric needle)', () => {
        // Old has `<h2 class>`, new is bare `<h2>` — spurious_wrap_strip
        // would only strip if both shared `<h2 class>`.
        const result = match(makeInput({
            oldString: '<h2 class="section">3.4 Title</h2>',
            newString: '<h2>3.4 New Title</h2>',
            strippedHtml: '<h2>3.4 Title</h2>',
        }));
        expect(result?.strategy).toBe('tag_attribute_strip');
        expect(result?.expandedOld).toBe('<h2>3.4 Title</h2>');
    });

    it('strips attributes from <blockquote> (asymmetric needle)', () => {
        const result = match(makeInput({
            oldString: '<blockquote class="quote">cited text</blockquote>',
            newString: '<blockquote>replaced</blockquote>',
            strippedHtml: '<blockquote>cited text</blockquote>',
        }));
        expect(result?.strategy).toBe('tag_attribute_strip');
    });

    it('symmetric attribute-laden case is correctly handled by spurious_wrap_strip', () => {
        // When old and new share the same wrapping `<p style="x">…</p>`, the
        // earlier spurious_wrap_strip strategy claims the case (it strips the
        // shared wrap and matches inner content). Either result produces a
        // correct edit; this regression guard pins the actual ordering.
        const result = match(makeInput({
            oldString: '<p style="font-size: 0.85em;">⁴ footnote text.</p>',
            newString: '<p style="font-size: 0.85em;">⁴ footnote text. (added)</p>',
            strippedHtml: '<p>⁴ footnote text.</p>',
        }));
        expect(result?.strategy).toBe('spurious_wrap_strip');
        expect(result?.matchCount).toBe(1);
    });

    it('does NOT touch <span> attributes (citation tags must keep their data)', () => {
        // span/div/a are intentionally excluded so `<span class="citation"
        // data-citation="…">` and similar carriers keep their attributes.
        // This test sets up a haystack that would only match if span attrs
        // were stripped — the strategy should refuse.
        const result = match(makeInput({
            oldString: '<span class="x">irrelevant payload</span>',
            newString: '<span class="x">y</span>',
            strippedHtml: '<p>completely different content here</p>',
        }));
        expect(result).toBeNull();
    });

    it('does NOT touch <div> attributes (data-schema-version wrapper, etc.)', () => {
        const result = match(makeInput({
            oldString: '<div data-schema-version="9">wrapper content</div>',
            newString: '<div data-schema-version="9">replaced</div>',
            strippedHtml: '<p>unrelated content</p>',
        }));
        expect(result).toBeNull();
    });

    it('returns null when the needle has no strippable block-tag attributes', () => {
        // Without attributes to strip, the strategy correctly defers to later
        // strategies (or the overall null result if none match).
        const result = match(makeInput({
            oldString: '<p>plain</p>',
            newString: '<p>replaced</p>',
            strippedHtml: '<p>completely different</p>',
        }));
        expect(result).toBeNull();
    });

    // Insert-op shapes — same coverage other strategies with insertion
    // semantics (whitespace_relaxed, markdown_to_html) carry, so
    // tag_attribute_strip doesn't regress when execution re-enters the
    // matcher with the merged form from normalized_action_data.
    it('insert_after with validate-time bare new_string preserves the anchor (regression: P2)', () => {
        // Validate-time shape: new_string is just the injected payload.
        // Without the insert-aware splice, expandedNew would be just
        // `<p>injected</p>` and the executor's str_replace would REPLACE the
        // anchor instead of inserting after it. The fix mirrors
        // whitespace_relaxed/quote_normalized: build `expandedOld + injected`
        // so the splice keeps the anchor.
        const result = match(makeInput({
            operation: 'insert_after' as EditNoteOperation,
            oldString: '<p style="font-size: 0.85em;">anchor body text</p>',
            newString: '<p>injected</p>',  // bare payload (validate-time shape)
            strippedHtml: '<p>anchor body text</p>',
        }));
        expect(result?.strategy).toBe('tag_attribute_strip');
        expect(result?.expandedOld).toBe('<p>anchor body text</p>');
        // expandedNew = anchor + injected (splice preserves the anchor).
        expect(result?.expandedNew).toBe('<p>anchor body text</p><p>injected</p>');
        expect(result?.expandedNew.startsWith(result!.expandedOld)).toBe(true);
    });

    it('insert_after with execute-time merged new_string is handled by spurious_wrap_strip (leading-only)', () => {
        // Document the actual ordering: when execute re-runs the matcher with
        // normalized_action_data, the merged new_string is `oldString +
        // injected`, so it always shares the leading wrap with oldString.
        // spurious_wrap_strip's leading-only candidate strips the shared
        // `<p style="…">` from both, then matches `anchor body text</p>` in
        // the haystack's `<p>anchor body text</p>` and splices the injected
        // payload after it. The end-to-end result is correct (the saved HTML
        // has the bare `<p>` form) — tag_attribute_strip is not needed here.
        const result = match(makeInput({
            operation: 'insert_after' as EditNoteOperation,
            oldString: '<p style="font-size: 0.85em;">anchor body text</p>',
            newString: '<p style="font-size: 0.85em;">anchor body text</p><p>injected</p>',
            strippedHtml: '<p>anchor body text</p>',
        }));
        expect(result?.strategy).toBe('spurious_wrap_strip');
        expect(result?.matchCount).toBe(1);
    });

    // Note on execute-time merged inputs: when normalized_action_data is
    // present, the merged new_string starts with oldString. spurious_wrap_strip
    // (which runs first) handles all such cases by leading-strip — the
    // tag_attribute_strip insert handler's prefix-strip path is the safety
    // net for the merged shape if it ever falls through. The end-to-end
    // round-trip test in editNote.test.ts covers the validate→normalize→
    // execute cycle for tag_attribute_strip explicitly.

    it('insert_before with bare validate-time new_string preserves the anchor (regression: P2)', () => {
        // Validate-time: new_string is the bare injected payload (no merge yet).
        // Old = `<p style=…>anchor</p>`, new = `<p>injected</p>`. They don't
        // share the leading tag (different attributes) but DO share the
        // trailing `</p>`. spurious_wrap_strip's trailing-only candidate
        // produces `<p style=…>anchor` and `<p>injected` — the styled form
        // doesn't appear in the bare-`<p>` haystack, so it fails. Falls
        // through to tag_attribute_strip, which must build `injected + anchor`
        // so the splice doesn't replace the anchor.
        const result = match(makeInput({
            operation: 'insert_before' as EditNoteOperation,
            oldString: '<p style="font-size: 0.85em;">anchor body text</p>',
            newString: '<p>injected</p>',
            strippedHtml: '<p>anchor body text</p>',
        }));
        expect(result?.strategy).toBe('tag_attribute_strip');
        expect(result?.expandedOld).toBe('<p>anchor body text</p>');
        expect(result?.expandedNew).toBe('<p>injected</p><p>anchor body text</p>');
        expect(result?.expandedNew.endsWith(result!.expandedOld)).toBe(true);
    });

    // Priority — make sure tag_attribute_strip slots in correctly and doesn't
    // shadow more specific strategies that already handle the case.
    it('exact wins when the model already wrote bare tags', () => {
        const result = match(makeInput({
            oldString: '<p>bare tag</p>',
            newString: '<p>replaced</p>',
            strippedHtml: '<p>bare tag</p>',
        }));
        expect(result?.strategy).toBe('exact');
    });

    it('runs before markdown_to_html (more specific signal)', () => {
        // Asymmetric leading tags so spurious_wrap_strip cannot claim it.
        // Falls through past spurious_wrap_strip to tag_attribute_strip,
        // which must run before markdown_to_html so the strategy chain
        // doesn't try to read `**…**` as markdown when it's actually plain
        // text in an attribute-laden block tag.
        const result = match(makeInput({
            oldString: '<p style="x">plain body without markdown markers</p>',
            newString: '<h2>different shape</h2>',
            strippedHtml: '<p>plain body without markdown markers</p>',
        }));
        expect(result?.strategy).toBe('tag_attribute_strip');
    });
});

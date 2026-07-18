import { describe, it, expect, vi } from 'vitest';

// =============================================================================
// Module mocks (must precede imports)
// =============================================================================
// The core pulls in the real ranked matcher + position-lookup + validation
// helpers. We stub only the leaf modules those transitively load (supabase,
// zoteroUtils, agentDataProvider utils, logger) and make `expandToRawHtml`
// the identity so `simplified === strippedHtml` and matching runs on plain
// text. Everything else (countOccurrences, findBestMatch, overlap, apply) is
// exercised for real.

vi.mock('../../../src/services/supabaseClient', () => ({
    supabase: { auth: { getSession: vi.fn() } },
}));

vi.mock('../../../src/services/agentDataProvider/utils', () => ({
    getAttachmentFileStatus: vi.fn(() => 'unavailable'),
    getDeferredToolPreference: vi.fn(() => 'always_ask'),
    checkLibraryExcluded: vi.fn(() => null),
    excludedLibraryMessage: vi.fn((id: number) => `Library ${id} excluded`),
}));

vi.mock('../../../src/utils/zoteroUtils', () => ({
    createCitationHTML: vi.fn(() => ''),
    getZoteroUserIdentifier: vi.fn(() => ({ userID: undefined, localUserKey: 'test' })),
}));

vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

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
    resolveBatchEdits,
    detectOverlaps,
    applyResolvedEdits,
    captureUndoContexts,
    findAllOccurrences,
    buildAmbiguousMatchError,
    type BatchEditSpec,
    type ResolveBatchContext,
    type ResolvedBatchEdit,
} from '../../../src/utils/editNoteBatchCore';
import {
    addOrUpdateEditFooter,
    getBeaverFooterAppendPoint,
} from '../../../src/utils/noteEditFooter';
import type { EditNoteOperation } from '../../../react/types/agentActions/editNote';

// =============================================================================
// Helpers
// =============================================================================

function makeCtx(
    strippedHtml: string,
    overrides: Partial<ResolveBatchContext> = {},
): ResolveBatchContext {
    return {
        strippedHtml,
        simplified: strippedHtml,
        metadata: { elements: new Map() } as any,
        externalRefContext: {} as any,
        pageLabels: {},
        resolvedLocatorPages: {},
        appendPoint: getBeaverFooterAppendPoint(strippedHtml),
        mode: 'validate',
        ...overrides,
    };
}

function spec(
    index: number,
    operation: EditNoteOperation,
    oldString: string,
    newString: string,
    extra: Partial<BatchEditSpec> = {},
): BatchEditSpec {
    return { index, operation, oldString, newString, ...extra };
}

/** Sequential left-to-right apply of non-overlapping edits (reference impl). */
function applyLeftToRight(html: string, resolved: ResolvedBatchEdit[]): string {
    const ops = resolved.flatMap((r) =>
        r.applyOps.map((op) => ({ ...op, editIndex: r.index })),
    );
    ops.sort((a, b) => a.start - b.start || a.editIndex - b.editIndex);
    let out = html;
    let delta = 0;
    for (const op of ops) {
        const s = op.start + delta;
        const e = op.end + delta;
        out = out.slice(0, s) + op.replacement + out.slice(e);
        delta += op.replacement.length - (op.end - op.start);
    }
    return out;
}

function resolveOrThrow(ctx: ResolveBatchContext, specs: BatchEditSpec[]): ResolvedBatchEdit[] {
    const { resolved, failures } = resolveBatchEdits(ctx, specs);
    expect(failures).toEqual([]);
    return resolved;
}

// =============================================================================
// findAllOccurrences
// =============================================================================

describe('findAllOccurrences', () => {
    it('returns every non-overlapping occurrence', () => {
        expect(findAllOccurrences('a foo b foo c', 'foo')).toEqual([2, 8]);
    });

    it('advances by needle length (no overlapping matches)', () => {
        expect(findAllOccurrences('aaaa', 'aa')).toEqual([0, 2]);
    });

    it('returns [] for an empty needle', () => {
        expect(findAllOccurrences('abc', '')).toEqual([]);
    });
});

// =============================================================================
// str_replace_all ranges + overlap participation
// =============================================================================

describe('str_replace_all ranges', () => {
    it('produces a range for every occurrence', () => {
        const ctx = makeCtx('aaa foo bbb foo ccc');
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'str_replace_all', 'foo', 'X'),
        ]);
        expect(resolved[0].ranges).toEqual([
            { start: 4, end: 7 },
            { start: 12, end: 15 },
        ]);
        expect(resolved[0].occurrencesReplaced).toBe(2);
        expect(resolved[0].matchCount).toBe(2);
    });

    it('every occurrence participates in overlap detection (str_replace_all hitting a sibling anchor)', () => {
        const ctx = makeCtx('aaa foo bbb foo ccc');
        // edit 1's target "foo ccc" covers the SECOND foo occurrence.
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'str_replace_all', 'foo', 'X'),
            spec(1, 'str_replace', 'foo ccc', 'Y'),
        ]);
        const overlaps = detectOverlaps(resolved);
        expect(overlaps).toEqual([{ firstIndex: 0, secondIndex: 1 }]);
    });

    it('does not flag a str_replace_all whose occurrences miss every sibling range', () => {
        const ctx = makeCtx('aaa foo bbb foo ccc ddd');
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'str_replace_all', 'foo', 'X'),
            spec(1, 'str_replace', 'ddd', 'Y'),
        ]);
        expect(detectOverlaps(resolved)).toEqual([]);
    });
});

// =============================================================================
// Overlap rules
// =============================================================================

describe('detectOverlaps', () => {
    it('allows adjacent ranges (a.end === b.start)', () => {
        const ctx = makeCtx('ABCD');
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'str_replace', 'AB', 'X'),
            spec(1, 'str_replace', 'CD', 'Y'),
        ]);
        expect(resolved[0].ranges).toEqual([{ start: 0, end: 2 }]);
        expect(resolved[1].ranges).toEqual([{ start: 2, end: 4 }]);
        expect(detectOverlaps(resolved)).toEqual([]);
    });

    it('rejects a true intersection and reports both indices', () => {
        const ctx = makeCtx('ABCDE');
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'str_replace', 'ABC', 'X'),
            spec(1, 'str_replace', 'BCD', 'Y'),
        ]);
        expect(detectOverlaps(resolved)).toEqual([{ firstIndex: 0, secondIndex: 1 }]);
    });

    it('rejects two inserts resolving to the same anchor', () => {
        const ctx = makeCtx('hello world');
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'insert_after', 'hello', ' A'),
            spec(1, 'insert_after', 'hello', ' B'),
        ]);
        // Both anchor ranges are [0, 5] → identical → intersect.
        expect(resolved[0].ranges).toEqual([{ start: 0, end: 5 }]);
        expect(resolved[1].ranges).toEqual([{ start: 0, end: 5 }]);
        expect(detectOverlaps(resolved)).toEqual([{ firstIndex: 0, secondIndex: 1 }]);
    });

    it('reports every offending pair', () => {
        const ctx = makeCtx('ABCDEF');
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'str_replace', 'ABC', 'x'),
            spec(1, 'str_replace', 'BCD', 'y'),
            spec(2, 'str_replace', 'CDE', 'z'),
        ]);
        // 0∩1 (ABC/BCD), 0∩2 (ABC/CDE at C), 1∩2 (BCD/CDE)
        expect(detectOverlaps(resolved)).toEqual([
            { firstIndex: 0, secondIndex: 1 },
            { firstIndex: 0, secondIndex: 2 },
            { firstIndex: 1, secondIndex: 2 },
        ]);
    });
});

// =============================================================================
// applyResolvedEdits ordering
// =============================================================================

describe('applyResolvedEdits', () => {
    it('descending-offset apply == sequential left-to-right (single-op edits)', () => {
        const html = 'the quick brown fox jumps';
        const ctx = makeCtx(html);
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'str_replace', 'quick', 'slow'),
            spec(1, 'str_replace', 'fox', 'cat'),
        ]);
        const { newStrippedHtml } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe(applyLeftToRight(html, resolved));
        expect(newStrippedHtml).toBe('the slow brown cat jumps');
    });

    it('descending-offset apply == sequential left-to-right (mixed operations)', () => {
        const html = '<div>alpha beta gamma delta</div>';
        const ctx = makeCtx(html);
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'str_replace', 'alpha', 'ALPHA'),
            spec(1, 'insert_after', 'beta', '!'),
            spec(2, 'str_replace_all', 'a', 'A'),
            spec(3, 'append', '', ' END'),
        ]);
        // 'a' str_replace_all would overlap 'alpha'/'beta'/'gamma'; guard the
        // property check against non-overlapping edits only.
        // Re-run with genuinely non-overlapping edits:
        const resolved2 = resolveOrThrow(makeCtx('one two three four five'), [
            spec(0, 'str_replace', 'one', 'ONE'),
            spec(1, 'insert_after', 'three', '*'),
            spec(2, 'str_replace', 'five', 'FIVE'),
        ]);
        const base = 'one two three four five';
        const { newStrippedHtml } = applyResolvedEdits(base, resolved2);
        expect(newStrippedHtml).toBe(applyLeftToRight(base, resolved2));
        expect(newStrippedHtml).toBe('ONE two three* four FIVE');
        // resolved is unused beyond ensuring mixed ops resolve without throwing.
        expect(resolved).toHaveLength(4);
    });

    it('same-position ties (two appends) come out in edits[] order', () => {
        const html = '<div data-schema-version="9">body</div>';
        const ctx = makeCtx(html);
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'append', '', 'AAA'),
            spec(1, 'append', '', 'BBB'),
        ]);
        const { newStrippedHtml } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('<div data-schema-version="9">bodyAAABBB</div>');
    });

    it('same-position ties (two zero-width inserts) come out in edits[] order', () => {
        // Two edits whose apply ops both splice at the same offset with identical
        // empty removal ranges — index order must be preserved. Build resolved
        // edits directly to isolate the tie-break (real inserts would overlap).
        const html = 'XY';
        const resolved: ResolvedBatchEdit[] = [
            {
                index: 0, operation: 'append', expandedOld: '', expandedNew: 'A',
                ranges: [], matchCount: 1, occurrencesReplaced: 1,
                applyOps: [{ start: 1, end: 1, replacement: 'A', fragmentOffset: 0, fragmentLength: 1 }],
                undoOldHtml: '', undoNewHtml: 'A', warnings: [],
            },
            {
                index: 1, operation: 'append', expandedOld: '', expandedNew: 'B',
                ranges: [], matchCount: 1, occurrencesReplaced: 1,
                applyOps: [{ start: 1, end: 1, replacement: 'B', fragmentOffset: 0, fragmentLength: 1 }],
                undoOldHtml: '', undoNewHtml: 'B', warnings: [],
            },
        ];
        const { newStrippedHtml } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('XABY');
    });
});

// =============================================================================
// Undo-draft correctness
// =============================================================================

describe('undo drafts', () => {
    it('str_replace: undo_old_html/undo_new_html carry the expanded fragments', () => {
        const html = 'foo bar baz';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', 'bar', 'qux'),
        ]);
        const { undoDrafts } = applyResolvedEdits(html, resolved);
        expect(undoDrafts[0]).toMatchObject({
            index: 0,
            operation: 'str_replace',
            undo_old_html: 'bar',
            undo_new_html: 'qux',
        });
        // Contexts bracket the replaced region in the applied HTML.
        expect(undoDrafts[0].undo_before_context).toBe('foo ');
        expect(undoDrafts[0].undo_after_context).toBe(' baz');
    });

    it('insert_after: undo_old_html is empty and undo_new_html is the injected fragment only', () => {
        const html = 'hello world';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'insert_after', 'hello', ' INS'),
        ]);
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('hello INS world');
        expect(undoDrafts[0]).toMatchObject({
            operation: 'insert_after',
            undo_old_html: '',
            undo_new_html: ' INS',
        });
        // before-context ends with the preserved anchor.
        expect(undoDrafts[0].undo_before_context).toBe('hello');
        expect(undoDrafts[0].undo_after_context).toBe(' world');
    });

    it('insert_before: injected fragment precedes the preserved anchor', () => {
        const html = 'hello world';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'insert_before', 'world', 'INS '),
        ]);
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('hello INS world');
        expect(undoDrafts[0]).toMatchObject({
            operation: 'insert_before',
            undo_old_html: '',
            undo_new_html: 'INS ',
        });
    });

    it('append: undo_old_html empty, undo_new_html is the appended fragment', () => {
        const html = '<div>body</div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'append', '', 'MORE'),
        ]);
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('<div>bodyMORE</div>');
        expect(undoDrafts[0]).toMatchObject({
            operation: 'append',
            undo_old_html: '',
            undo_new_html: 'MORE',
        });
    });

    it('rewrite: undo_old_html carries the FULL pre-edit body', () => {
        const html = '<div data-schema-version="9">original body</div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'rewrite', '', 'brand new content'),
        ]);
        expect(resolved[0].undoOldHtml).toBe(html);
        expect(resolved[0].ranges).toEqual([{ start: 0, end: html.length }]);
        const { undoDrafts } = applyResolvedEdits(html, resolved);
        expect(undoDrafts[0]).toMatchObject({
            operation: 'rewrite',
            undo_old_html: html,
            undo_new_html: 'brand new content',
        });
    });

    it('str_replace_all: one occurrence context per replaced occurrence', () => {
        const html = 'x foo y foo z';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace_all', 'foo', 'BAR'),
        ]);
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('x BAR y BAR z');
        expect(undoDrafts[0].undo_old_html).toBe('foo');
        expect(undoDrafts[0].undo_new_html).toBe('BAR');
        expect(undoDrafts[0].undo_occurrence_contexts).toHaveLength(2);
        expect(undoDrafts[0].undo_occurrence_contexts![0]).toEqual({ before: 'x ', after: ' y BAR z' });
        expect(undoDrafts[0].undo_occurrence_contexts![1]).toEqual({ before: 'x BAR y ', after: ' z' });
    });
});

// =============================================================================
// captureUndoContexts refresh
// =============================================================================

describe('captureUndoContexts', () => {
    it('refreshes single-fragment contexts against the final HTML', () => {
        const html = 'foo bar baz';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', 'bar', 'qux'),
        ]);
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        // Simulate a footer appended at the end (does not shift the edit).
        const finalStripped = `${newStrippedHtml}<p>footer</p>`;
        captureUndoContexts(finalStripped, undoDrafts);
        expect(undoDrafts[0].undo_before_context).toBe('foo ');
        expect(undoDrafts[0].undo_after_context).toBe(' baz<p>footer</p>');
    });

    it('refreshes a deletion seam after a footer is inserted at the old note end', () => {
        const html = '<div><p>keep</p><p>remove</p></div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<p>remove</p>', ''),
        ]);
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        expect(undoDrafts[0].undo_after_context).toBe('</div>');

        const finalStripped = addOrUpdateEditFooter(newStrippedHtml, 'thread-1');
        captureUndoContexts(finalStripped, undoDrafts);

        expect(undoDrafts[0].undo_before_context).toBe('<div><p>keep</p>');
        expect(undoDrafts[0].undo_after_context).toContain('Edited by Beaver');
        expect(
            `${undoDrafts[0].undo_before_context}${undoDrafts[0].undo_after_context}`,
        ).toBe(finalStripped);
    });

    it('refreshes every replace-all deletion seam against final footer HTML', () => {
        const html = '<div><p>remove</p><p>middle</p><p>remove</p></div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace_all', '<p>remove</p>', ''),
        ]);
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        const finalStripped = addOrUpdateEditFooter(newStrippedHtml, 'thread-1');

        captureUndoContexts(finalStripped, undoDrafts);

        const contexts = undoDrafts[0].undo_occurrence_contexts!;
        expect(contexts).toHaveLength(2);
        expect(contexts[1].before).toBe('<div><p>middle</p>');
        expect(contexts[1].after).toContain('Edited by Beaver');
    });

    it('leaves contexts unchanged when the fragment is not uniquely locatable', () => {
        const html = 'foo bar baz';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', 'bar', 'qux'),
        ]);
        const { undoDrafts } = applyResolvedEdits(html, resolved);
        const before = undoDrafts[0].undo_before_context;
        const after = undoDrafts[0].undo_after_context;
        // 'qux' appears twice in the final HTML → ambiguous → keep apply-time.
        captureUndoContexts('qux and qux everywhere', undoDrafts);
        expect(undoDrafts[0].undo_before_context).toBe(before);
        expect(undoDrafts[0].undo_after_context).toBe(after);
    });
});

// =============================================================================
// Failure reporting
// =============================================================================

describe('resolveBatchEdits failures', () => {
    it('collects a per-edit old_string_not_found without short-circuiting', () => {
        const ctx = makeCtx('the actual note content');
        const { resolved, failures } = resolveBatchEdits(ctx, [
            spec(0, 'str_replace', 'actual', 'real'),
            spec(1, 'str_replace', 'nonexistent text', 'x'),
            spec(2, 'str_replace', 'content', 'body'),
        ]);
        expect(resolved.map((r) => r.index)).toEqual([0, 2]);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ index: 1, errorCode: 'old_string_not_found' });
    });

    it('reports ambiguous_match when a str_replace target is not unique and lacks anchors', () => {
        const ctx = makeCtx('dup here and dup there', { mode: 'execute' });
        const { failures } = resolveBatchEdits(ctx, [
            spec(0, 'str_replace', 'dup', 'x'),
        ]);
        expect(failures[0]).toMatchObject({ index: 0, errorCode: 'ambiguous_match' });
    });
});

describe('buildAmbiguousMatchError', () => {
    it('suggests str_replace_all for replacement edits', () => {
        const msg = buildAmbiguousMatchError(3, 'str_replace');
        expect(msg).toContain('found 3 times');
        expect(msg).toContain('str_replace_all');
    });

    it.each(['insert_after', 'insert_before'] as EditNoteOperation[])(
        'asks for a unique anchor instead of str_replace_all for %s',
        (op) => {
            const msg = buildAmbiguousMatchError(2, op);
            expect(msg).toContain('insertion anchor');
            expect(msg).toContain('found 2 times');
            expect(msg).not.toContain('str_replace_all');
        },
    );

    it('flows the insert-aware hint through resolveBatchEdits failures', () => {
        const ctx = makeCtx('dup here and dup there');
        const { failures } = resolveBatchEdits(ctx, [
            spec(0, 'insert_after', 'dup', 'dup X'),
        ]);
        expect(failures[0]).toMatchObject({ index: 0, errorCode: 'ambiguous_match' });
        expect(failures[0].error).toContain('insertion anchor');
        expect(failures[0].error).not.toContain('str_replace_all');
    });
});

// =============================================================================
// Append overlap hardening (zero-width range at the append point)
// =============================================================================

describe('append overlap gate', () => {
    it('gives append a zero-width range at the append point', () => {
        const html = '<div data-schema-version="9"><p>Alpha.</p></div>';
        const ctx = makeCtx(html);
        const resolved = resolveOrThrow(ctx, [spec(0, 'append', '', '<p>New.</p>')]);
        expect(resolved[0].ranges).toEqual([{ start: ctx.appendPoint, end: ctx.appendPoint }]);
    });

    it('rejects a sibling range strictly containing the append point', () => {
        const html = '<div data-schema-version="9"><p>Alpha.</p></div>';
        const ctx = makeCtx(html, { appendPoint: html.indexOf('Alpha') + 2 });
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'str_replace', 'Alpha.', 'Beta.'),
            spec(1, 'append', '', '<p>New.</p>'),
        ]);
        const overlaps = detectOverlaps(resolved);
        expect(overlaps).toEqual([{ firstIndex: 0, secondIndex: 1 }]);
    });

    it('allows an append adjacent to a range ending at the append point', () => {
        const html = '<div data-schema-version="9"><p>Alpha.</p></div>';
        const anchor = '<p>Alpha.</p>';
        const ctx = makeCtx(html, { appendPoint: html.indexOf(anchor) + anchor.length });
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'str_replace', anchor, '<p>Beta.</p>'),
            spec(1, 'append', '', '<p>New.</p>'),
        ]);
        expect(detectOverlaps(resolved)).toEqual([]);
    });

    it('allows two appends at the same append point', () => {
        const html = '<div data-schema-version="9"><p>Alpha.</p></div>';
        const ctx = makeCtx(html);
        const resolved = resolveOrThrow(ctx, [
            spec(0, 'append', '', '<p>One.</p>'),
            spec(1, 'append', '', '<p>Two.</p>'),
        ]);
        expect(detectOverlaps(resolved)).toEqual([]);
    });
});

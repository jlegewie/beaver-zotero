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
    type BatchUndoDraft,
    type ResolveBatchContext,
    type ResolvedBatchEdit,
} from '../../../src/utils/editNoteBatchCore';
import {
    addOrUpdateEditFooter,
    getBeaverFooterAppendPoint,
} from '../../../src/utils/noteEditFooter';
import { logger } from '../../../src/utils/logger';
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

/**
 * Locate one undo step's applied region in the CURRENT evolving HTML from its
 * stored contexts. Deletion seam (`undoNewHtml === ''`): before+after (S1),
 * else a unique before-end (S2), else after-start (S3). Non-deletion: the
 * applied fragment bracketed by its before/after windows. At replay the HTML
 * for each step equals that step's capture state, so the region is exact.
 */
function locateReplayRegion(
    html: string,
    undoNewHtml: string,
    before: string,
    after: string,
): { start: number; end: number } | null {
    if (undoNewHtml === '') {
        const seamIdx = html.indexOf(before + after);
        if (seamIdx !== -1) {
            const p = seamIdx + before.length;
            return { start: p, end: p };
        }
        if (before) {
            const bIdx = html.indexOf(before);
            if (bIdx !== -1 && html.indexOf(before, bIdx + 1) === -1) {
                const p = bIdx + before.length;
                return { start: p, end: p };
            }
        }
        if (after) {
            const aIdx = html.indexOf(after);
            if (aIdx !== -1) return { start: aIdx, end: aIdx };
        }
        return null;
    }
    const bracketed = html.indexOf(before + undoNewHtml + after);
    if (bracketed !== -1) {
        const s = bracketed + before.length;
        return { start: s, end: s + undoNewHtml.length };
    }
    const prefixed = html.indexOf(before + undoNewHtml);
    if (prefixed !== -1) {
        const s = prefixed + before.length;
        return { start: s, end: s + undoNewHtml.length };
    }
    const positions = findAllOccurrences(html, undoNewHtml);
    if (positions.length === 1) return { start: positions[0], end: positions[0] + undoNewHtml.length };
    return null;
}

/**
 * Faithful in-test batch-undo replay: records DESCENDING by index, and within a
 * str_replace_all record its occurrences DESCENDING by stored slot. Each step is
 * located in the evolving HTML via its stored contexts and its applied fragment
 * is spliced back to `undo_old_html`. Proves the captured anchors are internally
 * consistent: replaying them reconstructs the pre-edit HTML in the correct order.
 */
function replayBatchUndo(appliedHtml: string, drafts: BatchUndoDraft[]): string {
    let html = appliedHtml;
    const ordered = [...drafts].sort((a, b) => b.index - a.index);
    for (const draft of ordered) {
        if (draft.operation === 'rewrite') {
            html = draft.undo_old_html;
            continue;
        }
        const revert = (before: string, after: string) => {
            const region = locateReplayRegion(html, draft.undo_new_html, before, after);
            if (!region) throw new Error(`replay: step for edit ${draft.index} not locatable`);
            html = html.slice(0, region.start) + draft.undo_old_html + html.slice(region.end);
        };
        if (draft.undo_occurrence_contexts) {
            for (let slot = draft.undo_occurrence_contexts.length - 1; slot >= 0; slot--) {
                const ctx = draft.undo_occurrence_contexts[slot];
                revert(ctx.before, ctx.after);
            }
        } else {
            revert(draft.undo_before_context ?? '', draft.undo_after_context ?? '');
        }
    }
    return html;
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
        // Occurrence contexts are captured by reverse-replay simulation: the
        // higher-position occurrence (slot 1) replays first, so the lower
        // occurrence's after-context (slot 0) already reflects the higher one
        // reverted to 'foo' — not the applied 'BAR'.
        expect(undoDrafts[0].undo_occurrence_contexts![0]).toEqual({ before: 'x ', after: ' y foo z' });
        expect(undoDrafts[0].undo_occurrence_contexts![1]).toEqual({ before: 'x BAR y ', after: ' z' });
    });
});

// =============================================================================
// Replay-consistent undo anchors (reverse-replay simulation)
// =============================================================================
//
// Batch undo replays records in DESCENDING index order against an evolving
// document (within a str_replace_all record, occurrences DESCENDING by final
// position). Each undo step's before/after windows must reflect the document
// state it is located against at replay time: steps EARLIER in replay order
// already reverted, this step + LATER steps still applied.

describe('undo anchors reflect the evolving replay state', () => {
    it('a deletion with a HIGHER-index sibling after the seam captures the sibling\'s OLD text', () => {
        // edit 1 (higher index) replaces the paragraph after the deletion seam,
        // so it reverts BEFORE the deletion — the deletion's after-context must
        // quote the sibling's original text, not its applied replacement.
        const html = '<p>Remove this line.</p><p>Original sentence.</p>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<p>Remove this line.</p>', ''),
            spec(1, 'str_replace', '<p>Original sentence.</p>', '<p>Replaced sentence.</p>'),
        ]);
        const { undoDrafts } = applyResolvedEdits(html, resolved);
        const deletion = undoDrafts.find((d) => d.index === 0)!;
        expect(deletion.undo_after_context).toContain('Original sentence.');
        expect(deletion.undo_after_context).not.toContain('Replaced');
    });

    it('a deletion with a LOWER-index sibling after the seam captures the sibling\'s NEW text', () => {
        // The deletion (higher index) reverts FIRST, while the lower-index
        // sibling is still applied — the deletion's after-context may quote the
        // sibling's applied replacement.
        const html = '<p>Remove this.</p><p>Target para.</p>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<p>Target para.</p>', '<p>Changed para.</p>'),
            spec(1, 'str_replace', '<p>Remove this.</p>', ''),
        ]);
        const { undoDrafts } = applyResolvedEdits(html, resolved);
        const deletion = undoDrafts.find((d) => d.index === 1)!;
        expect(deletion.undo_after_context).toContain('Changed para.');
        expect(deletion.undo_after_context).not.toContain('Target');
    });

    it('two deletions near each other each reflect the other\'s replay state', () => {
        const html = '<p>First del.</p><p>Second del.</p><p>Keep.</p>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<p>First del.</p>', ''),
            spec(1, 'str_replace', '<p>Second del.</p>', ''),
        ]);
        const { undoDrafts } = applyResolvedEdits(html, resolved);
        const first = undoDrafts.find((d) => d.index === 0)!;
        const second = undoDrafts.find((d) => d.index === 1)!;
        // edit 1 reverts first (both deletions still applied) → its after-context
        // is the trailing kept content only.
        expect(second.undo_after_context).toContain('Keep.');
        expect(second.undo_after_context).not.toContain('Second del.');
        // edit 0 reverts second (edit 1 already reinserted) → its after-context
        // quotes edit 1's restored text.
        expect(first.undo_after_context).toContain('Second del.');
    });

    it('str_replace_all deletion over 3 CONTIGUOUS occurrences yields pairwise-distinct contexts', () => {
        const html = '<div><p>x</p><p>x</p><p>x</p></div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace_all', '<p>x</p>', ''),
        ]);
        const { undoDrafts } = applyResolvedEdits(html, resolved);
        const contexts = undoDrafts[0].undo_occurrence_contexts!;
        expect(contexts).toHaveLength(3);
        const keys = contexts.map((c) => `${c.before}||${c.after}`);
        // Distinct contexts are what makes contiguous seams individually
        // locatable when replayed one at a time.
        expect(new Set(keys).size).toBe(3);
    });

    it('reverse simulation reconstructs the pre-edit HTML for varied edit shapes', () => {
        const loggerMock = vi.mocked(logger);
        const cases: Array<{ html: string; specs: BatchEditSpec[] }> = [
            {
                html: 'the quick brown fox jumps over',
                specs: [
                    spec(0, 'str_replace', 'quick', 'slow'),
                    spec(1, 'str_replace', 'fox', 'cat'),
                ],
            },
            {
                html: '<p>drop me</p><p>keep me</p>',
                specs: [
                    spec(0, 'str_replace', '<p>drop me</p>', ''),
                    spec(1, 'insert_after', '<p>keep me</p>', '<p>added</p>'),
                ],
            },
            {
                html: '<div data-schema-version="9"><p>Alpha.</p></div>',
                specs: [
                    spec(0, 'str_replace', 'Alpha.', 'Beta.'),
                    spec(1, 'append', '', '<p>Appended.</p>'),
                ],
            },
            {
                html: 'a foo b foo c foo d',
                specs: [
                    spec(0, 'str_replace_all', 'foo', 'BAR'),
                    spec(1, 'str_replace', 'd', 'D'),
                ],
            },
        ];
        for (const { html, specs } of cases) {
            const resolved = resolveOrThrow(makeCtx(html), specs);
            loggerMock.mockClear();
            applyResolvedEdits(html, resolved);
            // The end-of-simulation mismatch warning is the only path that logs;
            // its absence asserts the reverse simulation rebuilt `strippedHtml`.
            expect(loggerMock).not.toHaveBeenCalled();
        }
    });
});

// =============================================================================
// Coincident final offsets (collapsed seams / abutting fragments)
// =============================================================================
//
// When two steps land at the SAME final offset the capture must still place each
// on the correct side of the boundary. Each simulated state equals
// apply(strippedHtml, still-applied subset), so equal-offset ordering is exact
// by construction and replaying the captured anchors reconstructs the original.

describe('coincident-offset undo anchors', () => {
    const loggerMock = vi.mocked(logger);

    it('shape (a): two adjacent deletions with index order INVERTED vs document order', () => {
        // Document order: LEFT block then RIGHT block (adjacent). Index order is
        // inverted — edit 0 targets the document-later span, edit 1 the earlier
        // one — so both deletion seams collapse to one final offset.
        const html = '<p>keep</p><p>LEFT block</p><p>RIGHT block</p><p>tail</p>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<p>RIGHT block</p>', ''),
            spec(1, 'str_replace', '<p>LEFT block</p>', ''),
        ]);
        loggerMock.mockClear();
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('<p>keep</p><p>tail</p>');
        // End-state equals the input: no mismatch warning.
        expect(loggerMock).not.toHaveBeenCalled();
        // Replaying the anchors reconstructs the ORIGINAL order (LEFT before RIGHT).
        expect(replayBatchUndo(newStrippedHtml, undoDrafts)).toBe(html);
    });

    it('shape (a) favorable: same two adjacent deletions with index order MATCHING document order', () => {
        const html = '<p>keep</p><p>LEFT block</p><p>RIGHT block</p><p>tail</p>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<p>LEFT block</p>', ''),
            spec(1, 'str_replace', '<p>RIGHT block</p>', ''),
        ]);
        loggerMock.mockClear();
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('<p>keep</p><p>tail</p>');
        expect(loggerMock).not.toHaveBeenCalled();
        expect(replayBatchUndo(newStrippedHtml, undoDrafts)).toBe(html);
    });

    it('shape (b): lower-index insert_after abutting a higher-index deletion of the following text', () => {
        // The inserted fragment lands immediately before the deletion seam (they
        // abut at a shared boundary). The deletion (higher index) reverts first.
        const html = '<p>intro</p><p>ANCHOR.</p><p>Delete me.</p><p>tail</p>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'insert_after', '<p>ANCHOR.</p>', '<p>Added.</p>'),
            spec(1, 'str_replace', '<p>Delete me.</p>', ''),
        ]);
        loggerMock.mockClear();
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('<p>intro</p><p>ANCHOR.</p><p>Added.</p><p>tail</p>');
        expect(loggerMock).not.toHaveBeenCalled();
        expect(replayBatchUndo(newStrippedHtml, undoDrafts)).toBe(html);
    });

    it('shape (b) favorable: higher-index insert_after abutting a lower-index deletion of the following text', () => {
        const html = '<p>intro</p><p>ANCHOR.</p><p>Delete me.</p><p>tail</p>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<p>Delete me.</p>', ''),
            spec(1, 'insert_after', '<p>ANCHOR.</p>', '<p>Added.</p>'),
        ]);
        loggerMock.mockClear();
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('<p>intro</p><p>ANCHOR.</p><p>Added.</p><p>tail</p>');
        expect(loggerMock).not.toHaveBeenCalled();
        expect(replayBatchUndo(newStrippedHtml, undoDrafts)).toBe(html);
    });

    it('shape (b) collapse: lower-index append whose fragment starts exactly at a higher-index end-deletion seam', () => {
        // The deleted block ends at the append point, so after deletion the
        // append fragment start and the deletion seam collapse to one offset.
        // The deletion (higher index) reverts first; its seam must be captured on
        // the LEFT of the appended fragment for the replay to reconstruct order.
        const html = '<div><p>keep</p><ul><li>a</li><li>b</li></ul></div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'append', '', '<p>appended</p>'),
            spec(1, 'str_replace', '<ul><li>a</li><li>b</li></ul>', ''),
        ]);
        loggerMock.mockClear();
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('<div><p>keep</p><p>appended</p></div>');
        expect(loggerMock).not.toHaveBeenCalled();
        expect(replayBatchUndo(newStrippedHtml, undoDrafts)).toBe(html);
    });

    it('shape (b) collapse favorable: higher-index append with a lower-index end-deletion', () => {
        const html = '<div><p>keep</p><ul><li>a</li><li>b</li></ul></div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<ul><li>a</li><li>b</li></ul>', ''),
            spec(1, 'append', '', '<p>appended</p>'),
        ]);
        loggerMock.mockClear();
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        expect(newStrippedHtml).toBe('<div><p>keep</p><p>appended</p></div>');
        expect(loggerMock).not.toHaveBeenCalled();
        expect(replayBatchUndo(newStrippedHtml, undoDrafts)).toBe(html);
    });

    it('reconstructs the input for a deterministic battery of adjacent/coincident/contiguous shapes', () => {
        // One base document; a fixed set of hand-built non-overlapping edit
        // combinations covering deletions, inserts, replaces and replace_all at
        // adjacent, collapsed and contiguous boundaries. Every combination's
        // reverse simulation must rebuild the input (no mismatch warning) and its
        // anchors must replay back to the original.
        const BASE = '<div data-schema-version="9">'
            + '<h2>Heading</h2>'
            + '<p>alpha one</p>'
            + '<p>beta two</p>'
            + '<p>gamma three</p>'
            + '<p>delta four</p>'
            + '<ul><li>x</li><li>x</li><li>x</li></ul>'
            + '</div>';

        const combos: BatchEditSpec[][] = [
            // 1. adjacent deletions, inverted index order
            [
                spec(0, 'str_replace', '<p>gamma three</p>', ''),
                spec(1, 'str_replace', '<p>beta two</p>', ''),
            ],
            // 2. adjacent deletions, favorable index order
            [
                spec(0, 'str_replace', '<p>beta two</p>', ''),
                spec(1, 'str_replace', '<p>gamma three</p>', ''),
            ],
            // 3. insert_after abutting a following deletion
            [
                spec(0, 'insert_after', '<p>alpha one</p>', '<p>added</p>'),
                spec(1, 'str_replace', '<p>beta two</p>', ''),
            ],
            // 4. insert_before collapsing with an immediately-preceding deletion
            [
                spec(0, 'insert_before', '<p>gamma three</p>', '<p>added</p>'),
                spec(1, 'str_replace', '<p>beta two</p>', ''),
            ],
            // 5. append collapsing with an end-deletion at the append point
            [
                spec(0, 'append', '', '<p>appended</p>'),
                spec(1, 'str_replace', '<ul><li>x</li><li>x</li><li>x</li></ul>', ''),
            ],
            // 6. str_replace_all deletion over 3 contiguous occurrences
            [
                spec(0, 'str_replace_all', '<li>x</li>', ''),
            ],
            // 7. str_replace_all non-deletion over 3 contiguous occurrences
            [
                spec(0, 'str_replace_all', '<li>x</li>', '<li>y</li>'),
            ],
            // 8. replace + insert + append, well separated
            [
                spec(0, 'str_replace', 'alpha one', 'ALPHA'),
                spec(1, 'insert_after', '<p>delta four</p>', '<p>ins</p>'),
                spec(2, 'append', '', 'END'),
            ],
            // 9. replace adjacent to a deletion
            [
                spec(0, 'str_replace', '<p>alpha one</p>', '<p>ALPHA</p>'),
                spec(1, 'str_replace', '<p>beta two</p>', ''),
            ],
            // 10. replace_all plus an unrelated replace elsewhere
            [
                spec(0, 'str_replace_all', '<li>x</li>', '<li>z</li>'),
                spec(1, 'str_replace', '<h2>Heading</h2>', '<h2>Head</h2>'),
            ],
            // 11. two inserts around a deletion
            [
                spec(0, 'insert_after', '<p>alpha one</p>', '<p>a1</p>'),
                spec(1, 'insert_before', '<p>delta four</p>', '<p>d1</p>'),
                spec(2, 'str_replace', '<p>gamma three</p>', ''),
            ],
        ];

        for (const specs of combos) {
            const resolved = resolveOrThrow(makeCtx(BASE), specs);
            // Every combination must be genuinely non-overlapping.
            expect(detectOverlaps(resolved)).toEqual([]);
            loggerMock.mockClear();
            const { newStrippedHtml, undoDrafts } = applyResolvedEdits(BASE, resolved);
            // End-state === input: the mismatch warning is the only log path.
            expect(loggerMock).not.toHaveBeenCalled();
            // Anchors replay back to the pre-edit HTML.
            expect(replayBatchUndo(newStrippedHtml, undoDrafts)).toBe(BASE);
        }
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

    it('appliedHtml identical to the final html skips the scan but matches the default path byte-for-byte', () => {
        const html = '<div><p>keep</p><p>remove</p></div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<p>remove</p>', ''),
        ]);
        const { newStrippedHtml, undoDrafts: draftsWithoutParam } = applyResolvedEdits(html, resolved);
        const { undoDrafts: draftsWithParam } = applyResolvedEdits(html, resolved);

        captureUndoContexts(newStrippedHtml, draftsWithoutParam);
        captureUndoContexts(newStrippedHtml, draftsWithParam, newStrippedHtml);

        expect(draftsWithParam).toEqual(draftsWithoutParam);
    });

    it('still refreshes when appliedHtml is provided but differs from the final html', () => {
        const html = '<div><p>keep</p><p>remove</p></div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<p>remove</p>', ''),
        ]);
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        const finalStripped = addOrUpdateEditFooter(newStrippedHtml, 'thread-1');

        captureUndoContexts(finalStripped, undoDrafts, newStrippedHtml);

        expect(undoDrafts[0].undo_before_context).toBe('<div><p>keep</p>');
        expect(undoDrafts[0].undo_after_context).toContain('Edited by Beaver');
    });

    it('keeps a deletion seam replay-consistent against a footered final HTML', () => {
        // edit 1 (higher index) reverts before the deletion, so after the
        // search-based refresh the deletion's after-context must still quote the
        // sibling's ORIGINAL text — even though the final HTML shows the applied
        // replacement plus an appended footer.
        const html = '<div><p>Remove this line.</p><p>Original sentence.</p></div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<p>Remove this line.</p>', ''),
            spec(1, 'str_replace', '<p>Original sentence.</p>', '<p>Replaced sentence.</p>'),
        ]);
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        const finalStripped = addOrUpdateEditFooter(newStrippedHtml, 'thread-1');

        captureUndoContexts(finalStripped, undoDrafts);

        const deletion = undoDrafts.find((d) => d.index === 0)!;
        expect(deletion.undo_after_context).toContain('Original sentence.');
        expect(deletion.undo_after_context).not.toContain('Replaced');
    });

    it('keeps two collapsed deletion seams (inverted index) replay-consistent against a footered final HTML', () => {
        // The search-based refresh carries no offset arithmetic, so it stays
        // consistent with the apply-time capture for collapsed seams: replaying
        // the refreshed anchors reconstructs the original order plus the footer.
        const html = '<div><p>keep</p><p>LEFT block</p><p>RIGHT block</p><p>tail</p></div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace', '<p>RIGHT block</p>', ''),
            spec(1, 'str_replace', '<p>LEFT block</p>', ''),
        ]);
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        const finalStripped = addOrUpdateEditFooter(newStrippedHtml, 'thread-1');

        captureUndoContexts(finalStripped, undoDrafts);

        expect(replayBatchUndo(finalStripped, undoDrafts)).toBe(
            addOrUpdateEditFooter(html, 'thread-1'),
        );
    });

    it('refreshes a non-deletion str_replace_all with evolving occurrence contexts against a footered final HTML', () => {
        const html = '<div><p>foo one</p><p>foo two</p></div>';
        const resolved = resolveOrThrow(makeCtx(html), [
            spec(0, 'str_replace_all', 'foo', 'BAR'),
        ]);
        const { newStrippedHtml, undoDrafts } = applyResolvedEdits(html, resolved);
        const finalStripped = addOrUpdateEditFooter(newStrippedHtml, 'thread-1');

        captureUndoContexts(finalStripped, undoDrafts);

        const contexts = undoDrafts[0].undo_occurrence_contexts!;
        expect(contexts).toHaveLength(2);
        // The higher-position occurrence (slot 1) refreshes first; the lower one
        // (slot 0) is then located after slot 1 was reverted to 'foo', so its
        // after-context quotes 'foo two', not the applied 'BAR two'.
        expect(contexts[0].after).toContain('foo two');
        expect(contexts[0].after).not.toContain('BAR two');
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

/**
 * Pure resolution / overlap / apply engine for `edit_note_batch`.
 *
 * A batch carries an ordered `edits[]`, ALL resolved against ONE note
 * snapshot, checked for range overlaps, and applied in ONE save — all or
 * nothing. This module is the single source of truth for that correctness
 * core, shared by the action handlers and (later) the client-side re-apply.
 *
 * The three phases are deliberately separable:
 *   1. `resolveBatchEdits`   simplified/raw strings → concrete char ranges +
 *                            expanded HTML + undo fragments (or per-edit failures)
 *   2. `detectOverlaps`      pure range-intersection check across resolved edits
 *   3. `applyResolvedEdits`  descending-offset splice into one new HTML string
 *   4. `captureUndoContexts` refresh undo anchors against the final saved HTML
 *
 * Design constraints (do NOT regress):
 *   - Pure: no `Zotero.*`, no `store`/atoms, no React value imports. Every
 *     Zotero-touching resolution input (metadata, pageLabels, externalRefContext,
 *     resolvedLocatorPages) is pre-resolved by the caller and passed in, so
 *     expansion stays synchronous — the same contract `editNoteMatcher` relies on.
 *   - RANGES, not strings, are authoritative. Overlap is decided on char ranges,
 *     never string equality, so a `str_replace_all` occurrence that lands on a
 *     sibling edit's anchor is caught as a genuine conflict.
 */

import type { EditNoteOperation } from '../../react/types/agentActions/editNote';
import type { SimplificationMetadata } from './noteHtmlSimplifier';
import type { PageLabelsByAttachmentId } from '../../react/atoms/citations';
import type { CandidateSnippet } from './editNoteHints';
import {
    expandBase,
    findBestMatch,
    findMarkdownRenderMatch,
    type MatchInput,
    type MatchResult,
} from './editNoteMatcher';
import {
    expandToRawHtml,
    type ExternalRefContext,
    type ResolvedLocatorPages,
} from './noteCitationExpand';
import {
    locateEditTarget,
    resolveEditTargetAtRuntime,
    buildZeroMatchHint,
    buildExecutionZeroMatchHint,
} from './editNotePositionLookup';
import {
    detectPartialSimplifiedTag,
    buildPartialSimplifiedTagMessage,
} from './editNoteValidation';
import { logger } from './logger';

// =============================================================================
// Public types
// =============================================================================

/** One edit to resolve, in the batch's requested order. */
export interface BatchEditSpec {
    index: number;
    client_item_id?: string;
    operation: EditNoteOperation;
    /** Enriched simplified-space old_string (empty for rewrite/append). */
    oldString: string;
    /** Simplified-space new_string. */
    newString: string;
    /** Validator-supplied raw context anchors used to disambiguate multi-matches. */
    targetBeforeContext?: string;
    targetAfterContext?: string;
    /** Handler-rendered Markdown fallback fields (populated async before resolution). */
    renderedOldSimplified?: string;
    renderedNewSimplified?: string;
}

/** Inputs shared by every edit in one resolution pass. */
export interface ResolveBatchContext {
    /** `stripDataCitationItems(normalizeNoteHtml(rawHtml))` — the match/apply haystack. */
    strippedHtml: string;
    /** Simplified-space rendering of the note (what the model sees). */
    simplified: string;
    metadata: SimplificationMetadata;
    externalRefContext: ExternalRefContext;
    pageLabels: PageLabelsByAttachmentId;
    resolvedLocatorPages?: ResolvedLocatorPages;
    /** Insertion offset for `append` edits (`getBeaverFooterAppendPoint(strippedHtml)`). */
    appendPoint: number;
    /**
     * 'validate' uses `locateEditTarget` and captures context anchors for
     * `normalized_action_data`; 'execute' re-uses stored anchors (normalized
     * through the strategy's `normalizeAnchor`) via `resolveEditTargetAtRuntime`.
     */
    mode: 'validate' | 'execute';
}

export interface ResolvedRange {
    start: number;
    end: number;
}

/**
 * One splice that applies part of an edit. `str_replace_all` yields one per
 * occurrence; every other operation yields exactly one.
 */
export interface BatchApplyOp {
    /** Splice bounds in the pre-edit stripped HTML (`[start, end)` is removed). */
    start: number;
    end: number;
    /** Text inserted in place of `[start, end)`. */
    replacement: string;
    /** Offset within `replacement` where the undo fragment begins. */
    fragmentOffset: number;
    /** Length of the undo fragment within `replacement`. */
    fragmentLength: number;
}

export interface ResolvedBatchEdit {
    index: number;
    client_item_id?: string;
    operation: EditNoteOperation;
    /** Raw-HTML-space match needle. */
    expandedOld: string;
    /** Raw-HTML-space replacement (merged for inserts). */
    expandedNew: string;
    /**
     * Char ranges in `strippedHtml` this edit touches — the authoritative input
     * to overlap detection. str_replace: 1; str_replace_all: all occurrences;
     * insert_*: the (preserved-but-touched) anchor range; append: a zero-width
     * range at the append point; rewrite: the whole document.
     */
    ranges: ResolvedRange[];
    /** Splice operations, consumed by `applyResolvedEdits`. */
    applyOps: BatchApplyOp[];
    matchCount: number;
    /** Occurrences this edit replaces (str_replace_all = its occurrence count, else 1). */
    occurrencesReplaced: number;
    /** Matcher-normalized simplified-space old_string, for `normalized_action_data`. */
    normalizedOldString?: string;
    /** Matcher-normalized simplified-space new_string (merged for inserts). */
    normalizedNewString?: string;
    /** Context anchors captured during validation, for `normalized_action_data`. */
    targetBeforeContext?: string;
    targetAfterContext?: string;
    /** Raw HTML fragment removed by the edit (see `EditNoteBatchUndoRecord.undo_old_html`). */
    undoOldHtml: string;
    /** Raw HTML fragment inserted by the edit (injected-only for inserts/append). */
    undoNewHtml: string;
    /** Matcher strategy that produced the match (diagnostic; absent for rewrite/append). */
    strategy?: string;
    warnings: string[];
}

export interface BatchEditFailure {
    index: number;
    error: string;
    errorCode: string;
    candidates?: CandidateSnippet[];
}

export interface BatchOverlap {
    firstIndex: number;
    secondIndex: number;
}

/** Per-edit undo record, filled during apply and refreshed by `captureUndoContexts`. */
export interface BatchUndoDraft {
    index: number;
    client_item_id?: string;
    operation: EditNoteOperation;
    undo_old_html: string;
    undo_new_html: string;
    undo_before_context?: string;
    undo_after_context?: string;
    undo_occurrence_contexts?: Array<{ before: string; after: string }>;
}

const UNDO_CONTEXT_LENGTH = 200;

// =============================================================================
// Small pure helpers (self-contained so the core never imports editNote.ts)
// =============================================================================

/**
 * Return the start offsets of every NON-OVERLAPPING occurrence of `needle` in
 * `haystack`, advancing by `needle.length` after each hit — matching the
 * semantics of `String.prototype.split(needle).join(...)`. Empty needle → [].
 */
export function findAllOccurrences(haystack: string, needle: string): number[] {
    if (!needle) return [];
    const positions: number[] = [];
    let from = 0;
    for (;;) {
        const idx = haystack.indexOf(needle, from);
        if (idx === -1) break;
        positions.push(idx);
        from = idx + needle.length;
    }
    return positions;
}

/**
 * Merge old_string and new_string for insert operations so the result can be
 * treated as a regular str_replace. No-op for non-insert operations.
 */
export function mergeInsertNewString(
    operation: EditNoteOperation,
    oldString: string,
    newString: string,
): string {
    if (operation === 'insert_after') {
        return newString.startsWith(oldString) ? newString : oldString + newString;
    }
    if (operation === 'insert_before') {
        return newString.endsWith(oldString) ? newString : newString + oldString;
    }
    return newString;
}

export function buildAmbiguousMatchError(matchCount: number, operation?: EditNoteOperation): string {
    // str_replace_all is only a valid alternative for replacement edits; for
    // inserts the anchor itself must be made unique.
    if (operation === 'insert_after' || operation === 'insert_before') {
        return `The insertion anchor was found ${matchCount} times in the note. `
            + 'Include more surrounding context in old_string so the anchor matches exactly once.';
    }
    return `The string to replace was found ${matchCount} times in the note. `
        + 'Use operation str_replace_all to replace all occurrences, or include more context to make the match unique.';
}

/** Head-tail truncate a snippet for a single-line warning string. */
export function truncateForWarning(s: string, headTail = 30): string {
    const escaped = s.replace(/\n/g, '\\n');
    const threshold = headTail * 2 + 5;
    if (escaped.length <= threshold) return escaped;
    return `${escaped.slice(0, headTail)}…${escaped.slice(-headTail)}`;
}

/**
 * When the model pre-copied old_string into the relevant end of new_string for
 * an insert, `mergeInsertNewString` silently dedupes. Emit a nudge. Returns
 * null when no dedup applies.
 */
export function buildInsertDedupWarning(
    operation: EditNoteOperation,
    oldString: string,
    newString: string,
): string | null {
    if (!oldString) return null;
    const snippet = truncateForWarning(oldString);
    if (operation === 'insert_after' && newString.startsWith(oldString)) {
        return (
            'For operation="insert_after", new_string should contain ONLY the '
            + 'content to insert — old_string is preserved automatically. '
            + `new_string started with a copy of old_string ("${snippet}"). `
            + 'Only the trailing content was inserted after that anchor (no '
            + 'duplication). To duplicate content, use operation="str_replace" '
            + 'with new_string set to old_string followed by your inserted '
            + 'content (or the full final shape) instead.'
        );
    }
    if (operation === 'insert_before' && newString.endsWith(oldString)) {
        return (
            'For operation="insert_before", new_string should contain ONLY the '
            + 'content to insert — old_string is preserved automatically. '
            + `new_string ended with a copy of old_string ("${snippet}"). `
            + 'Only the leading content was inserted before that anchor (no '
            + 'duplication). To duplicate content, use operation="str_replace" '
            + 'with new_string set to your inserted content followed by '
            + 'old_string (or the full final shape) instead.'
        );
    }
    return null;
}

// =============================================================================
// Phase 1: resolution
// =============================================================================

function failure(
    index: number,
    error: string,
    errorCode: string,
    candidates?: CandidateSnippet[],
): BatchEditFailure {
    return candidates && candidates.length > 0
        ? { index, error, errorCode, candidates }
        : { index, error, errorCode };
}

/** Build a MatchInput for one str_replace-family edit. */
function buildMatchInput(ctx: ResolveBatchContext, spec: BatchEditSpec): MatchInput {
    return {
        oldString: spec.oldString ?? '',
        newString: spec.newString,
        operation: spec.operation,
        metadata: ctx.metadata,
        simplified: ctx.simplified,
        strippedHtml: ctx.strippedHtml,
        externalRefContext: ctx.externalRefContext,
        pageLabels: ctx.pageLabels,
        resolvedLocatorPages: ctx.resolvedLocatorPages,
        renderedOldSimplified: spec.renderedOldSimplified,
        renderedNewSimplified: spec.renderedNewSimplified,
    };
}

/**
 * Run the ranked matcher pipeline (`expandBase` → `findBestMatch`, with the
 * handler-rendered Markdown fallback threaded in via `renderedOldSimplified`).
 * Returns the match or a per-edit failure with a zero-match hint.
 */
function matchEdit(
    ctx: ResolveBatchContext,
    spec: BatchEditSpec,
): MatchResult | BatchEditFailure {
    const matchInput = buildMatchInput(ctx, spec);

    let match: MatchResult | null = null;
    try {
        const base = expandBase(matchInput);
        match = findBestMatch(matchInput, base);
    } catch (e: any) {
        // Base old/new expansion threw. The Markdown-render fallback does not
        // need the base, so try it before surfacing expansion_failed.
        match = findMarkdownRenderMatch(matchInput);
        if (!match) {
            return failure(spec.index, e?.message || String(e), 'expansion_failed');
        }
    }

    if (!match) {
        const partial = detectPartialSimplifiedTag(spec.oldString ?? '');
        if (partial) {
            return failure(spec.index, buildPartialSimplifiedTagMessage(partial), 'partial_simplified_tag');
        }
        const hint = ctx.mode === 'validate'
            ? buildZeroMatchHint(ctx.simplified, spec.oldString ?? '')
            : buildExecutionZeroMatchHint(ctx.simplified, spec.oldString ?? '');
        return failure(spec.index, hint.message, 'old_string_not_found', hint.candidates);
    }
    return match;
}

interface SingleTargetLocation {
    pos: number;
    beforeContext?: string;
    afterContext?: string;
}

/**
 * Resolve the single raw position for a str_replace / insert_after /
 * insert_before edit, handling multi-match disambiguation exactly as the
 * single-edit validator/executor do. Returns `null` when the target is
 * genuinely ambiguous (caller emits `ambiguous_match`).
 */
function resolveSingleTarget(
    ctx: ResolveBatchContext,
    spec: BatchEditSpec,
    match: MatchResult,
): SingleTargetLocation | null {
    const { strippedHtml, simplified, metadata } = ctx;
    const expandedOld = match.expandedOld;

    if (match.matchCount === 1) {
        return { pos: strippedHtml.indexOf(expandedOld) };
    }

    // Multi-match: the strategy's own precise hint wins first.
    if (match.rawPositionHint !== undefined) {
        const pos = match.rawPositionHint;
        if (ctx.mode === 'validate') {
            return {
                pos,
                beforeContext: strippedHtml.substring(Math.max(0, pos - UNDO_CONTEXT_LENGTH), pos),
                afterContext: strippedHtml.substring(
                    pos + expandedOld.length,
                    pos + expandedOld.length + UNDO_CONTEXT_LENGTH,
                ),
            };
        }
        return { pos };
    }

    if (ctx.mode === 'validate') {
        const location = locateEditTarget({
            strippedHtml,
            simplified,
            oldString: match.oldString,
            expandedOld,
            metadata,
        });
        if (location.kind === 'position') {
            return { pos: location.rawPosition };
        }
        if (location.kind === 'context') {
            // Derive a concrete position from the just-captured anchors so the
            // edit gets a real range for overlap detection at validate time.
            const { rawPosition } = resolveEditTargetAtRuntime({
                strippedHtml,
                simplified,
                oldString: match.oldString,
                expandedOld,
                metadata,
                targetBeforeContext: location.beforeContext,
                targetAfterContext: location.afterContext,
            });
            if (rawPosition === -1) return null;
            return {
                pos: rawPosition,
                beforeContext: location.beforeContext,
                afterContext: location.afterContext,
            };
        }
        return null; // ambiguous
    }

    // Execute: re-use the stored anchors, normalized the same way the matcher
    // transformed the haystack needle (entity decode/encode, NFKC, quote fold).
    const beforeCtx = spec.targetBeforeContext != null
        ? match.normalizeAnchor(spec.targetBeforeContext)
        : undefined;
    const afterCtx = spec.targetAfterContext != null
        ? match.normalizeAnchor(spec.targetAfterContext)
        : undefined;
    const { rawPosition } = resolveEditTargetAtRuntime({
        strippedHtml,
        simplified,
        oldString: spec.oldString ?? '',
        expandedOld,
        metadata,
        targetBeforeContext: beforeCtx,
        targetAfterContext: afterCtx,
    });
    if (rawPosition === -1) return null;
    return { pos: rawPosition };
}

/**
 * For an insert operation, split the (possibly merged) `expandedNew` into the
 * applied replacement (anchor preserved) and the injected-only fragment used
 * for undo. Handles both the validate-time (bare payload) and execute-time
 * (pre-merged) shapes of `expandedNew`.
 */
function splitInsert(
    operation: 'insert_after' | 'insert_before',
    expandedOld: string,
    expandedNew: string,
): { replacement: string; injected: string; fragmentOffset: number } {
    if (operation === 'insert_after') {
        if (expandedNew.startsWith(expandedOld)) {
            const injected = expandedNew.substring(expandedOld.length);
            return { replacement: expandedNew, injected, fragmentOffset: expandedOld.length };
        }
        return { replacement: expandedOld + expandedNew, injected: expandedNew, fragmentOffset: expandedOld.length };
    }
    // insert_before
    if (expandedNew.endsWith(expandedOld)) {
        const injected = expandedNew.substring(0, expandedNew.length - expandedOld.length);
        return { replacement: expandedNew, injected, fragmentOffset: 0 };
    }
    return { replacement: expandedNew + expandedOld, injected: expandedNew, fragmentOffset: 0 };
}

function resolveOne(
    ctx: ResolveBatchContext,
    spec: BatchEditSpec,
): ResolvedBatchEdit | BatchEditFailure {
    const { index, client_item_id, operation } = spec;

    // ── rewrite: whole-document replacement (backend guarantees sole-edit) ──
    if (operation === 'rewrite') {
        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(
                spec.newString, ctx.metadata, 'new',
                ctx.externalRefContext, ctx.pageLabels, ctx.resolvedLocatorPages,
            );
        } catch (e: any) {
            return failure(index, e?.message || String(e), 'expansion_failed');
        }
        const wholeLen = ctx.strippedHtml.length;
        return {
            index, client_item_id, operation,
            expandedOld: ctx.strippedHtml,
            expandedNew,
            ranges: [{ start: 0, end: wholeLen }],
            applyOps: [{ start: 0, end: wholeLen, replacement: expandedNew, fragmentOffset: 0, fragmentLength: expandedNew.length }],
            matchCount: 1,
            occurrencesReplaced: 1,
            undoOldHtml: ctx.strippedHtml,
            undoNewHtml: expandedNew,
            warnings: [],
        };
    }

    // ── append: insert at the footer append point (no old_string match) ──
    if (operation === 'append') {
        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(
                spec.newString, ctx.metadata, 'new',
                ctx.externalRefContext, ctx.pageLabels, ctx.resolvedLocatorPages,
            );
        } catch (e: any) {
            return failure(index, e?.message || String(e), 'expansion_failed');
        }
        const at = ctx.appendPoint;
        return {
            index, client_item_id, operation,
            expandedOld: '',
            expandedNew,
            // Zero-width range at the append point: adjacency and sibling
            // appends stay legal (strict intersection test), but a sibling
            // range strictly containing the append point is rejected by the
            // overlap gate instead of corrupting the descending splice.
            ranges: [{ start: at, end: at }],
            applyOps: [{ start: at, end: at, replacement: expandedNew, fragmentOffset: 0, fragmentLength: expandedNew.length }],
            matchCount: 1,
            occurrencesReplaced: 1,
            undoOldHtml: '',
            undoNewHtml: expandedNew,
            warnings: [],
        };
    }

    // ── str_replace family (str_replace, str_replace_all, insert_*) ──
    const matched = matchEdit(ctx, spec);
    if ('errorCode' in matched) return matched;
    const match = matched;

    const expandedOld = match.expandedOld;
    const expandedNew = match.expandedNew;
    const matchCount = match.matchCount;
    const warnings: string[] = [];

    const isInsert = operation === 'insert_after' || operation === 'insert_before';

    if (operation === 'str_replace_all') {
        const positions = findAllOccurrences(ctx.strippedHtml, expandedOld);
        if (positions.length === 0) {
            const hint = ctx.mode === 'validate'
                ? buildZeroMatchHint(ctx.simplified, spec.oldString ?? '')
                : buildExecutionZeroMatchHint(ctx.simplified, spec.oldString ?? '');
            return failure(index, hint.message, 'old_string_not_found', hint.candidates);
        }
        const ranges = positions.map((p) => ({ start: p, end: p + expandedOld.length }));
        const applyOps = positions.map((p): BatchApplyOp => ({
            start: p,
            end: p + expandedOld.length,
            replacement: expandedNew,
            fragmentOffset: 0,
            fragmentLength: expandedNew.length,
        }));
        return {
            index, client_item_id, operation,
            expandedOld, expandedNew,
            ranges, applyOps,
            matchCount,
            occurrencesReplaced: positions.length,
            normalizedOldString: match.oldString,
            normalizedNewString: match.newString,
            undoOldHtml: expandedOld,
            undoNewHtml: expandedNew,
            strategy: match.strategy,
            warnings,
        };
    }

    // Single-target ops.
    const location = resolveSingleTarget(ctx, spec, match);
    if (location === null) {
        return failure(index, buildAmbiguousMatchError(matchCount, operation), 'ambiguous_match');
    }
    const pos = location.pos;
    if (pos === -1) {
        // Defensive: matchCount claimed a hit but the exact needle vanished.
        const hint = ctx.mode === 'validate'
            ? buildZeroMatchHint(ctx.simplified, spec.oldString ?? '')
            : buildExecutionZeroMatchHint(ctx.simplified, spec.oldString ?? '');
        return failure(index, hint.message, 'old_string_not_found', hint.candidates);
    }

    let replacement: string;
    let fragmentOffset: number;
    let fragmentLength: number;
    let undoOldHtml: string;
    let undoNewHtml: string;
    let normalizedNewString: string | undefined;

    if (isInsert) {
        const split = splitInsert(operation, expandedOld, expandedNew);
        replacement = split.replacement;
        fragmentOffset = split.fragmentOffset;
        fragmentLength = split.injected.length;
        undoOldHtml = '';
        undoNewHtml = split.injected;
        normalizedNewString = mergeInsertNewString(operation, match.oldString, match.newString);
        const dedup = buildInsertDedupWarning(operation, match.oldString, match.newString);
        if (dedup) warnings.push(dedup);
    } else {
        replacement = expandedNew;
        fragmentOffset = 0;
        fragmentLength = expandedNew.length;
        undoOldHtml = expandedOld;
        undoNewHtml = expandedNew;
        normalizedNewString = match.newString;
    }

    const ranges = [{ start: pos, end: pos + expandedOld.length }];
    const applyOps: BatchApplyOp[] = [{
        start: pos,
        end: pos + expandedOld.length,
        replacement,
        fragmentOffset,
        fragmentLength,
    }];

    return {
        index, client_item_id, operation,
        expandedOld, expandedNew,
        ranges, applyOps,
        matchCount,
        occurrencesReplaced: 1,
        normalizedOldString: match.oldString,
        normalizedNewString,
        targetBeforeContext: location.beforeContext,
        targetAfterContext: location.afterContext,
        undoOldHtml,
        undoNewHtml,
        strategy: match.strategy,
        warnings,
    };
}

/**
 * Resolve every edit against ONE note snapshot. Never short-circuits: edits
 * that fail are collected as `failures` (fail-closed) so the caller can report
 * per-edit diagnostics for the whole batch at once.
 */
export function resolveBatchEdits(
    ctx: ResolveBatchContext,
    edits: BatchEditSpec[],
): { resolved: ResolvedBatchEdit[]; failures: BatchEditFailure[] } {
    const resolved: ResolvedBatchEdit[] = [];
    const failures: BatchEditFailure[] = [];
    for (const spec of edits) {
        const result = resolveOne(ctx, spec);
        if ('errorCode' in result) failures.push(result);
        else resolved.push(result);
    }
    return { resolved, failures };
}

// =============================================================================
// Phase 2: overlap detection
// =============================================================================

/** True when `[a.start, a.end)` and `[b.start, b.end)` genuinely intersect.
 *  Adjacency (`a.end === b.start`) is legal — editing consecutive spans. */
function rangesIntersect(a: ResolvedRange, b: ResolvedRange): boolean {
    return a.start < b.end && b.start < a.end;
}

/**
 * Report every pair of resolved edits whose ranges truly intersect. Two inserts
 * resolving to the same anchor produce identical (non-empty) ranges and are
 * therefore reported. Append edits carry a zero-width range at the append
 * point: they never conflict with adjacent edits or other appends, but a
 * sibling range strictly containing the append point is a genuine conflict.
 */
export function detectOverlaps(resolved: ResolvedBatchEdit[]): BatchOverlap[] {
    const overlaps: BatchOverlap[] = [];
    for (let i = 0; i < resolved.length; i++) {
        for (let j = i + 1; j < resolved.length; j++) {
            const a = resolved[i];
            const b = resolved[j];
            let conflict = false;
            for (const ra of a.ranges) {
                for (const rb of b.ranges) {
                    if (rangesIntersect(ra, rb)) { conflict = true; break; }
                }
                if (conflict) break;
            }
            if (conflict) {
                const lo = Math.min(a.index, b.index);
                const hi = Math.max(a.index, b.index);
                overlaps.push({ firstIndex: lo, secondIndex: hi });
            }
        }
    }
    return overlaps;
}

// =============================================================================
// Phase 3: application
// =============================================================================

interface FlatOp {
    editIndex: number;
    start: number;
    end: number;
    replacement: string;
    fragmentOffset: number;
    fragmentLength: number;
    /** Filled during position computation. */
    finalStart: number;
}

/** One reverse-replay step: a single applied fragment to un-apply in the simulation. */
interface UndoStep {
    editIndex: number;
    /** Pre-edit op start; drives the subset delta walk and orders collapsed occurrences. */
    start: number;
    /** Pre-edit op end. */
    end: number;
    /** Length of the applied replacement text (for the subset delta walk). */
    replacementLength: number;
    /** Offset of the undo fragment within the applied replacement. */
    fragmentOffset: number;
    /** Applied fragment length (chars of inserted text; 0 for a deletion seam). */
    fragLength: number;
    /** Fragment start in the fully-applied `html`; the replay-order sort key. */
    fragStart: number;
    /** Text spliced back in when this step reverts (empty for insert/append undo). */
    undoOldHtml: string;
    /** Draft that receives this step's sliced windows. */
    draft: BatchUndoDraft;
    /** Ascending occurrence slot for str_replace_all, or -1 for a single-fragment edit. */
    slot: number;
    /** True once the replay loop has reverted this step; later scans skip it. */
    reverted: boolean;
    /** Scratch: this fragment's start within the current still-applied subset. */
    subsetFinalStart: number;
}

/**
 * Apply all resolved edits to `strippedHtml` in ONE pass and produce per-edit
 * undo drafts with replay-consistent context anchors.
 *
 * Splices run in DESCENDING start offset so earlier offsets stay valid;
 * same-position ties break by DESCENDING edit index so same-position insertions
 * land in ascending request order in the final text. Callers MUST reject
 * overlapping edits (via `detectOverlaps`) before calling this — apply assumes
 * non-intersecting ranges.
 *
 * Undo anchors are captured by a reverse-replay simulation. Batch undo replays
 * records in DESCENDING index order against an evolving document, and within a
 * str_replace_all record its occurrences in DESCENDING final-position order
 * (see `react/utils/editNoteActions.ts`). Each step's 200-char before/after
 * windows must therefore be sliced from the document state that step is located
 * against at replay time: every step EARLIER in replay order already reverted,
 * this step and every LATER step still applied. That state equals
 * `apply(strippedHtml, subset)` for the still-applied subset (this step plus
 * every later step), so each step's fragment position is recomputed by
 * re-running the apply-side delta walk — the same ascending (start, index) walk
 * apply itself uses — restricted to that subset, rather than by shifting offsets
 * incrementally. Because every simulated state IS an apply output, equal-offset
 * ordering (collapsed deletion seams, a fragment abutting a seam) is exact by
 * construction, and reverting all steps reconstructs the pre-edit HTML.
 * Occurrence contexts are stored in ASCENDING final-position order (replay
 * reverses them).
 */
export function applyResolvedEdits(
    strippedHtml: string,
    resolved: ResolvedBatchEdit[],
): { newStrippedHtml: string; undoDrafts: BatchUndoDraft[] } {
    const flat: FlatOp[] = [];
    for (const edit of resolved) {
        for (const op of edit.applyOps) {
            flat.push({
                editIndex: edit.index,
                start: op.start,
                end: op.end,
                replacement: op.replacement,
                fragmentOffset: op.fragmentOffset,
                fragmentLength: op.fragmentLength,
                finalStart: 0,
            });
        }
    }

    // Apply the splices (descending start, then descending index for ties).
    const descOps = [...flat].sort((a, b) => b.start - a.start || b.editIndex - a.editIndex);
    let html = strippedHtml;
    for (const op of descOps) {
        html = html.slice(0, op.start) + op.replacement + html.slice(op.end);
    }

    // Compute each op's final start offset in `html`. Walking ascending
    // (start, index) and accumulating the length delta of every earlier op
    // gives the rightward shift applied by all splices to its left. This
    // matches the descending apply above, including same-position ties.
    const ascOps = [...flat].sort((a, b) => a.start - b.start || a.editIndex - b.editIndex);
    let delta = 0;
    for (const op of ascOps) {
        op.finalStart = op.start + delta;
        delta += op.replacement.length - (op.end - op.start);
    }

    // Group ops back by edit so each edit's occurrences get their own steps.
    const opsByEdit = new Map<number, FlatOp[]>();
    for (const op of flat) {
        const list = opsByEdit.get(op.editIndex);
        if (list) list.push(op);
        else opsByEdit.set(op.editIndex, [op]);
    }

    // Build the undo drafts and one reverse-replay step per applied fragment.
    // `fragStart` is the fragment's position in the fully-applied `html` and is
    // used only as the replay-order sort key; each step's position in its own
    // capture state is recomputed from the still-applied subset below.
    const steps: UndoStep[] = [];
    const undoDrafts: BatchUndoDraft[] = resolved.map((edit) => {
        const draft: BatchUndoDraft = {
            index: edit.index,
            client_item_id: edit.client_item_id,
            operation: edit.operation,
            undo_old_html: edit.undoOldHtml,
            undo_new_html: edit.undoNewHtml,
        };
        if (edit.operation === 'rewrite') return draft; // rewrite undo restores the full body; no anchors

        // Ascending (final position, then original position) fixes the stored
        // occurrence order and the slot each step writes into.
        const ops = (opsByEdit.get(edit.index) ?? [])
            .slice()
            .sort((a, b) => a.finalStart - b.finalStart || a.start - b.start);
        if (ops.length === 0) return draft;

        const makeStep = (op: FlatOp, slot: number): UndoStep => ({
            editIndex: edit.index,
            start: op.start,
            end: op.end,
            replacementLength: op.replacement.length,
            fragmentOffset: op.fragmentOffset,
            fragLength: op.fragmentLength,
            fragStart: op.finalStart + op.fragmentOffset,
            undoOldHtml: edit.undoOldHtml,
            draft,
            slot,
            reverted: false,
            subsetFinalStart: 0,
        });

        if (edit.operation === 'str_replace_all') {
            // Placeholders keep the array ascending; the reverse walk fills each slot.
            draft.undo_occurrence_contexts = ops.map(() => ({ before: '', after: '' }));
            ops.forEach((op, slot) => steps.push(makeStep(op, slot)));
        } else {
            steps.push(makeStep(ops[0], -1));
        }
        return draft;
    });

    // Replay order: record index DESC, then final-position DESC within a record,
    // then original-position DESC to order occurrences that collapse to one
    // final position (contiguous str_replace_all deletion seams).
    steps.sort((a, b) =>
        b.editIndex - a.editIndex
        || b.fragStart - a.fragStart
        || b.start - a.start);

    // Ascending (start, editIndex) order, computed ONCE (both arrays hold the
    // same step objects, just ordered differently). The replay loop below marks
    // each step reverted as it's consumed, so at any point the still-applied
    // subset is exactly "ascSteps minus reverted steps" — no per-step copy or
    // re-sort is needed to re-derive it.
    const ascSteps = steps.slice().sort((a, b) => a.start - b.start || a.editIndex - b.editIndex);

    let sim = html;
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        // The still-applied subset is this step plus every step LATER in replay
        // order. `sim` here equals `apply(strippedHtml, subset)`, so recompute
        // this step's fragment position by re-running the apply-side delta walk
        // over that subset: scan `ascSteps` in ascending order, skip steps already
        // reverted, and accumulate the length change of every still-applied op
        // up to (not including) this step. Equal-offset ordering is therefore
        // decided the same way apply decides it, never by an incremental shift.
        let subsetDelta = 0;
        for (const op of ascSteps) {
            if (op === step) break;
            if (op.reverted) continue;
            subsetDelta += op.replacementLength - (op.end - op.start);
        }
        step.subsetFinalStart = step.start + subsetDelta;

        const fragStart = step.subsetFinalStart + step.fragmentOffset;
        const fragEnd = fragStart + step.fragLength;
        const before = sim.substring(Math.max(0, fragStart - UNDO_CONTEXT_LENGTH), fragStart);
        const after = sim.substring(fragEnd, fragEnd + UNDO_CONTEXT_LENGTH);
        if (step.slot >= 0) {
            step.draft.undo_occurrence_contexts![step.slot] = { before, after };
        } else {
            step.draft.undo_before_context = before;
            step.draft.undo_after_context = after;
        }
        // Revert this step. `sim` becomes `apply(strippedHtml, subset \ {step})`,
        // the capture state for the next step in replay order.
        sim = sim.slice(0, fragStart) + step.undoOldHtml + sim.slice(fragEnd);
        step.reverted = true;
    }

    if (sim !== strippedHtml) {
        logger('applyResolvedEdits: reverse undo simulation did not reconstruct the pre-edit HTML; undo anchors may be imprecise', 1);
    }

    return { newStrippedHtml: html, undoDrafts };
}

// =============================================================================
// Phase 4: undo-context refresh
// =============================================================================

/**
 * Refresh each undo draft's context anchors against the FINAL saved,
 * data-citation-item-stripped HTML (post-footer, post-ProseMirror-normalization).
 *
 * Same replay-order reverse simulation as `applyResolvedEdits`, but positions
 * are FOUND (the final HTML may differ from the applied HTML by a footer and by
 * ProseMirror normalization) rather than known. Batch undo replays records in
 * DESCENDING index order against an evolving document, and within a
 * str_replace_all record its occurrences in DESCENDING stored-slot order (the
 * stored array is ascending; replay reverses it — see
 * `react/utils/editNoteActions.ts`). Each step is located against the evolving
 * state and reverted before the next, so every refreshed window reflects the
 * document state that step is replayed against.
 *
 * Tolerant by design: on ANY location failure the apply-time anchors are kept
 * for that step AND every remaining step (they are already replay-consistent
 * modulo normalization, and undo carries its own fuzzy fallbacks), and the
 * refresh stops — the evolving state is unreliable once a step cannot be
 * reverted.
 *
 * `appliedHtml` is the stripped HTML `applyResolvedEdits` produced (the string
 * every draft's apply-time anchors were sliced from). When it is byte-identical
 * to `finalStrippedHtml`, the apply-time anchors already reflect the final
 * state — the refresh is skipped entirely.
 */
export function captureUndoContexts(
    finalStrippedHtml: string,
    drafts: BatchUndoDraft[],
    appliedHtml?: string,
): void {
    if (appliedHtml !== undefined && appliedHtml === finalStrippedHtml) return;

    // Locate a deletion seam in `state` from its stored contexts. The context
    // immediately before the deletion identifies the seam even when a Beaver
    // footer inserts HTML between that seam and the old after-context.
    const locateSeam = (
        state: string,
        context: { before: string; after: string },
    ): number | null => {
        const beforePositions = context.before ? findAllOccurrences(state, context.before) : [];
        const afterPositions = context.after ? findAllOccurrences(state, context.after) : [];

        if (beforePositions.length === 1) {
            return beforePositions[0] + context.before.length;
        }
        if (afterPositions.length === 1) {
            if (beforePositions.length > 1) {
                // Pair the unique after-context with its nearest preceding
                // before-context when the latter repeats elsewhere.
                const preceding = beforePositions
                    .map((p) => p + context.before.length)
                    .filter((p) => p <= afterPositions[0]);
                if (preceding.length > 0) return Math.max(...preceding);
            } else if (!context.before) {
                return afterPositions[0];
            }
        }
        return null;
    };

    // Flatten drafts into replay-ordered steps: records in DESCENDING array
    // order (matching [...undoRecords].reverse() at replay), and within a
    // str_replace_all record its occurrences in DESCENDING slot order.
    interface CaptureStep {
        draft: BatchUndoDraft;
        /** Ascending occurrence slot for str_replace_all, or -1 for single-fragment. */
        slot: number;
        undoOldHtml: string;
        undoNewHtml: string;
        /** Apply-time context, used for seam location. */
        applyBefore: string;
        applyAfter: string;
        /** Occurrences of this record not yet reverted at this step (>= 1). */
        remainingCount: number;
    }

    const steps: CaptureStep[] = [];
    for (let d = drafts.length - 1; d >= 0; d--) {
        const draft = drafts[d];
        if (draft.operation === 'rewrite') continue; // rewrite undo restores the full body
        const undoOldHtml = draft.undo_old_html;
        const undoNewHtml = draft.undo_new_html;
        if (draft.undo_occurrence_contexts !== undefined) {
            const occs = draft.undo_occurrence_contexts;
            for (let slot = occs.length - 1; slot >= 0; slot--) {
                steps.push({
                    draft,
                    slot,
                    undoOldHtml,
                    undoNewHtml,
                    applyBefore: occs[slot].before,
                    applyAfter: occs[slot].after,
                    remainingCount: slot + 1,
                });
            }
        } else {
            steps.push({
                draft,
                slot: -1,
                undoOldHtml,
                undoNewHtml,
                applyBefore: draft.undo_before_context ?? '',
                applyAfter: draft.undo_after_context ?? '',
                remainingCount: 1,
            });
        }
    }

    let state = finalStrippedHtml;
    for (const step of steps) {
        let start: number;
        let end: number;
        if (!step.undoNewHtml) {
            // Deletion seam: relocate via the stored contexts.
            const seam = locateSeam(state, { before: step.applyBefore, after: step.applyAfter });
            if (seam === null) {
                logger('captureUndoContexts: could not relocate a deletion seam in the final note HTML; keeping apply-time anchors for the remaining undo steps', 1);
                break;
            }
            start = seam;
            end = seam;
        } else {
            const positions = findAllOccurrences(state, step.undoNewHtml);
            if (step.slot >= 0) {
                // str_replace_all occurrence: the applied fragment must appear
                // exactly as many times as this record has occurrences not yet
                // reverted; this occurrence is the last (highest) of them.
                if (positions.length !== step.remainingCount) {
                    logger('captureUndoContexts: str_replace_all occurrence count drifted in the final note HTML; keeping apply-time anchors for the remaining undo steps', 1);
                    break;
                }
                start = positions[positions.length - 1];
            } else {
                if (positions.length !== 1) {
                    logger('captureUndoContexts: applied fragment not uniquely locatable in the final note HTML; keeping apply-time anchors for the remaining undo steps', 1);
                    break;
                }
                start = positions[0];
            }
            end = start + step.undoNewHtml.length;
        }

        const before = state.substring(Math.max(0, start - UNDO_CONTEXT_LENGTH), start);
        const after = state.substring(end, end + UNDO_CONTEXT_LENGTH);
        if (step.slot >= 0) {
            step.draft.undo_occurrence_contexts![step.slot] = { before, after };
        } else {
            step.draft.undo_before_context = before;
            step.draft.undo_after_context = after;
        }
        // Revert this step so the next locates against the evolving state.
        state = state.slice(0, start) + step.undoOldHtml + state.slice(end);
    }
}

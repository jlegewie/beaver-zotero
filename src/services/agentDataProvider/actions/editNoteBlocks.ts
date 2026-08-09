/**
 * `edit_note_blocks` — the Zotero-touching validate/execute layer.
 *
 * The correctness core lives in two pure modules and is fully tested there:
 *   - `src/utils/editNoteBlocksCore.ts` — block number → raw range, per-edit gates
 *   - `src/utils/noteSnapshot.ts`       — address snapshot build/verify
 *
 * This file does only what those modules deliberately cannot: resolve the note,
 * enforce the library-exclusion boundary, preload every async input, drive the
 * engine, and write the result. It mirrors `editNoteBatch.ts` — same gate
 * ordering, same error helpers, same executor shape — and reuses the batch
 * engine's `applyResolvedEdits` / `captureUndoContexts` unchanged, because the
 * block engine emits the batch engine's own `ResolvedBatchEdit` shape.
 *
 * Two deliberate departures from `editNoteBatch.ts` are called out at their
 * sites and must not be "fixed" back:
 *   1. validate reads the note with `getNoteHtmlForRead` (see `readNoteHtmlForValidate`);
 *   2. execute has a hard no-await critical section (see `executeEditNoteBlocksAction`).
 */

import { logger } from '@beaver/agent-core/platform/logger';
import {
    libraryRefForLibraryID,
    modelObjectIdFromReference,
    resolveItemReference,
    resolveLibraryRef,
    UNRESOLVED_LIBRARY_ID,
} from '../../../utils/libraryIdentity';
import { searchableLibraryIdsAtom } from '../../../../react/atoms/profile';
import type {
    EditNoteBlocksProposedData,
    EditNoteBlocksEditItem,
    EditNoteBlocksAppliedEdit,
    EditNoteBlocksSkippedEdit,
    EditNoteBlocksUndoRecord,
    EditNoteBlocksResultData,
} from '@beaver/agent-core/types/agentActions/editNoteBlocks';
import type { EditNoteBatchEditItem } from '@beaver/agent-core/types/agentActions/editNoteBatch';
import {
    getOrSimplify,
    invalidateSimplificationCache,
    normalizeNoteHtml,
    type SimplificationMetadata,
} from '../../../utils/noteHtmlSimplifier';
import { assessNoteRewrite } from '../../../utils/noteRewriteRisk';
import {
    checkDuplicateCitations,
    validateNewString,
} from '../../../utils/editNoteValidation';
import {
    expandToRawHtml,
    extractAttr,
    preloadNotePageLabels,
    type ExternalRefContext,
} from '../../../utils/noteCitationExpand';
import {
    baseCitationKey,
    normalizeCitationTag,
    parseRawCitationAttributes,
    type CitationRef,
} from '@beaver/agent-core/citations/citationGrammar';
import {
    getNoteHtmlForRead,
    getLatestNoteHtml,
    waitForNoteSaveStabilization,
    flushLiveEditorToDB,
} from '../../../utils/noteEditorIO';
import {
    stripDataCitationItems,
    extractDataCitationItems,
    rebuildDataCitationItems,
    hasSchemaVersionWrapper,
} from '../../../utils/noteWrapper';
import { clearNoteEditorSelection } from '../../../../react/utils/sourceUtils';
import { store } from '../../../../react/store';
import { currentThreadIdAtom } from '../../../../react/atoms/threads';
import { addOrUpdateEditFooter } from '../../../utils/noteEditFooter';
import { assertNoPreviewMarkers, containsPreviewMarkers, stripPreviewMarkers } from '../../../utils/notePreviewGuard';
import { dismissDiffPreview, isDiffPreviewActive, isDiffPreviewPendingFor } from '../../../../react/utils/noteEditorDiffPreview';
import {
    WSAgentActionValidateRequest,
    WSAgentActionValidateResponse,
    WSAgentActionExecuteRequest,
    WSAgentActionExecuteResponse,
    type EditValidationError,
    type RefreshedNoteState,
} from '@beaver/agent-core/protocol/agentProtocol';
import { checkLibraryExcluded, excludedLibraryMessage, getDeferredToolPreference } from '../utils';
import { TimeoutContext, checkAborted, TimeoutError } from '../timeout';
import { getExternalRefContext } from './editNote';
import {
    MAX_BATCH_EDITS,
    buildRewrittenNoteBody,
    preloadBatchLabels,
    type PreloadedLabels,
} from './editNoteBatch';
import {
    applyResolvedEdits,
    captureUndoContexts,
    type BatchUndoDraft,
    type ResolvedBatchEdit,
} from '../../../utils/editNoteBatchCore';
import {
    buildBlockRawIndex,
    selectBlockEdits,
    type BlockEditSkip,
    type BlockEditSpec,
    type BlockRawIndex,
    type SelectedBlockEdit,
} from '../../../utils/editNoteBlocksCore';
import {
    EMPTY_READ_WINDOW,
    buildAddressSnapshot,
    verifyAddressSnapshot,
    type ReadWindow,
} from '../../../utils/noteSnapshot';

// =============================================================================
// Constants
// =============================================================================

/**
 * Size cap for a note body shipped inline (validate-time `current_value` on a
 * snapshot mismatch, execute-time `refreshed_note`). Above either bound the body
 * is omitted and the accompanying snapshot carries {@link EMPTY_READ_WINDOW}, so
 * numeric addressing fails closed until the model re-reads.
 */
const MAX_INLINE_NOTE_LINES = 500;
const MAX_INLINE_NOTE_CHARS = 50_000;

/** Length of the raw-note context anchors persisted for the diff preview. */
const TARGET_CONTEXT_LENGTH = 200;

/** A citation tag in simplified content. Mirrors `checkNewCitationItemsExist`. */
const CITATION_TAG_RE = /<citation\s+([^/]*?)\s*\/>/g;

// =============================================================================
// Response helpers
// =============================================================================

interface ValidateErrorExtras {
    /**
     * `current_value` on an ERROR return. No other note action does this —
     * `editNoteBatch.ts`'s `validateError()` omits it on every error path — but
     * the snapshot-mismatch recovery payload has to ride somewhere, and the
     * protocol's `current_value` TSDoc reserves the `kind: 'snapshot_mismatch'`
     * discriminant for exactly this.
     */
    current_value?: any;
    edit_errors?: EditValidationError[];
}

function validateError(
    requestId: string,
    error: string,
    error_code: string,
    extras: ValidateErrorExtras = {},
): WSAgentActionValidateResponse {
    return {
        type: 'agent_action_validate_response',
        request_id: requestId,
        valid: false,
        error,
        error_code,
        ...(extras.current_value !== undefined ? { current_value: extras.current_value } : {}),
        ...(extras.edit_errors !== undefined ? { edit_errors: extras.edit_errors } : {}),
        preference: 'always_ask',
    };
}

function executeError(
    requestId: string,
    error: string,
    error_code: string,
    refreshed_note?: RefreshedNoteState,
): WSAgentActionExecuteResponse {
    return {
        type: 'agent_action_execute_response',
        request_id: requestId,
        success: false,
        error,
        error_code,
        ...(refreshed_note ? { refreshed_note } : {}),
    };
}

// =============================================================================
// Shape gate
// =============================================================================

/** True for the one edit shape that needs no snapshot and no block numbering. */
function isWholeBodyRewrite(edit: EditNoteBlocksEditItem | undefined): boolean {
    return !!edit && edit.op === 'replace' && edit.block === 'all';
}

/** True when the request is a lone `block: 'all'` rewrite. */
function isSoleWholeBodyRewrite(edits: EditNoteBlocksEditItem[]): boolean {
    return edits.length === 1 && isWholeBodyRewrite(edits[0]);
}

/**
 * Structural gate shared by validate + execute.
 *
 * Besides the batch-style positional-index invariant (the engine orders edits by
 * `index`, and `applyResolvedEdits` groups undo drafts by it, so duplicate or
 * out-of-order indices are not safe to accept), this enforces the two rules the
 * addressing design rests on: `block: 'all'` is a whole-body rewrite and cannot
 * share a request with numeric addresses, and any request that addresses by
 * number must carry the snapshot token pinning that numbering.
 */
export function checkBlocksShape(
    edits: EditNoteBlocksEditItem[] | undefined,
    snapshot: string | undefined,
): { error: string; errorCode: string } | null {
    if (!Array.isArray(edits) || edits.length === 0) {
        return { error: 'edit_note_blocks requires at least one edit.', errorCode: 'no_edits' };
    }
    if (edits.length > MAX_BATCH_EDITS) {
        return {
            error: `edit_note_blocks supports at most ${MAX_BATCH_EDITS} edits per call; received ${edits.length}. `
                + 'Split the changes into multiple calls, or use a single block:"all" edit for dense whole-note changes.',
            errorCode: 'invalid_edits',
        };
    }
    const invalidIndexPosition = edits.findIndex(
        (edit, position) => !edit || !Number.isInteger(edit.index) || edit.index !== position,
    );
    if (invalidIndexPosition !== -1) {
        return {
            error: 'Each edit index must match its zero-based position in edits[]. '
                + `Expected index ${invalidIndexPosition} at position ${invalidIndexPosition}, `
                + `received ${String(edits[invalidIndexPosition]?.index)}.`,
            errorCode: 'invalid_edits',
        };
    }
    const wholeBodyCount = edits.filter((e) => isWholeBodyRewrite(e)).length;
    if (wholeBodyCount > 0 && edits.length > 1) {
        return {
            error: 'A block:"all" edit rewrites the whole note body and must be the only edit in the '
                + 'request. Send it on its own, or express the changes as numbered replace/insert/delete edits.',
            errorCode: 'invalid_edits',
        };
    }
    if (!isSoleWholeBodyRewrite(edits) && (typeof snapshot !== 'string' || snapshot === '')) {
        return {
            error: 'edit_note_blocks requires the `snapshot` token from the read_note response whose block '
                + 'numbers these edits address. Call read_note first and echo its snapshot back.',
            errorCode: 'snapshot_required',
        };
    }
    return null;
}

/** Map persisted edit items to the engine's spec shape. */
function toBlockEditSpecs(edits: EditNoteBlocksEditItem[]): BlockEditSpec[] {
    return edits.map((edit) => ({
        index: edit.index,
        client_item_id: edit.client_item_id,
        op: edit.op,
        block: edit.block,
        after: edit.after,
        from_block: edit.from_block,
        to_block: edit.to_block,
        expect: edit.expect,
        expect_end: edit.expect_end,
        content: edit.content,
    }));
}

// =============================================================================
// Note payload / snapshot helpers
// =============================================================================

/**
 * Build the `{ snapshot, total_lines, note? }` triple shipped to the model.
 *
 * The window inside the token is the whole note when the body travels with it
 * and {@link EMPTY_READ_WINDOW} when it does not — the rule that keeps a
 * large-note response from licensing addresses the model was never shown.
 */
function buildInlineNoteState(simplified: string): RefreshedNoteState {
    const totalLines = simplified.split('\n').length;
    const fits = totalLines <= MAX_INLINE_NOTE_LINES && simplified.length <= MAX_INLINE_NOTE_CHARS;
    const window: ReadWindow = fits ? { from: 1, to: totalLines } : EMPTY_READ_WINDOW;
    return {
        snapshot: buildAddressSnapshot(simplified, window),
        total_lines: totalLines,
        ...(fits ? { note: simplified } : { truncated: true }),
    };
}

/**
 * The validate-time snapshot-mismatch recovery payload.
 *
 * Deliberately carries the SAME fields as execute's `refreshed_note` — including
 * `truncated`. Without it, a large note yields an empty-window token and no
 * `note` with nothing saying why, and the two recovery paths disagree about a
 * fact the model needs in order to know it must re-read.
 */
function buildSnapshotMismatchValue(simplified: string): Record<string, any> {
    const state = buildInlineNoteState(simplified);
    return {
        kind: 'snapshot_mismatch',
        snapshot: state.snapshot,
        total_lines: state.total_lines,
        ...(state.note !== undefined ? { note: state.note } : {}),
        ...(state.truncated ? { truncated: true } : {}),
    };
}

const SNAPSHOT_MISMATCH_MESSAGE =
    'The note changed since the read_note call these block numbers were written against, so the '
    + 'block numbering no longer matches. Re-address the edits against the current note (returned '
    + 'with this error) or call read_note again.';

// =============================================================================
// Citation degrade
// =============================================================================

/**
 * What to substitute for one unresolvable citation identity.
 *
 * `edit_note_blocks` does NOT treat an unresolvable citation as fatal the way
 * `checkNewCitationItemsExist` does for edit_note/edit_note_batch: a block edit
 * that is otherwise perfectly addressed should not be thrown away because one
 * identifier went stale. The citation degrades to plain text and the edit still
 * applies, with a warning naming what was substituted.
 */
export interface CitationDegrade {
    /** Replacement for the whole `<citation …/>` tag, in simplified space. */
    replacement: string;
    warning: string;
}

/** Every citation identity appearing in `content`, keyed by {@link baseCitationKey}. */
function* iterateCitationIdentities(content: string): Generator<{ key: string; ref: CitationRef }> {
    // A fresh regex per call: this is a generator, so a caller that breaks early
    // would otherwise leave a shared `lastIndex` behind for the next caller.
    const re = new RegExp(CITATION_TAG_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
        const normalized = normalizeCitationTag(parseRawCitationAttributes(m[1]));
        if (!normalized.ok) continue;
        yield { key: baseCitationKey(normalized.ref), ref: normalized.ref };
    }
}

/**
 * Resolve every citation identity in every edit's content into a degrade map,
 * BEFORE the synchronous section. Identity resolution is async (`Zotero.Items`),
 * so it cannot happen inside {@link SelectBlockEditsContext.preprocessContent} —
 * the degrade hook consults only this map.
 *
 * LIBRARY-EXCLUSION BOUNDARY. For each identity the exclusion check runs BEFORE
 * any `Zotero.Items` lookup, and an excluded-library reference returns
 * immediately. Whether the item exists in an excluded library must never be
 * observable, not even through a timing or warning difference.
 *
 * Entries are recorded only for identities that must degrade; a miss means
 * "leave the tag alone" and lets `expandToRawHtml` do its normal job (including
 * the tier-1 auto-resolve and tier-2 hyperlink for `external_id`, which it
 * already implements — this function only covers the tiers that would otherwise
 * throw).
 */
export async function resolveCitationDegrades(
    contents: readonly string[],
    externalRefContext: ExternalRefContext,
): Promise<Map<string, CitationDegrade>> {
    const degrades = new Map<string, CitationDegrade>();
    const seen = new Set<string>();

    for (const content of contents) {
        if (!content || content.indexOf('<citation') === -1) continue;
        for (const { key, ref } of iterateCitationIdentities(content)) {
            if (seen.has(key)) continue;
            seen.add(key);

            if (ref.kind === 'zotero') {
                const id = modelObjectIdFromReference(ref);
                const libraryId = resolveLibraryRef({
                    library_id: ref.library_id,
                    library_ref: ref.library_ref,
                });
                if (libraryId === null || libraryId === UNRESOLVED_LIBRARY_ID) {
                    degrades.set(key, {
                        replacement: `(see: ${id})`,
                        warning: `citation id="${id}" not found — inserted as plain text `
                            + '(its library is not available on this computer).',
                    });
                    continue;
                }
                // BEFORE any lookup — see the exclusion-boundary note above.
                const excluded = checkLibraryExcluded(libraryId);
                if (excluded) {
                    degrades.set(key, {
                        replacement: `(see: ${id})`,
                        warning: `citation id="${id}" not found — inserted as plain text. ${excluded.message}`,
                    });
                    continue;
                }
                const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryId, ref.zotero_key);
                if (!item) {
                    degrades.set(key, {
                        replacement: `(see: ${id})`,
                        warning: `citation id="${id}" not found — inserted as plain text.`,
                    });
                }
                continue;
            }

            if (ref.kind === 'external') {
                const externalId = ref.external_id;
                // Tier 1: mapped to a real Zotero item. Re-run the exclusion
                // boundary on the MAPPED library — an external work mapped into
                // an excluded library must not be looked up or cited either.
                const mapped = externalRefContext?.externalItemMapping?.[externalId];
                let mappingIsUsable = false;
                let mappingIsBlocked = false;
                if (mapped) {
                    const mappedLibraryId = resolveLibraryRef({
                        library_id: mapped.library_id,
                        library_ref: mapped.library_ref,
                    });
                    if (mappedLibraryId === null || mappedLibraryId === UNRESOLVED_LIBRARY_ID) {
                        mappingIsBlocked = true;
                    } else if (checkLibraryExcluded(mappedLibraryId)) {
                        mappingIsBlocked = true;
                    } else {
                        mappingIsUsable = true;
                    }
                }
                if (mappingIsUsable) continue; // expansion emits a real Zotero citation

                // A BLOCKED mapping must fall through to tier 3, NOT to tier 2.
                // `expandToRawHtml` consults `externalItemMapping` BEFORE
                // `externalRefs` (`noteCitationExpand.ts:817-829`), so once a
                // mapping exists it will take the tier-1 branch and throw on the
                // exclusion gate inside `buildCitationFromSimplifiedAttrs` — it
                // never reaches its own tier-2 hyperlink. Deferring to tier 2
                // here would therefore turn a degradable citation into an
                // `expansion_failed` skip, which is exactly what degrade exists
                // to prevent. (No privacy leak either way: the gate holds.)
                if (!mappingIsBlocked && externalRefContext?.externalRefs?.[externalId]) {
                    // Tier 2: external metadata present and nothing blocking it →
                    // `expandToRawHtml` emits an inline hyperlink itself.
                    continue;
                }
                // Tier 3: no usable data.
                degrades.set(key, {
                    replacement: `(see: ${externalId})`,
                    warning: `citation external_id="${externalId}" not found — inserted as plain text.`,
                });
                continue;
            }

            // external_file and any future ref kind: left to the expansion layer,
            // which fails the individual edit with `expansion_failed`.
        }
    }

    return degrades;
}

/**
 * Build the engine's `preprocessContent` hook from a preloaded degrade map.
 * Purely synchronous by construction — see {@link resolveCitationDegrades}.
 */
export function makeCitationDegrader(
    degrades: Map<string, CitationDegrade>,
    metadata: SimplificationMetadata,
): (content: string) => { content: string; warnings: string[] } {
    return (content: string) => {
        const warnings: string[] = [];
        if (!content || degrades.size === 0 || content.indexOf('<citation') === -1) {
            return { content, warnings };
        }
        const out = content.replace(CITATION_TAG_RE, (match, attrStr: string) => {
            // An existing citation of THIS note is identified by `ref` and is
            // expanded from stored raw HTML; it is never degraded.
            const ref = extractAttr(attrStr, 'ref');
            if (ref && metadata.elements.has(ref)) return match;
            const normalized = normalizeCitationTag(parseRawCitationAttributes(attrStr));
            if (!normalized.ok) return match;
            const degrade = degrades.get(baseCitationKey(normalized.ref));
            if (!degrade) return match;
            warnings.push(degrade.warning);
            return degrade.replacement;
        });
        return { content: out, warnings };
    };
}

// =============================================================================
// Preloads
// =============================================================================

/**
 * Page-label + structural-locator preload for block edits.
 *
 * Reuses the batch preloader verbatim by presenting each block edit in its
 * `{ new_string, old_string }` vocabulary: `content` is the payload that may
 * carry new citations, `expect` is the confirmation text. One scan over the
 * concatenation of all of them, exactly as the batch path does.
 */
export async function preloadBlockLabels(edits: EditNoteBlocksEditItem[]): Promise<PreloadedLabels> {
    const asBatch: EditNoteBatchEditItem[] = edits.map((edit) => ({
        index: edit.index,
        new_string: edit.content ?? '',
        old_string: `${edit.expect ?? ''}\n${edit.expect_end ?? ''}`,
    }));
    return preloadBatchLabels(asBatch);
}

/** Every string an edit contributes that can contain a citation tag. */
function editContents(edits: EditNoteBlocksEditItem[]): string[] {
    return edits.map((e) => e.content ?? '').filter((c) => c !== '');
}

// =============================================================================
// Advisory block arithmetic
// =============================================================================

/**
 * Advisory post-edit block addresses.
 *
 * `D(n)` is the running line-count delta contributed by every applied edit that
 * lies entirely BEFORE pre-edit block `n`; a pre-edit block `n` therefore sits
 * at `n + D(n)` afterwards. Cheap arithmetic over the engine's own
 * `anchorBlock` / `consumedBlocks` / `producedBlocks`, with no re-simplification.
 *
 * ADVISORY ONLY, and labelled as such on the wire
 * (`EditNoteBlocksAppliedEdit.blocks`, `EditNoteBlocksSkippedEdit.block_hint`):
 * they describe the note as of the moment this action finished and must not be
 * re-addressed without a fresh snapshot.
 */
interface BlockShiftModel {
    /** Post-edit position of pre-edit block `n`. */
    shift: (n: number) => number;
    /** Post-edit block range this applied edit produced, or null for a delete. */
    producedRange: (edit: SelectedBlockEdit) => { from: number; to: number } | null;
}

function buildBlockShiftModel(applied: readonly SelectedBlockEdit[]): BlockShiftModel {
    const entries = applied.map((e) => ({
        // Last PRE-edit block the edit consumes; an insert consumes nothing and
        // is anchored at the seam after `anchorBlock`.
        lastPreBlock: e.consumedBlocks > 0 ? e.anchorBlock + e.consumedBlocks - 1 : e.anchorBlock,
        delta: e.producedBlocks - e.consumedBlocks,
        edit: e,
    }));

    const deltaBefore = (block: number): number =>
        entries.reduce((sum, entry) => (entry.lastPreBlock < block ? sum + entry.delta : sum), 0);

    return {
        shift: (n: number) => n + deltaBefore(n),
        producedRange: (edit: SelectedBlockEdit) => {
            if (edit.producedBlocks === 0) return null;
            // `deltaBefore(anchorBlock)` is what EXCLUDES this edit from its own
            // offset: every op's own `lastPreBlock` is >= its `anchorBlock`, so
            // the `<` test never counts it. That holds for `anchorBlock: 0`
            // (`insert after: 0`) too — `deltaBefore(0)` is legitimately 0.
            // Substituting 1 there, as an earlier revision did, made `0 < 1`
            // true and folded the edit's own delta into its own position.
            const d = deltaBefore(edit.anchorBlock);
            const from = edit.consumedBlocks > 0
                ? edit.anchorBlock + d
                : edit.anchorBlock + d + 1;
            return { from, to: from + edit.producedBlocks - 1 };
        },
    };
}

function formatBlockRange(range: { from: number; to: number } | null): string {
    if (!range) return '';
    return range.from === range.to ? String(range.from) : `${range.from}-${range.to}`;
}

/** The pre-edit block(s) an edit addressed, for the advisory `block_hint`. */
function addressedBlocks(edit: EditNoteBlocksEditItem): { from: number; to: number } | null {
    if (edit.op === 'replace' && typeof edit.block === 'number') {
        return { from: edit.block, to: edit.block };
    }
    if (edit.op === 'delete' && typeof edit.from_block === 'number') {
        const to = typeof edit.to_block === 'number' ? edit.to_block : edit.from_block;
        return { from: edit.from_block, to };
    }
    if (edit.op === 'insert' && typeof edit.after === 'number' && edit.after >= 1) {
        return { from: edit.after, to: edit.after };
    }
    return null;
}

// =============================================================================
// Persisted per-edit display metadata
// =============================================================================

interface PresentationFields {
    operation: string;
    old_string?: string;
    new_string: string;
    /** Raw range the anchors bracket (the presentational target, not the splice). */
    presentationRange: { start: number; end: number };
}

/**
 * Widen a presentational line window until it carries visible text.
 *
 * WHY THIS EXISTS. The preview's first drop gate
 * (`react/utils/editNotePreviewOperations.ts:7`) keeps a non-rewrite/append edit
 * only when its `old_string` is truthy, and its second
 * (`react/utils/noteEditorDiffPreview.ts:448`) needs that string to expand to a
 * locatable raw fragment. An edit anchored on a BLANK simplified line satisfies
 * neither, so it is dropped from the preview — while still executing. That is
 * PARTIALLY silent, which is what makes it a defect rather than a tolerable
 * edge: when every edit drops, `showDiffPreview` returns false and nothing
 * renders at all (fail-safe), but with three edits where one has a blank anchor
 * the user is shown two changes and approves three.
 *
 * Blank simplified lines are not hypothetical — an empty list item
 * (`<ul><li></li></ul>`) produces a mid-document empty line via the li-flattening
 * pass in `src/prosemirror/serializer.ts`, and empty bullets are common.
 *
 * The fix is to WIDEN the presentational anchor, never to relax a drop gate:
 * both gates are shared with the legacy and batch paths, and leaving them
 * untouched is what keeps this change free of blast radius. Extending BACKWARDS
 * is preferred so the change renders in its preceding context; an edit at line 1
 * falls forwards instead; a note that projects to nothing anywhere keeps the
 * original window and accepts the drop.
 *
 * A window that already carries text is returned unchanged, so the common case
 * is byte-identical to the un-widened behavior.
 */
function widenPresentationWindow(
    lines: readonly string[],
    from: number,
    to: number,
): { from: number; to: number } {
    const hasText = (a: number, b: number) => lines.slice(a - 1, b).join('\n').trim() !== '';
    if (hasText(from, to)) return { from, to };

    let lo = from;
    const hi = to;
    while (lo > 1) {
        lo--;
        if (hasText(lo, hi)) return { from: lo, to: hi };
    }
    let hiFwd = to;
    while (hiFwd < lines.length) {
        hiFwd++;
        if (hasText(lo, hiFwd)) return { from: lo, to: hiFwd };
    }
    // Nothing in the whole note projects to visible text.
    return { from, to };
}

/**
 * The flat `{operation, old_string, new_string}` triple the diff preview needs.
 *
 * For INSERTS the pair is ANCHOR-MERGED rather than the literal splice, matching
 * the convention the preview file already documents for edit_note_batch inserts
 * (`react/utils/noteEditorDiffPreview.ts:432-437`): `old_string` holds the anchor
 * alone and `new_string` holds the anchor plus the inserted content, so the
 * insert renders as an ordinary before/after diff.
 *
 * Both existing preview drop gates must pass without relaxing either (see
 * {@link widenPresentationWindow}). Emitting simplified lines verbatim satisfies
 * the second: a contiguous run of simplified lines expands back to the exact
 * contiguous run of raw lines it came from (existing citations expand to their
 * stored raw HTML), which `constructMultiDiffHtml` then finds with `indexOf`.
 *
 * Every op is expressed as ONE splice inside a presentational WINDOW — replace
 * the window's `[targetFrom, targetTo]` lines with `replacementLines` — so
 * widening cannot make the "after" side wrong. Widening a delete, in particular,
 * must not show the borrowed context as deleted too; building `new_string` from
 * the window minus the deleted lines is what guarantees that.
 */
function buildPresentationFields(
    index: BlockRawIndex,
    spec: BlockEditSpec,
    selected: SelectedBlockEdit,
): PresentationFields {
    const { simplifiedLines, rawLineRanges } = index;
    const total = rawLineRanges.length;
    const trailingEmpty = simplifiedLines[total - 1] === '';
    const content = spec.content ?? '';
    const contentLines = content.split('\n');

    // "Append at the end of the body" — the three spellings the engine collapses
    // into one splice (see `buildSplice`'s `appendAtBodyEnd`). Deliberately NOT
    // widened: `append` clears gate 1 on its operation alone, and it has no
    // anchor line to widen around.
    const isAppend =
        (spec.op === 'insert' && spec.after === 'end')
        || (spec.op === 'insert' && spec.after === total && trailingEmpty)
        || (spec.op === 'replace' && selected.consumedBlocks === 0);

    if (isAppend) {
        return {
            operation: 'append',
            old_string: '',
            new_string: content,
            presentationRange: { start: index.bodyAppendPoint, end: index.bodyAppendPoint },
        };
    }

    // One uniform description of every remaining op: the pre-edit lines it
    // targets, the lines it puts there, and the diff-preview operation label.
    let operation: string;
    let targetFrom: number;
    let targetTo: number;
    let replacementLines: string[];

    if (spec.op === 'delete') {
        operation = 'str_replace';
        targetFrom = spec.from_block as number;
        targetTo = spec.to_block ?? targetFrom;
        replacementLines = [];
    } else if (spec.op === 'replace') {
        operation = 'str_replace';
        targetFrom = spec.block as number;
        targetTo = targetFrom;
        replacementLines = contentLines;
    } else if (selected.anchorBlock === 0) {
        operation = 'insert_before';
        targetFrom = 1;
        targetTo = 1;
        replacementLines = [...contentLines, simplifiedLines[0]];
    } else {
        operation = 'insert_after';
        targetFrom = selected.anchorBlock;
        targetTo = selected.anchorBlock;
        replacementLines = [simplifiedLines[targetFrom - 1], ...contentLines];
    }

    const window = widenPresentationWindow(simplifiedLines, targetFrom, targetTo);
    const windowLines = simplifiedLines.slice(window.from - 1, window.to);
    const offset = targetFrom - window.from;
    const newWindowLines = [
        ...windowLines.slice(0, offset),
        ...replacementLines,
        ...windowLines.slice(offset + (targetTo - targetFrom + 1)),
    ];

    return {
        operation,
        old_string: windowLines.join('\n'),
        new_string: newWindowLines.join('\n'),
        presentationRange: {
            start: rawLineRanges[window.from - 1].start,
            end: rawLineRanges[window.to - 1].end,
        },
    };
}

function contextAnchors(
    strippedHtml: string,
    range: { start: number; end: number },
): { before: string; after: string } {
    return {
        before: strippedHtml.slice(Math.max(0, range.start - TARGET_CONTEXT_LENGTH), range.start),
        after: strippedHtml.slice(range.end, range.end + TARGET_CONTEXT_LENGTH),
    };
}

/** Echo the request's addressing fields, without any display metadata. */
function baseNormalizedEdit(edit: EditNoteBlocksEditItem): EditNoteBlocksEditItem {
    const out: EditNoteBlocksEditItem = { index: edit.index, op: edit.op };
    if (edit.client_item_id !== undefined) out.client_item_id = edit.client_item_id;
    if (edit.block !== undefined) out.block = edit.block;
    if (edit.after !== undefined) out.after = edit.after;
    if (edit.from_block !== undefined) out.from_block = edit.from_block;
    if (edit.to_block !== undefined) out.to_block = edit.to_block;
    if (edit.expect !== undefined) out.expect = edit.expect;
    if (edit.expect_end !== undefined) out.expect_end = edit.expect_end;
    if (edit.content !== undefined) out.content = edit.content;
    return out;
}

// =============================================================================
// Selection pipeline shared by validate + execute
// =============================================================================

interface BlockSelection {
    index: BlockRawIndex;
    applied: SelectedBlockEdit[];
    skipped: BlockEditSkip[];
    resolvedEdits: ResolvedBatchEdit[];
    warnings: string[];
}

/**
 * Everything the block engine needs that is NOT async: index construction,
 * pre-skips for fabricated payload elements, and the selection pass.
 *
 * FULLY SYNCHRONOUS BY CONTRACT — execute calls it inside its no-await critical
 * section (see {@link executeEditNoteBlocksAction}). Do not add an await here.
 */
function runBlockSelection(
    simplified: string,
    strippedHtml: string,
    metadata: SimplificationMetadata,
    edits: EditNoteBlocksEditItem[],
    readWindow: ReadWindow,
    externalRefContext: ExternalRefContext,
    labels: PreloadedLabels,
    degrades: Map<string, CitationDegrade>,
): BlockSelection | { refusal: { error: string; errorCode: string } } {
    const built = buildBlockRawIndex(simplified, strippedHtml, metadata);
    if (!built.ok) return { refusal: { error: built.error, errorCode: built.errorCode } };
    const index = built.index;

    // Fabricated annotations/images/compound citations are rejected up front so
    // the model gets `validateNewString`'s specific message instead of the
    // expansion layer's generic one. Failing edits never reach the engine.
    const preSkips: BlockEditSkip[] = [];
    const eligible: EditNoteBlocksEditItem[] = [];
    for (const edit of edits) {
        const contentError = typeof edit.content === 'string' ? validateNewString(edit.content, metadata) : null;
        if (contentError) {
            preSkips.push({
                index: edit.index,
                ...(edit.client_item_id !== undefined ? { client_item_id: edit.client_item_id } : {}),
                reason_code: 'invalid_edit',
                reason: contentError,
            });
            continue;
        }
        eligible.push(edit);
    }

    const selection = selectBlockEdits(
        {
            index,
            externalRefContext,
            pageLabels: labels.pageLabels,
            resolvedLocatorPages: labels.resolvedLocatorPages,
            readWindow,
            preprocessContent: makeCitationDegrader(degrades, metadata),
        },
        toBlockEditSpecs(eligible),
    );
    if (!selection.ok) return { refusal: { error: selection.error, errorCode: selection.errorCode } };

    if (selection.unverifiedBlocks.length > 0) {
        // Not an error: a mask miss degrades a line to "unverified" by design.
        // Logged rather than surfaced so the model is not handed noise it cannot act on.
        logger(
            `editNoteBlocks: ${selection.unverifiedBlocks.length} addressed block(s) could not be `
            + `projection-verified (${selection.unverifiedBlocks.slice(0, 10).join(', ')})`,
            1,
        );
    }

    const skipped = [...preSkips, ...selection.skipped].sort((a, b) => a.index - b.index);
    const warnings: string[] = [];
    for (const a of selection.applied) warnings.push(...a.resolved.warnings);

    return {
        index,
        applied: selection.applied,
        skipped,
        resolvedEdits: selection.applied.map((a) => a.resolved),
        warnings,
    };
}

// =============================================================================
// Validate
// =============================================================================

/**
 * Read the note for VALIDATION with the read path's accessor.
 *
 * DELIBERATELY DIFFERENT FROM `edit_note` / `edit_note_batch`, which use
 * `getLatestNoteHtml`. That helper returns `candidates[0].html` even when it is
 * empty or whitespace-only, while `handleReadNoteRequest` uses
 * `getNoteHtmlForRead`, which picks the first NON-EMPTY live candidate with a
 * short retry. For a string-matched edit the two agreeing is merely nice; for a
 * block-addressed edit it is the whole contract — the snapshot token is a digest
 * over exactly the string the read produced, so if validation digests a
 * DIFFERENT string for an UNCHANGED note, every verification false-fails and the
 * tool is unusable on any note that happens to be open in an editor.
 *
 * Do not "align" this with the batch handler. The batch handler is the one that
 * would have to change, and changing it is out of scope here.
 */
async function readNoteHtmlForValidate(item: Zotero.Item): Promise<string> {
    return getNoteHtmlForRead(item);
}

async function validateEditNoteBlocksAction(
    request: WSAgentActionValidateRequest,
): Promise<WSAgentActionValidateResponse> {
    const { library_id, library_ref, zotero_key, edits, snapshot } =
        request.action_data as EditNoteBlocksProposedData;

    const shapeError = checkBlocksShape(edits, snapshot);
    if (shapeError) return validateError(request.request_id, shapeError.error, shapeError.errorCode);

    // Exclusion boundary BEFORE resolving/loading the note.
    const targetLibraryId = resolveLibraryRef({ library_id, library_ref });
    const excluded = targetLibraryId === null ? null : checkLibraryExcluded(targetLibraryId);
    if (excluded) return validateError(request.request_id, excluded.message, 'library_not_searchable');

    const resolved = await resolveItemReference({ library_id, library_ref, zotero_key });
    if (resolved.status === 'library_unavailable') {
        return validateError(request.request_id, `Library not available for note: ${library_ref || library_id}-${zotero_key}`, 'library_unavailable');
    }
    if (resolved.status === 'not_found') {
        return validateError(request.request_id, `Item not found: ${library_id}-${zotero_key}`, 'item_not_found');
    }
    const item = resolved.item;
    const resolvedLibraryId = item.libraryID;

    const library = Zotero.Libraries.get(resolvedLibraryId);
    if (!library) {
        return validateError(request.request_id, `Library not found: ${resolvedLibraryId}`, 'library_not_found');
    }

    const searchableIds = store.get(searchableLibraryIdsAtom);
    if (!searchableIds.includes(resolvedLibraryId)) {
        return validateError(request.request_id, excludedLibraryMessage(resolvedLibraryId), 'library_not_searchable');
    }

    if (!item.isNote()) {
        const itemId = modelObjectIdFromReference({ library_id: resolvedLibraryId, library_ref, zotero_key });
        return validateError(request.request_id, `Item ${itemId} is not a note`, 'not_a_note');
    }

    if (!library.editable) {
        return validateError(request.request_id, `Library '${library.name}' is read-only and cannot be edited`, 'library_not_editable');
    }

    await item.loadDataType('note');
    let rawHtml = await readNoteHtmlForValidate(item);
    if (containsPreviewMarkers(rawHtml)) {
        logger(`validateEditNoteBlocksAction: note ${resolvedLibraryId}-${zotero_key} contains persisted diff-preview markup; validating against stripped content`, 1);
        rawHtml = stripPreviewMarkers(rawHtml);
    }
    if (!rawHtml || rawHtml.trim() === '') {
        return validateError(request.request_id, `Note ${resolvedLibraryId}-${zotero_key} is empty`, 'empty_note');
    }

    // Simplify ONCE, strip ONCE.
    const noteId = `${resolvedLibraryId}-${zotero_key}`;
    const pageLabelsByItemId = await preloadNotePageLabels(rawHtml, resolvedLibraryId, { extractOnCacheMiss: true });
    const { simplified, metadata } = getOrSimplify(noteId, rawHtml, resolvedLibraryId, pageLabelsByItemId);
    const strippedHtml = stripDataCitationItems(normalizeNoteHtml(rawHtml));

    const externalRefContext = getExternalRefContext();
    const labels = await preloadBlockLabels(edits);
    const degrades = await resolveCitationDegrades(editContents(edits), externalRefContext);
    const degrade = makeCitationDegrader(degrades, metadata);

    const noteTitle = item.getNoteTitle() || '(untitled)';
    const totalLines = simplified.split('\n').length;
    const warnings: string[] = [...labels.locatorWarnings];

    // ── Sole `block: 'all'` rewrite — no numbering, no snapshot ──────────────
    if (isSoleWholeBodyRewrite(edits)) {
        const edit = edits[0];
        const rawContent = edit.content;
        if (typeof rawContent !== 'string' || rawContent.trim() === '') {
            return validateError(request.request_id, 'block:"all" requires `content` — the new note body.', 'invalid_edits');
        }
        const contentError = validateNewString(rawContent, metadata);
        if (contentError) return validateError(request.request_id, contentError, 'invalid_new_string');

        const pre = degrade(rawContent);
        warnings.push(...pre.warnings);
        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(
                pre.content, metadata, 'new', externalRefContext,
                labels.pageLabels, labels.resolvedLocatorPages,
            );
        } catch (e: any) {
            return validateError(request.request_id, e?.message || String(e), 'expansion_failed');
        }
        const dup = checkDuplicateCitations(rawContent, metadata);
        if (dup) warnings.push(dup);

        const newStripped = buildRewrittenNoteBody(strippedHtml, expandedNew);
        const risk = assessNoteRewrite(strippedHtml, newStripped);
        if (risk.isDestructive) {
            logger(
                `validateEditNoteBlocksAction: destructive block:"all" rewrite (${risk.reason}) of ${noteId} — `
                + `removed=${risk.removedFraction.toFixed(2)}, retained=${risk.retainedFraction.toFixed(2)} — requiring approval`,
                1,
            );
        }

        const normalizedEdit = baseNormalizedEdit(edit);
        normalizedEdit.operation = 'rewrite';
        normalizedEdit.new_string = rawContent;

        const response: WSAgentActionValidateResponse = {
            type: 'agent_action_validate_response',
            request_id: request.request_id,
            valid: true,
            current_value: {
                note_title: noteTitle,
                total_lines: totalLines,
                // The whole note IS shown here (`old_content`), so the token's
                // window is the whole note.
                snapshot: buildAddressSnapshot(simplified, { from: 1, to: totalLines }),
                applicable_count: 1,
                skipped_count: 0,
                old_content: simplified,
            },
            normalized_action_data: {
                library_id,
                zotero_key,
                ...(library_ref !== undefined ? { library_ref } : {}),
                ...(snapshot !== undefined ? { snapshot } : {}),
                ...(risk.isDestructive ? { destructive_rewrite: true } : {}),
                edits: [normalizedEdit],
            },
            preference: getDeferredToolPreference(
                risk.isDestructive ? 'destructive_note_rewrite' : 'edit_note_blocks',
                { library_id: resolvedLibraryId, zotero_key },
            ),
        };
        if (warnings.length > 0) response.warnings = warnings;
        return response;
    }

    // ── Numeric addressing ──────────────────────────────────────────────────
    const readWindow = verifyAddressSnapshot(snapshot as string, simplified);
    if (!readWindow) {
        return validateError(request.request_id, SNAPSHOT_MISMATCH_MESSAGE, 'snapshot_mismatch', {
            current_value: buildSnapshotMismatchValue(simplified),
        });
    }

    const selection = runBlockSelection(
        simplified, strippedHtml, metadata, edits, readWindow,
        externalRefContext, labels, degrades,
    );
    if ('refusal' in selection) {
        return validateError(request.request_id, selection.refusal.error, selection.refusal.errorCode);
    }
    warnings.push(...selection.warnings);

    const editErrors: EditValidationError[] = selection.skipped.map((s) => ({
        index: s.index,
        error: s.reason,
        error_code: s.reason_code,
        ...(s.actual !== undefined ? { actual: s.actual } : {}),
    }));

    if (selection.applied.length === 0) {
        return validateError(
            request.request_id,
            `None of the ${edits.length} edit(s) could be applied to this note.`,
            'no_applicable_edits',
            { edit_errors: editErrors },
        );
    }

    // Destructive escalation — over PRE/POST STRIPPED RAW.
    //
    // `assessNoteRewrite` reduces both sides through `toComparableText`, which
    // strips every tag before comparing, so raw-vs-raw is equivalent to
    // simplified-vs-simplified. Running it over the whole applied result (not
    // just a single-rewrite payload, which is all `edit_note_batch` can see)
    // catches the second destructive shape block addressing makes reachable:
    // `delete from_block:1 to_block:<total>`, or an edit set that guts the note.
    const { newStrippedHtml } = applyResolvedEdits(strippedHtml, selection.resolvedEdits);
    const risk = assessNoteRewrite(strippedHtml, newStrippedHtml);
    if (risk.isDestructive) {
        logger(
            `validateEditNoteBlocksAction: destructive block edit set (${risk.reason}) of ${noteId} — `
            + `removed=${risk.removedFraction.toFixed(2)}, retained=${risk.retainedFraction.toFixed(2)} — requiring approval`,
            1,
        );
    }

    for (const edit of edits) {
        if (typeof edit.content !== 'string') continue;
        const dup = checkDuplicateCitations(edit.content, metadata);
        if (dup) warnings.push(dup);
    }

    // `normalized_action_data` is ALWAYS emitted: it carries the persisted
    // per-edit display metadata (skip reasons, flat preview pair, anchors) that
    // the card and the diff preview render from.
    const appliedByIndex = new Map<number, SelectedBlockEdit>();
    for (const a of selection.applied) appliedByIndex.set(a.resolved.index, a);
    const skipByIndex = new Map<number, BlockEditSkip>();
    for (const s of selection.skipped) skipByIndex.set(s.index, s);

    const specByIndex = new Map<number, BlockEditSpec>();
    for (const spec of toBlockEditSpecs(edits)) specByIndex.set(spec.index, spec);

    const normalizedEdits: EditNoteBlocksEditItem[] = edits.map((edit) => {
        const out = baseNormalizedEdit(edit);
        const skip = skipByIndex.get(edit.index);
        if (skip) {
            // NO operation/old_string/new_string on a skipped edit: the preview
            // flattener keeps any entry whose `old_string` is non-empty, so a
            // skipped edit carrying them would be previewed as if it applied.
            out.skip_reason_code = skip.reason_code;
            out.skip_reason = skip.reason;
            return out;
        }
        const selected = appliedByIndex.get(edit.index);
        if (!selected) return out;
        const fields = buildPresentationFields(
            selection.index, specByIndex.get(edit.index)!, selected,
        );
        out.operation = fields.operation;
        if (fields.old_string !== undefined) out.old_string = fields.old_string;
        out.new_string = fields.new_string;
        const anchors = contextAnchors(strippedHtml, fields.presentationRange);
        out.target_before_context = anchors.before;
        out.target_after_context = anchors.after;
        return out;
    });

    const response: WSAgentActionValidateResponse = {
        type: 'agent_action_validate_response',
        request_id: request.request_id,
        valid: true,
        current_value: {
            note_title: noteTitle,
            total_lines: totalLines,
            // No note body travels on the success path, so the token's window is
            // the canonical empty one — it identifies the numbering this call ran
            // against without licensing a follow-up blind numeric address.
            snapshot: buildAddressSnapshot(simplified, EMPTY_READ_WINDOW),
            applicable_count: selection.applied.length,
            skipped_count: selection.skipped.length,
        },
        normalized_action_data: {
            library_id,
            zotero_key,
            ...(library_ref !== undefined ? { library_ref } : {}),
            snapshot,
            // The classification must travel with the action, not merely gate the
            // preference: the approval request still carries the
            // `edit_note_blocks` action type, so without this flag an ordinary
            // note-edit run grant would authorize a destructive edit set.
            ...(risk.isDestructive ? { destructive_rewrite: true } : {}),
            edits: normalizedEdits,
        },
        preference: getDeferredToolPreference(
            risk.isDestructive ? 'destructive_note_rewrite' : 'edit_note_blocks',
            { library_id: resolvedLibraryId, zotero_key },
        ),
    };
    if (editErrors.length > 0) response.edit_errors = editErrors;
    if (warnings.length > 0) response.warnings = warnings;
    return response;
}

// =============================================================================
// Execute
// =============================================================================

const EXECUTE_DESTRUCTIVE_REFUSAL =
    'The note changed after these edits were checked, and they would now discard most of its '
    + 'content. An edit that destructive needs the user\'s approval, so it was not applied. Read '
    + 'the note again and re-issue the change against its current content.';

/**
 * Execute an edit_note_blocks action.
 *
 * TOCTOU full re-run, mirroring the batch executor: exclusion guard before item
 * resolution, re-resolve, settle the live editor, then re-select every edit
 * against the note as it stands NOW.
 *
 * ── THE CRITICAL-SECTION RULE ───────────────────────────────────────────────
 * The batch executor is NOT a precedent here despite its comment: it says "avoid
 * async between here and setNote()" and then awaits `preloadNotePageLabels` and
 * `prepareSpecs` immediately afterwards. For batch that is inherent — you need
 * the note HTML to know which labels to preload, labels feed simplification, and
 * simplification feeds the match — and it is tolerable because batch relocates
 * its edits by STRING MATCH, which re-checks itself against whatever the note
 * turns out to be.
 *
 * Block addressing cannot tolerate it. Here the digest IS the drift check, so an
 * await between reading the note and verifying it races exactly the drift the
 * verification exists to detect. The cycle is therefore broken explicitly:
 *
 *   1. read the note PROVISIONALLY and await ALL async work off it — page
 *      labels, citation-expansion preloads, and citation-identity resolution for
 *      degrade (exclusion pre-checks plus `Zotero.Items` lookups, resolved into
 *      a Map);
 *   2. re-read the note as the AUTHORITATIVE snapshot;
 *   3. with NO awaits at all: simplify → verify snapshot → build index → select
 *      → apply → `setNote`.
 *
 * If the re-read differs from the provisional read, the preloads may be stale
 * for ids that appeared in between. That surfaces as an ordinary
 * `snapshot_mismatch` (the digest changed) or through the degrade/expansion
 * paths — never as a silent misaddressed splice. The address digest and the
 * whole selection pipeline are synchronous, which is what makes step 3 possible.
 *
 * A future maintainer WILL want to add an await in step 3. Do not.
 */
async function executeEditNoteBlocksAction(
    request: WSAgentActionExecuteRequest,
    ctx: TimeoutContext,
): Promise<WSAgentActionExecuteResponse> {
    const {
        library_id, library_ref, zotero_key, edits, snapshot, destructive_rewrite,
    } = request.action_data as EditNoteBlocksProposedData;

    const shapeError = checkBlocksShape(edits, snapshot);
    if (shapeError) return executeError(request.request_id, shapeError.error, shapeError.errorCode);

    // TOCTOU exclusion guard BEFORE resolving/loading the note.
    const targetLibraryId = resolveLibraryRef({ library_id, library_ref });
    const targetExcluded = targetLibraryId === null ? null : checkLibraryExcluded(targetLibraryId);
    if (targetExcluded) return executeError(request.request_id, targetExcluded.message, 'library_not_searchable');

    const resolved = await resolveItemReference({ library_id, library_ref, zotero_key });
    if (resolved.status !== 'found') {
        return executeError(
            request.request_id,
            resolved.status === 'library_unavailable'
                ? `Library not available for note: ${library_ref || library_id}-${zotero_key}`
                : `Item not found: ${library_id}-${zotero_key}`,
            resolved.status === 'library_unavailable' ? 'library_unavailable' : 'item_not_found',
        );
    }
    const item = resolved.item;
    const resolvedLibraryId = item.libraryID;

    const excludedLibrary = checkLibraryExcluded(resolvedLibraryId);
    if (excludedLibrary) return executeError(request.request_id, excludedLibrary.message, 'library_not_searchable');

    const executeLibrary = Zotero.Libraries.get(resolvedLibraryId);
    if (executeLibrary && !executeLibrary.editable) {
        return executeError(request.request_id, `Library '${executeLibrary.name}' is read-only and cannot be edited`, 'library_not_editable');
    }

    // Load note + settle any in-flight diff preview / unsaved editor content.
    await item.loadDataType('note');
    if (isDiffPreviewActive(resolvedLibraryId, zotero_key) || isDiffPreviewPendingFor(resolvedLibraryId, zotero_key)) {
        await dismissDiffPreview();
    }
    await flushLiveEditorToDB(item);

    // Repair persisted diff-preview markup (and save the repair even if the
    // action later fails, so a failed attempt still un-bricks the note).
    {
        const persistedHtml: string = item.getNote();
        if (containsPreviewMarkers(persistedHtml)) {
            const repaired = stripPreviewMarkers(persistedHtml);
            if (!containsPreviewMarkers(repaired)) {
                logger(`executeEditNoteBlocksAction: repairing persisted diff-preview markup in ${resolvedLibraryId}-${zotero_key}`, 1);
                item.setNote(repaired);
                await item.saveTx();
                await waitForNoteSaveStabilization(item, repaired);
            } else {
                logger(`executeEditNoteBlocksAction: diff-preview markup in ${resolvedLibraryId}-${zotero_key} could not be fully stripped; save will be refused by the preview guard`, 1);
            }
        }
    }

    const noteId = `${resolvedLibraryId}-${zotero_key}`;

    // ── STEP 1: PROVISIONAL read + every async preload ──────────────────────
    // Execute stays on the batch accessor (`item.getNote()` after
    // `flushLiveEditorToDB`) rather than validate's `getNoteHtmlForRead`: the
    // flush makes the DB authoritative, and it is the string that will actually
    // be written back. It differs from what the model saw only by ProseMirror
    // re-serialization, which `getOrSimplify` absorbs because it runs
    // `normalizeNoteHtml` internally. The asymmetry with validate is deliberate.
    const provisionalHtml: string = item.getNote();
    const pageLabelsByItemId = await preloadNotePageLabels(provisionalHtml, resolvedLibraryId, { extractOnCacheMiss: true });
    const labels = await preloadBlockLabels(edits);
    const externalRefContext = getExternalRefContext();
    const degrades = await resolveCitationDegrades(editContents(edits), externalRefContext);
    const threadId = store.get(currentThreadIdAtom);

    // ── STEP 2: AUTHORITATIVE re-read ───────────────────────────────────────
    const oldHtml: string = item.getNote();

    // ── STEP 3: NO AWAITS BELOW THIS LINE UNTIL AFTER setNote() ─────────────
    const normalizedOldHtml = normalizeNoteHtml(oldHtml);
    const existingCitationCache = extractDataCitationItems(normalizedOldHtml);
    const strippedHtml = stripDataCitationItems(normalizedOldHtml);
    const { simplified, metadata } = getOrSimplify(noteId, oldHtml, resolvedLibraryId, pageLabelsByItemId);

    const soleRewrite = isSoleWholeBodyRewrite(edits);
    const preWindow: ReadWindow | null = soleRewrite
        ? EMPTY_READ_WINDOW
        : verifyAddressSnapshot(snapshot as string, simplified);
    if (!preWindow) {
        // Approval-delay drift. Hand back the CURRENT note so the model can
        // re-address without a follow-up read_note round trip.
        return executeError(
            request.request_id, SNAPSHOT_MISMATCH_MESSAGE, 'snapshot_mismatch',
            buildInlineNoteState(simplified),
        );
    }

    // `address_pre_snapshot` reproduces the token the edits were addressed
    // against (same window), so a consumer can confirm the action ran on the
    // numbering the model used. For a `block: 'all'` rewrite there is no token,
    // so the canonical empty window is used.
    const addressPreSnapshot = buildAddressSnapshot(simplified, preWindow);

    let newStrippedHtml: string;
    let undoDrafts: BatchUndoDraft[];
    let skippedOut: EditNoteBlocksSkippedEdit[] = [];
    let undo: EditNoteBlocksUndoRecord[];

    // `applied[]` has ONE construction site (below, after the post-edit
    // re-simplification), because its two inputs become available at different
    // times: the numeric path derives `blocks` from pre-edit arithmetic, while a
    // whole-body rewrite cannot know its own block count until the note has been
    // written and re-simplified. Each branch therefore contributes the identities
    // plus a resolver for the advisory ranges, and neither builds the array or
    // patches it afterwards.
    let appliedIdentities: Array<{ index: number; client_item_id?: string }>;
    let resolveAppliedBlocks: (postTotalLines: number) => Map<number, string>;
    const warnings: string[] = [...labels.locatorWarnings];
    const degrade = makeCitationDegrader(degrades, metadata);

    if (soleRewrite) {
        const edit = edits[0];
        const rawContent = edit.content ?? '';
        const pre = degrade(rawContent);
        warnings.push(...pre.warnings);
        let expandedNew: string;
        try {
            expandedNew = expandToRawHtml(
                pre.content, metadata, 'new', externalRefContext,
                labels.pageLabels, labels.resolvedLocatorPages,
            );
        } catch (e: any) {
            return executeError(request.request_id, e?.message || String(e), 'expansion_failed');
        }
        newStrippedHtml = buildRewrittenNoteBody(strippedHtml, expandedNew);

        // Re-classify against the note as it stands NOW (same TOCTOU rule the
        // batch executor applies at its rewrite gate).
        if (destructive_rewrite !== true) {
            const currentRisk = assessNoteRewrite(strippedHtml, newStrippedHtml);
            if (currentRisk.isDestructive) {
                logger(
                    `executeEditNoteBlocksAction: block:"all" rewrite of ${noteId} became destructive `
                    + `(${currentRisk.reason}) after validation — refusing unapproved rewrite`,
                    1,
                );
                return executeError(request.request_id, EXECUTE_DESTRUCTIVE_REFUSAL, 'note_changed');
            }
        }

        // A whole-body rewrite has no bounded region to diff against, so undo
        // stores the FULL pre-edit stripped body.
        undoDrafts = [];
        appliedIdentities = [{
            index: edit.index,
            ...(edit.client_item_id !== undefined ? { client_item_id: edit.client_item_id } : {}),
        }];
        // The rewrite produced the whole new body, so its advisory range is the
        // whole post-edit note — knowable only after the re-simplification.
        resolveAppliedBlocks = (postTotalLines: number) => new Map([
            [edit.index, postTotalLines > 0 ? `1-${postTotalLines}` : ''],
        ]);
        undo = [{
            index: edit.index,
            ...(edit.client_item_id !== undefined ? { client_item_id: edit.client_item_id } : {}),
            op: 'replace',
            undo_old_html: strippedHtml,
        }];
        const dup = checkDuplicateCitations(rawContent, metadata);
        if (dup) warnings.push(dup);
    } else {
        const selection = runBlockSelection(
            simplified, strippedHtml, metadata, edits, preWindow,
            externalRefContext, labels, degrades,
        );
        if ('refusal' in selection) {
            return executeError(request.request_id, selection.refusal.error, selection.refusal.errorCode);
        }
        if (selection.applied.length === 0) {
            return executeError(
                request.request_id,
                `None of the ${edits.length} edit(s) could be applied to the note as it now stands `
                + `(edit ${selection.skipped[0]?.index}: ${selection.skipped[0]?.reason ?? 'no reason recorded'}).`,
                'no_applicable_edits',
            );
        }
        warnings.push(...selection.warnings);

        const applyResult = applyResolvedEdits(strippedHtml, selection.resolvedEdits);
        newStrippedHtml = applyResult.newStrippedHtml;
        undoDrafts = applyResult.undoDrafts;

        // TOCTOU destructiveness re-check on THIS selection.
        if (destructive_rewrite !== true) {
            const currentRisk = assessNoteRewrite(strippedHtml, newStrippedHtml);
            if (currentRisk.isDestructive) {
                logger(
                    `executeEditNoteBlocksAction: block edit set on ${noteId} became destructive `
                    + `(${currentRisk.reason}) after validation — refusing unapproved edit`,
                    1,
                );
                return executeError(request.request_id, EXECUTE_DESTRUCTIVE_REFUSAL, 'note_changed');
            }
        }

        const shifts = buildBlockShiftModel(selection.applied);
        appliedIdentities = selection.applied.map((a) => ({
            index: a.resolved.index,
            ...(a.resolved.client_item_id !== undefined ? { client_item_id: a.resolved.client_item_id } : {}),
        }));
        // Pre-edit arithmetic — computed here, while the pre-edit index is still
        // in scope, and simply handed over to the single construction site.
        const producedRanges = new Map<number, string>(
            selection.applied.map((a) => [a.resolved.index, formatBlockRange(shifts.producedRange(a))]),
        );
        resolveAppliedBlocks = () => producedRanges;

        const editByIndex = new Map<number, EditNoteBlocksEditItem>();
        for (const edit of edits) editByIndex.set(edit.index, edit);
        skippedOut = selection.skipped.map((s) => {
            const address = addressedBlocks(editByIndex.get(s.index)!);
            const hint = address
                ? { from: shifts.shift(address.from), to: shifts.shift(address.to) }
                : null;
            const hintString = hint && (hint.from !== address!.from || hint.to !== address!.to)
                ? formatBlockRange(hint)
                : '';
            return {
                index: s.index,
                ...(s.client_item_id !== undefined ? { client_item_id: s.client_item_id } : {}),
                reason_code: s.reason_code,
                reason: s.reason,
                ...(s.actual !== undefined ? { actual: s.actual } : {}),
                ...(hintString ? { block_hint: hintString } : {}),
            };
        });

        undo = undoDrafts.map((d) => ({
            index: d.index,
            ...(d.client_item_id !== undefined ? { client_item_id: d.client_item_id } : {}),
            op: (editByIndex.get(d.index)?.op ?? 'replace'),
            undo_old_html: d.undo_old_html,
            undo_new_html: d.undo_new_html,
            ...(d.undo_before_context !== undefined ? { undo_before_context: d.undo_before_context } : {}),
            ...(d.undo_after_context !== undefined ? { undo_after_context: d.undo_after_context } : {}),
        }));

        for (const edit of edits) {
            if (typeof edit.content !== 'string') continue;
            const dup = checkDuplicateCitations(edit.content, metadata);
            if (dup) warnings.push(dup);
        }
    }

    let newHtml = newStrippedHtml;
    if (threadId) newHtml = addOrUpdateEditFooter(newHtml, threadId);
    newHtml = rebuildDataCitationItems(newHtml, existingCitationCache);

    const hadSchemaVersion = hasSchemaVersionWrapper(strippedHtml);
    if (hadSchemaVersion && !hasSchemaVersionWrapper(newHtml)) {
        return executeError(request.request_id, 'The note wrapper <div data-schema-version="..."> must not be removed.', 'wrapper_removed');
    }

    checkAborted(ctx, 'edit_note_blocks:before_save');

    try {
        assertNoPreviewMarkers(newHtml, 'editNoteBlocks:apply');
        item.setNote(newHtml);
        // ── END OF THE NO-AWAIT CRITICAL SECTION ────────────────────────────
        await item.saveTx();
        logger(`executeEditNoteBlocksAction: Saved ${appliedIdentities.length} block edit(s) to ${noteId}`, 1);
    } catch (error) {
        try {
            assertNoPreviewMarkers(oldHtml, 'editNoteBlocks:rollback');
            item.setNote(oldHtml);
        } catch (_) { /* best-effort */ }
        if (error instanceof TimeoutError) throw error;
        return executeError(request.request_id, `Failed to save note: ${error}`, 'save_failed');
    }

    await waitForNoteSaveStabilization(item, newHtml);
    clearNoteEditorSelection(resolvedLibraryId, zotero_key);
    invalidateSimplificationCache(noteId);

    // Refresh undo contexts against the final (post-footer, PM-normalized) HTML.
    const finalRawHtml = getLatestNoteHtml(item);
    if (undoDrafts.length > 0) {
        captureUndoContexts(stripDataCitationItems(finalRawHtml), undoDrafts, newStrippedHtml);
        const priorUndo = new Map(undo.map((u) => [u.index, u]));
        undo = undoDrafts.map((d) => ({
            ...(priorUndo.get(d.index) ?? { index: d.index, op: 'replace' as const }),
            undo_old_html: d.undo_old_html,
            undo_new_html: d.undo_new_html,
            ...(d.undo_before_context !== undefined ? { undo_before_context: d.undo_before_context } : {}),
            ...(d.undo_after_context !== undefined ? { undo_after_context: d.undo_after_context } : {}),
        }));
    }

    // Re-simplify for the post-edit numbering.
    const postPageLabels = await preloadNotePageLabels(finalRawHtml, resolvedLibraryId, { extractOnCacheMiss: true });
    const { simplified: postSimplified } = getOrSimplify(noteId, finalRawHtml, resolvedLibraryId, postPageLabels);
    const refreshedNote = buildInlineNoteState(postSimplified);

    // The single construction site for `applied[]` (see `appliedIdentities`).
    const appliedBlocks = resolveAppliedBlocks(refreshedNote.total_lines);
    const applied: EditNoteBlocksAppliedEdit[] = appliedIdentities.map((identity) => ({
        ...identity,
        blocks: appliedBlocks.get(identity.index) ?? '',
    }));

    const resultData: EditNoteBlocksResultData = {
        library_id: resolvedLibraryId,
        zotero_key,
        library_ref: libraryRefForLibraryID(resolvedLibraryId) ?? undefined,
        address_pre_snapshot: addressPreSnapshot,
        address_post_snapshot: refreshedNote.snapshot,
        applied,
        skipped: skippedOut,
        ...(warnings.length > 0 ? { warnings } : {}),
        undo,
    };

    return {
        type: 'agent_action_execute_response',
        request_id: request.request_id,
        success: true,
        result_data: resultData as unknown as Record<string, any>,
        // TRANSPORT-ONLY. Deliberately NOT copied into `result_data`: a stored
        // copy of the note body would go stale on the next edit.
        refreshed_note: refreshedNote,
    };
}

export { validateEditNoteBlocksAction, executeEditNoteBlocksAction };

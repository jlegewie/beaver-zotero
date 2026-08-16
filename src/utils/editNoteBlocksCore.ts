/**
 * Pure addressing / selection engine for `edit_note_blocks`.
 *
 * `read_note` shows the model a SIMPLIFIED projection of a note and numbers its
 * lines. `edit_note_blocks` addresses those line numbers. This module turns a
 * block number into a byte range in the raw (normalized, data-citation-items
 * stripped) note HTML, decides which edits are safe to apply, and emits the
 * `edit_note_batch` engine's own shapes (`ResolvedBatchEdit` / `BatchApplyOp`)
 * so `applyResolvedEdits` and `captureUndoContexts` work on block edits
 * UNCHANGED. There is no adapter and no second apply path.
 *
 * The three pieces:
 *   1. {@link buildBlockRawIndex}   block number → raw char range (or refuse)
 *   2. {@link verifyLineProjection} per-line, token-aware alignment check
 *   3. {@link selectBlockEdits}     per-edit gates → splices + per-edit skips
 *
 * Purity contract (identical to `editNoteBatchCore.ts`): no `Zotero.*`, no
 * `react/*` value imports, no async, no store/atoms. Every Zotero-touching input
 * (metadata, page labels, external refs) is pre-resolved by the caller.
 *
 * `editNoteMatcher.ts` is deliberately NOT a dependency: with no string-addressed
 * operation, every splice is located by block number alone.
 */

import type { SimplificationMetadata, StoredElement } from './noteHtmlSimplifier';
import type { PageLabelsByAttachmentId } from '@beaver/agent-core/citations/atoms';
import type {
    EditNoteBlocksOp,
    EditNoteBlocksSkipReasonCode,
} from '@beaver/agent-core/types/agentActions/editNoteBlocks';
import type { BatchApplyOp, ResolvedBatchEdit, ResolvedRange } from './editNoteBatchCore';
import { findNoteWrapperBounds } from './noteWrapper';
import { parseCreatedFooter, parseEditFooter } from './noteEditFooter';
import {
    decodeHtmlEntities,
    foldTypographicQuotes,
    isCjkChar,
    normalizeWS,
    unescapeAttr,
} from './noteHtmlEntities';
import {
    expandToRawHtml,
    type ExternalRefContext,
    type ResolvedLocatorPages,
} from './noteCitationExpand';

// =============================================================================
// Public types
// =============================================================================

/** A half-open character range. */
export interface CharRange {
    start: number;
    end: number;
}

/** Kind of opaque span whose lines are not individually editable in v1. */
export type OpaqueSpanKind = 'annotation' | 'math' | 'pre';

/**
 * An opaque span, recorded in SIMPLIFIED COORDINATES ONLY.
 *
 * There is deliberately no raw-side extent and no raw/simplified pairing step:
 * an earlier design scanned both strings and paired spans by document order,
 * which is the likeliest silent-corruption bug this design can have. Every
 * splice is located by whole raw LINES from {@link BlockRawIndex.rawLineRanges},
 * and every span rule is a containment question over simplified LINES.
 */
export interface OpaqueSpan {
    kind: OpaqueSpanKind;
    /** Char offsets within `simplified`. */
    start: number;
    end: number;
    /** 1-based block numbers the span touches (inclusive). */
    startLine: number;
    endLine: number;
}

/** Block-number → raw-byte mapping for one note snapshot. */
export interface BlockRawIndex {
    /** The exact simplified projection the block numbers refer to. */
    simplified: string;
    /** `simplified.split('\n')`; `simplifiedLines[n - 1]` is block `n`. */
    simplifiedLines: readonly string[];
    /** The raw haystack (`stripDataCitationItems(normalizeNoteHtml(rawHtml))`). */
    strippedHtml: string;
    metadata: SimplificationMetadata;
    /** Offset just past the wrapper's opening `<div …>`, in `strippedHtml`. */
    bodyStart: number;
    /** Offset of the wrapper's closing `</div>`, in `strippedHtml`. */
    bodyEnd: number;
    /**
     * Raw char range of every KEPT line, in block order. `rawLineRanges[n - 1]`
     * is block `n`; a range excludes its terminating `\n`. The trailing empty
     * simplified line is the last entry (a zero-width range at {@link bodyEnd}).
     */
    rawLineRanges: readonly CharRange[];
    /**
     * `seamCrossesSkippedLine[i]` is true when at least one SKIPPED (Beaver
     * footer) raw line sits between kept block `i + 1` and kept block `i + 2`.
     * A delete range spanning such a seam is refused, never split.
     */
    seamCrossesSkippedLine: readonly boolean[];
    /**
     * Where "append at the end of the body" splices.
     *
     * NOT `bodyEnd`, and NOT `getBeaverFooterAppendPoint`. `bodyEnd` is where
     * the trailing empty line sits, which is BELOW any trailing Beaver footer
     * paragraph — appending there puts user content permanently underneath
     * "Created by Beaver" (the edit footer self-heals because
     * `addOrUpdateEditFooter` re-appends it at save time; the created footer
     * never moves). `getBeaverFooterAppendPoint` gets the position right but
     * re-derives it with an independent `min(created, edit)` scan over
     * differently-normalized bytes, which is exactly the disagreement source
     * this design removes.
     *
     * So it is derived from THE WALK'S OWN data: scan the body lines backwards
     * from the end, stepping over the trailing empty line and then over any run
     * of footer-skipped lines, and stop at the first real content line. A
     * MID-document footer cannot affect the result, because the scan stops at
     * the first non-footer line it meets.
     */
    bodyAppendPoint: number;
    /**
     * True when an append at {@link bodyAppendPoint} must be written as
     * `'\n' + content` (the point is the END of a content line); false when it
     * must be written as `content + '\n'` (the point is {@link bodyStart},
     * because the body holds nothing but footers).
     */
    bodyAppendLeadingNewline: boolean;
    /** Block number the append lands after (`0` when it lands at `bodyStart`). */
    bodyAppendAnchorBlock: number;
    /** Raw ranges of the Beaver footers that were skipped, for diagnostics. */
    footerRanges: readonly CharRange[];
    /** Opaque spans in simplified coordinates (see {@link OpaqueSpan}). */
    spans: readonly OpaqueSpan[];
}

/** Whole-call refusal. The only error code this module ever raises call-wide. */
export interface BlockAddressRefusal {
    ok: false;
    error: string;
    errorCode: 'address_resolution_failed';
}

export type BuildBlockRawIndexResult =
    | { ok: true; index: BlockRawIndex }
    | BlockAddressRefusal;

/** One block edit to consider, in request order. */
export interface BlockEditSpec {
    index: number;
    client_item_id?: string;
    op: EditNoteBlocksOp;
    block?: number;
    after?: number;
    to?: number;
    expect?: string;
    expect_end?: string;
    content?: string;
}

/** One edit that was not applied. Mirrors `EditNoteBlocksSkippedEdit`. */
export interface BlockEditSkip {
    index: number;
    client_item_id?: string;
    reason_code: EditNoteBlocksSkipReasonCode;
    reason: string;
    /** Whitespace-collapsed simplified text actually at the addressed position. */
    actual?: string;
}

/**
 * One edit that WILL be applied, plus the arithmetic step 5 needs for advisory
 * `block_hint`s.
 *
 * With `D` = the running sum of (`producedBlocks` - `consumedBlocks`) over every
 * earlier applied edit, this edit's post-edit blocks are
 *   - `consumedBlocks > 0` (replace/delete): `[anchorBlock + D, anchorBlock + D + producedBlocks - 1]`
 *   - `consumedBlocks === 0` (insert):       `[anchorBlock + D + 1, anchorBlock + D + producedBlocks]`
 */
export interface SelectedBlockEdit {
    /** The batch engine's own resolved shape; feed straight to `applyResolvedEdits`. */
    resolved: ResolvedBatchEdit;
    op: EditNoteBlocksOp;
    /** First pre-edit block of the changed region (`0` for `prepend`). */
    anchorBlock: number;
    /**
     * Pre-edit blocks consumed: 1 for replace, `to - from + 1` for delete, 0 for
     * `insert` / `prepend` / `append`.
     */
    consumedBlocks: number;
    /** Blocks the replacement contributes at that position (0 for delete). */
    producedBlocks: number;
}

export type SelectBlockEditsResult =
    | { ok: true; applied: SelectedBlockEdit[]; skipped: BlockEditSkip[]; unverifiedBlocks: number[] }
    | BlockAddressRefusal;

/** Shared inputs for one selection pass. */
export interface SelectBlockEditsContext {
    index: BlockRawIndex;
    externalRefContext?: ExternalRefContext;
    pageLabels?: PageLabelsByAttachmentId;
    resolvedLocatorPages?: ResolvedLocatorPages;
    /**
     * Optional caller hook applied to `content` BEFORE expansion, so the action
     * layer can plug in Zotero-dependent content checks without this module
     * knowing about Zotero. Returning `error` rejects the edit — the caller uses
     * this to refuse a citation whose item cannot be resolved rather than let a
     * bare identifier reach the note.
     */
    preprocessContent?: (content: string) => {
        content: string;
        warnings: string[];
        error?: string;
    };
}

// Shared tail for every rewrite fallback: `op:"rewrite"` permanently deletes
// whatever `content` omits, so a partially-read note must not be rewritten.
const REWRITE_FALLBACK =
    'read the FULL note with read_note first, then send a sole op:"rewrite" edit '
    + 'carrying the entire note body';

// =============================================================================
// PART 1 — index construction
// =============================================================================

/**
 * CORE PRECONDITION OF THIS WHOLE MODULE.
 *
 * THE GENERAL INVARIANT: for every element the simplifier substitutes, the
 * newline COUNT of its stored `rawHtml` must equal the newline count of the
 * token that replaced it.
 *
 * Block addressing rests on raw line `n` and simplified line `n` being the same
 * line of the same document, and that is exactly what this invariant buys. The
 * looser phrasing "no substitution changes newlines" is not enough and invites a
 * future pass that breaks this quietly: several passes DISCARD the inner HTML
 * they matched — the `zotero-citation-link` pass drops the anchor's inner text
 * (`noteHtmlSimplifier.ts:393-397`) and the citation pass drops the citation's
 * visible content (`:271-372`) — so an element that spanned a newline would lose
 * that newline and shift every later block by one.
 *
 * How today's element classes satisfy it, and hence what the check below can
 * enforce:
 *
 * - CITATIONS, COMPOUND CITATIONS, LINKS, IMAGES and ANNOTATION-IMAGES are
 *   replaced by SINGLE-LINE, self-closing tokens (`<citation …/>`, `<link …/>`,
 *   `<image …/>`, `<annotation-image …/>`), whose newline count is 0. The
 *   invariant therefore reduces, for these, to "`rawHtml` must contain no
 *   newline" — which is what makes a newline in their `rawHtml` a violation.
 * - ANNOTATIONS are replaced by `<annotation …>${originalText}</annotation>`,
 *   which EMBEDS the inner text verbatim. Their token's newline count is
 *   whatever `originalText`'s is, so newlines inside the inner text are matched
 *   one-for-one and the invariant holds. Newlines anywhere ELSE in the raw
 *   `<span class="highlight" …>` wrapper are discarded and so still violate it.
 *   {@link isNewlineSafeAnnotation} is therefore NOT an exception to the rule —
 *   it is the same rule, evaluated against a token that is not single-line.
 * - DISPLAY MATH and `<pre>` are outside this check entirely: the math pass
 *   returns its captured content verbatim (`:448-456`) so its newline count is
 *   trivially unchanged, and `<pre>` is not rewritten at all. Neither is stored
 *   in `SimplificationMetadata`.
 *
 * Measured 0 violations across 473 real notes. A violation must therefore
 * surface as a LOUD REFUSAL, never as a misalignment, which is what this check
 * and the walk's count postcondition are for.
 */
function checkNoRewrittenElementSpansNewline(
    metadata: SimplificationMetadata,
): string | null {
    for (const [key, stored] of metadata.elements) {
        if (!stored.rawHtml.includes('\n')) continue;
        if (isNewlineSafeAnnotation(stored)) continue;
        return (
            `Cannot address this note by block number: the note element "${key}" spans a line `
            + 'break in the stored note HTML, which the simplified projection does not preserve, '
            + 'so simplified line numbers cannot be mapped back to the note reliably. '
            + `Instead: ${REWRITE_FALLBACK}.`
        );
    }
    return null;
}

/**
 * An annotation whose ONLY newlines are inside its preserved inner text — i.e.
 * one that SATISFIES the general newline-count invariant above, because the
 * `<annotation>` token embeds that same inner text verbatim. Newlines outside
 * the inner text are discarded with the raw wrapper and are still violations.
 */
function isNewlineSafeAnnotation(stored: StoredElement): boolean {
    if (stored.type !== 'annotation') return false;
    const inner = stored.originalText;
    if (!inner || !inner.includes('\n')) return false;
    const at = stored.rawHtml.indexOf(inner);
    if (at === -1) return false;
    const outside = stored.rawHtml.slice(0, at) + stored.rawHtml.slice(at + inner.length);
    return !outside.includes('\n');
}

function refuse(error: string): BlockAddressRefusal {
    return { ok: false, error, errorCode: 'address_resolution_failed' };
}

/**
 * Map every simplified block number to a character range in `strippedHtml`.
 *
 * `strippedHtml` must be the same haystack the batch engine uses —
 * `stripDataCitationItems(normalizeNoteHtml(rawHtml))` — and `simplified` /
 * `metadata` must come from `simplifyNoteHtml` on the SAME raw note.
 *
 * Refuses (whole-call `address_resolution_failed`) rather than guessing whenever
 * the two sides cannot be shown to line up. There is deliberately no fallback:
 * a misaligned splice corrupts the note silently, a refusal costs one round trip.
 */
export function buildBlockRawIndex(
    simplified: string,
    strippedHtml: string,
    metadata: SimplificationMetadata,
): BuildBlockRawIndexResult {
    const preconditionError = checkNoRewrittenElementSpansNewline(metadata);
    if (preconditionError) return refuse(preconditionError);

    // ── 1a. Body window ──────────────────────────────────────────────────────
    // No wrapper → no body window → refuse. There is NO zero-prefix fallback:
    // without the wrapper strip, `<div …>` and `</div>` would themselves become
    // addressable blocks and `replace block 1` would destroy the wrapper.
    const bounds = findNoteWrapperBounds(strippedHtml);
    if (!bounds) {
        return refuse(
            'Cannot address this note by block number: its stored HTML has no recognizable '
            + '<div data-schema-version="…"> wrapper, so the editable body cannot be located. '
            + `Instead: ${REWRITE_FALLBACK}.`,
        );
    }
    const { bodyStart, bodyEnd } = bounds;

    // Footers are detected ONCE, POST-NORMALIZE, on `strippedHtml` itself, so
    // their offsets are already in the coordinate space the walk uses. This is
    // the ONLY footer mechanism in the addressing path.
    //
    // There is deliberately no pre-normalize strip count. It is provably always
    // 0 — both strippers replace the footer `<p>…</p>` with `''` and never
    // consume the surrounding newline (`noteEditFooter.ts:222-224` and
    // `:230-236`) — so a walk conditioned on it would refuse every note Beaver
    // has ever touched. The real 1–2 line displacement comes from
    // `normalizeNoteHtml`'s ProseMirror roundtrip and is visible only
    // post-normalize.
    const footerRanges: CharRange[] = [];
    const editFooter = parseEditFooter(strippedHtml);
    if (editFooter) footerRanges.push({ start: editFooter.startIndex, end: editFooter.endIndex });
    const createdFooter = parseCreatedFooter(strippedHtml);
    if (createdFooter) footerRanges.push({ start: createdFooter.startIndex, end: createdFooter.endIndex });

    // ── 1b. The single skipping walk ────────────────────────────────────────
    // Every body line is recorded, kept or skipped: the kept ones become the
    // block index, and the full list is what the append point is derived from
    // below, so nothing has to re-scan the note.
    interface BodyLine extends CharRange {
        skipped: boolean;
        /** 1-based block number, or 0 for a skipped line. */
        blockNumber: number;
    }
    const bodyLines: BodyLine[] = [];
    const rawLineRanges: CharRange[] = [];
    const seamCrossesSkippedLine: boolean[] = [];
    let pendingSkipBeforeNextKept = false;

    let pos = bodyStart;
    for (;;) {
        const nl = strippedHtml.indexOf('\n', pos);
        const lineEnd = nl === -1 || nl > bodyEnd ? bodyEnd : nl;

        // ONLY footer-claimed lines may be skipped. Blank lines, whitespace-only
        // lines and everything else are ordinary kept lines: treating them as
        // skippable would trade a loud refusal for a silent misalignment.
        const skipped = footerRanges.some((f) => pos < f.end && f.start < lineEnd);
        if (skipped) {
            pendingSkipBeforeNextKept = true;
            bodyLines.push({ start: pos, end: lineEnd, skipped: true, blockNumber: 0 });
        } else {
            if (rawLineRanges.length > 0) seamCrossesSkippedLine.push(pendingSkipBeforeNextKept);
            pendingSkipBeforeNextKept = false;
            rawLineRanges.push({ start: pos, end: lineEnd });
            bodyLines.push({ start: pos, end: lineEnd, skipped: false, blockNumber: rawLineRanges.length });
        }

        if (lineEnd >= bodyEnd) break;
        pos = lineEnd + 1;
    }

    // ── The append point (see BlockRawIndex.bodyAppendPoint) ────────────────
    // Walk backwards over the trailing empty line, then over the trailing run of
    // footer lines, and stop at the first real content line. Stopping at the
    // FIRST non-footer line is what makes a mid-document footer irrelevant here.
    let appendAt = bodyLines.length - 1;
    if (appendAt >= 0 && bodyLines[appendAt].start === bodyLines[appendAt].end) appendAt--;
    while (appendAt >= 0 && bodyLines[appendAt].skipped) appendAt--;

    const bodyAppendPoint = appendAt >= 0 ? bodyLines[appendAt].end : bodyStart;
    const bodyAppendLeadingNewline = appendAt >= 0;
    const bodyAppendAnchorBlock = appendAt >= 0 ? bodyLines[appendAt].blockNumber : 0;

    // ── Postcondition: a pure same-space count ──────────────────────────────
    // The walk consumed every line up to `bodyEnd`, so this single comparison
    // catches drift in BOTH directions: a footer the post-normalize detectors
    // miss leaves one range too many; a footer only the post-normalize side
    // recognizes leaves one range short. Unmodelled trailing content is a kept
    // line, so it shows up here too — no remainder check and no separate bounds
    // guard are needed. Never guess, never fall back to a zero-skip walk.
    const simplifiedLines = simplified.split('\n');
    if (rawLineRanges.length !== simplifiedLines.length) {
        return refuse(
            'Cannot address this note by block number: the note\'s stored HTML has '
            + `${rawLineRanges.length} addressable line(s) but the simplified view has `
            + `${simplifiedLines.length}, so block numbers cannot be mapped back to the note `
            + `reliably. Instead: ${REWRITE_FALLBACK}.`,
        );
    }

    const spans = scanOpaqueSpans(simplified, simplifiedLines);

    return {
        ok: true,
        index: {
            simplified,
            simplifiedLines,
            strippedHtml,
            metadata,
            bodyStart,
            bodyEnd,
            rawLineRanges,
            seamCrossesSkippedLine,
            bodyAppendPoint,
            bodyAppendLeadingNewline,
            bodyAppendAnchorBlock,
            footerRanges,
            spans,
        },
    };
}

// =============================================================================
// 1c. Span scan — SIMPLIFIED SPACE ONLY
// =============================================================================

const PRE_SPAN_RE = /<pre\b[^>]*>[\s\S]*?<\/pre>/g;
const ANNOTATION_SPAN_RE = /<annotation\b[^>]*>[\s\S]*?<\/annotation>/g;
/**
 * Display math, anchored to WHOLE LINES.
 *
 * The simplifier only produces `$$…$$` by unwrapping `<pre class="math">`, a
 * block element that always occupies its own line(s), so a genuine display-math
 * span starts at a line start and ends at a line end. Requiring that is what
 * keeps ordinary prose from being mistaken for math: an unanchored
 * `/\$\$[\s\S]+?\$\$/` pairs ANY two `$$`, so `<p>costs $$5 today</p>` +
 * `<p>and $$3 tomorrow</p>` would be recorded as one two-line math span and
 * every edit to either block would be refused `span_partial_edit`. That fails
 * safe, but it makes a `$`-heavy note unaddressable.
 */
const DISPLAY_MATH_RE = /(?<=^|\n)\$\$[\s\S]+?\$\$(?=\n|$)/g;

/**
 * Record opaque spans as CHARACTER ranges within `simplified`, plus the block
 * range they touch. Only MULTILINE spans impose restrictions; single-line spans
 * are recorded too (they are cheap and make the rules uniform) but never gate
 * anything.
 */
function scanOpaqueSpans(simplified: string, lines: readonly string[]): OpaqueSpan[] {
    // Cumulative start offset of each line, for offset → block lookup.
    const lineStarts: number[] = [];
    let acc = 0;
    for (const line of lines) {
        lineStarts.push(acc);
        acc += line.length + 1; // + '\n'
    }
    const lineOf = (offset: number): number => {
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        return lo + 1; // 1-based block number
    };

    const spans: OpaqueSpan[] = [];
    const add = (kind: OpaqueSpanKind, start: number, end: number) => {
        spans.push({ kind, start, end, startLine: lineOf(start), endLine: lineOf(end - 1) });
    };

    const collect = (re: RegExp, kind: OpaqueSpanKind) => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(simplified)) !== null) {
            add(kind, m.index, m.index + m[0].length);
        }
    };

    // `<pre>` first, so math can skip anything already covered: a plain code
    // block may contain literal `$$`, which is not math.
    //
    // This is belt-and-braces rather than the primary defense. Since
    // DISPLAY_MATH_RE was anchored to whole lines, a `$$` inside a `<pre>` no
    // longer matches in any shape the real pipeline produces (`<pre>$$` puts the
    // delimiter mid-line), so no test can observe the difference. Kept because
    // it costs nothing and stays correct if the anchoring is ever loosened.
    collect(PRE_SPAN_RE, 'pre');
    collect(ANNOTATION_SPAN_RE, 'annotation');

    const covered = spans.slice();
    DISPLAY_MATH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DISPLAY_MATH_RE.exec(simplified)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (covered.some((s) => start < s.end && s.start < end)) continue;
        add('math', start, end);
    }

    spans.sort((a, b) => a.start - b.start);
    return spans;
}

// =============================================================================
// 1d. Token-aware per-line projection verification
// =============================================================================

/**
 * A sentinel for a masked region. Contains a NUL, which cannot occur in note
 * HTML, and no angle brackets, whitespace or entity syntax — so it survives
 * tag-stripping, entity decoding and whitespace collapsing untouched.
 */
const MASK_SENTINEL = '\u0000M';

export type LineProjectionCheck =
    | { status: 'match' }
    | { status: 'unverified'; detail: string }
    | { status: 'mismatch'; detail: string };

/**
 * `<annotation-image …/>` MUST precede `<annotation …>`: `<annotation\b` also
 * matches at the start of `<annotation-image`, and would then run off looking
 * for a `</annotation>` that does not exist.
 */
const SIMPLIFIED_TOKEN_RE =
    /<annotation-image\b[^>]*\/>|<annotation\b[^>]*>[\s\S]*?<\/annotation>|<citation\b[^>]*\/>|<image\b[^>]*\/>|<link\b[^>]*\/>/g;

function attrOf(tag: string, name: string): string | null {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
    return m ? m[1] : null;
}

/** The `SimplificationMetadata.elements` key a simplified token was stored under. */
function metadataKeyForToken(token: string): string | null {
    if (token.startsWith('<citation')) return attrOf(token, 'ref');
    if (token.startsWith('<annotation-image')) return attrOf(token, 'id');
    if (token.startsWith('<annotation')) return attrOf(token, 'id');
    if (token.startsWith('<image')) return attrOf(token, 'id');
    if (token.startsWith('<link')) {
        // Link entries are keyed by the DECODED href, not by a `ref` in the tag.
        const href = attrOf(token, 'href');
        return href === null ? null : `link:${unescapeAttr(href)}`;
    }
    return null;
}

/**
 * Compare a MASKED visible-text projection of block `blockNumber`'s raw line
 * against the same masked projection of its simplified line.
 *
 * WHY MASKING IS LOAD-BEARING, NOT A REFINEMENT. A plain visible-text comparison
 * fails on 48% of real notes (229/473, 1741 lines) because raw and simplified
 * DELIBERATELY diverge on tokens: raw-side a citation is
 * `<span class="citation" data-citation="…">(Author, 2019, p. 2)</span>` (which
 * projects to visible text) while simplified-side it is `<citation …/>` (which
 * projects to nothing).
 *
 * WHY THE MASKING IS DRIVEN BY `SimplificationMetadata`, NOT BY TAG SHAPES. A
 * blanket "mask raw `<a …>…</a>` wherever simplified has a token" rule would
 * MANUFACTURE the failure class this check exists to prevent: every substitution
 * pass has a `return match` fallback, so most anchors are left verbatim in BOTH
 * strings — 599 anchors across 100 notes (21%) survive verbatim, chiefly
 * `<a href="zotero://open-pdf/…" rel="…">`, while the whole 482-note library
 * produces only 4 `<link/>` tokens. So: for each token present in the SIMPLIFIED
 * line, mask exactly its recorded `rawHtml` on the raw side and the token itself
 * on the simplified side; everything the simplifier left verbatim is compared
 * verbatim on both sides.
 *
 * MASK-MISS HARDENING. The metadata keys are not all unique — citations are
 * occurrence-counted (`c_${key}_${occ}`) but images (`i_…`), annotations
 * (`a_…`), annotation-images (`ai_…`) and links (`link:${href}`) are not, so two
 * occurrences of the same element overwrite one entry and the stored `rawHtml`
 * may not match an earlier occurrence's raw line. Measured 0 occurrences today —
 * latent, not active — but the failure mode would be a FALSE whole-call
 * `address_resolution_failed`. Required property: a mask miss must NEVER produce
 * a refusal. It degrades the line to `unverified`.
 *
 * HONEST STRENGTH STATEMENT. Masking the divergent regions means this check no
 * longer verifies exactly the bytes where raw and simplified differ most. It
 * still catches whole-line misalignment — the drift class it exists for — but it
 * is WEAKER than "the raw line equals the simplified line": it is NOT a second
 * independent guard and the collision argument must not lean on it. It is also
 * blind to the boundaries (the wrapper tag and `</div>` project to nothing;
 * footer lines sit outside the body window entirely), which is exactly why the
 * walk's count postcondition is separate and explicit.
 *
 * NOTE: this is a DIFFERENT and more delicate function than
 * {@link projectVisibleText}, which projects the simplified side only for the
 * `expect` contract. They are deliberately not shared.
 */
export function verifyLineProjection(
    index: BlockRawIndex,
    blockNumber: number,
): LineProjectionCheck {
    const range = index.rawLineRanges[blockNumber - 1];
    const simplifiedLine = index.simplifiedLines[blockNumber - 1];
    if (!range || simplifiedLine === undefined) {
        return { status: 'unverified', detail: `block ${blockNumber} is out of range` };
    }
    const rawLine = index.strippedHtml.slice(range.start, range.end);

    let maskedRaw = rawLine;
    let maskedSimplified = '';
    let simplifiedCursor = 0;
    let rawCursor = 0;

    SIMPLIFIED_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SIMPLIFIED_TOKEN_RE.exec(simplifiedLine)) !== null) {
        const token = m[0];
        const key = metadataKeyForToken(token);
        const stored = key === null ? undefined : index.metadata.elements.get(key);
        if (!stored) {
            return {
                status: 'unverified',
                detail: `no stored raw HTML for token ${key ?? token.slice(0, 40)}`,
            };
        }
        const at = maskedRaw.indexOf(stored.rawHtml, rawCursor);
        if (at === -1) {
            return {
                status: 'unverified',
                detail: `stored raw HTML for ${key} not found in the raw line (mask miss)`,
            };
        }
        maskedRaw = maskedRaw.slice(0, at) + MASK_SENTINEL + maskedRaw.slice(at + stored.rawHtml.length);
        rawCursor = at + MASK_SENTINEL.length;

        maskedSimplified += simplifiedLine.slice(simplifiedCursor, m.index) + MASK_SENTINEL;
        simplifiedCursor = m.index + token.length;
    }
    maskedSimplified += simplifiedLine.slice(simplifiedCursor);

    const rawProjection = projectVisibleText(maskedRaw);
    const simplifiedProjection = projectVisibleText(maskedSimplified);
    if (rawProjection === simplifiedProjection) return { status: 'match' };
    return {
        status: 'mismatch',
        detail:
            `block ${blockNumber}: note line projects to ${JSON.stringify(rawProjection.slice(0, 120))} `
            + `but the simplified line projects to ${JSON.stringify(simplifiedProjection.slice(0, 120))}`,
    };
}

// =============================================================================
// PART 2a — container classification (DEFAULT-DENY)
// =============================================================================

/**
 * Void elements are NOT stack participants. `<hr>` alone accounts for 360 lines
 * in the measured library: feeding it to the balance stack would mark any range
 * containing one as unbalanced and false-skip it.
 */
const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
    'param', 'source', 'track', 'wbr',
]);

/**
 * Paired elements that are INLINE and therefore not stack participants.
 *
 * `annotation` MUST be here. It is a paired tag the simplifier CREATES, so a
 * default-deny classifier would otherwise sweep it into the container set and a
 * partial range over a multiline annotation would report `unbalanced_range` —
 * contradicting the span rules, which promise `annotation_immutable` /
 * `span_partial_edit`. Latent today (0 multiline annotations measured), so it is
 * fixed by construction here AND by running the span rules before the structural
 * rules.
 */
const INLINE_ELEMENTS = new Set([
    'a', 'span', 'em', 'strong', 'b', 'i', 'u', 's', 'strike', 'code', 'sub',
    'sup', 'mark', 'small', 'abbr', 'cite', 'q', 'del', 'ins', 'samp', 'kbd',
    'var', 'time',
    'annotation',
]);

/**
 * Containers that admit ONLY structural children. An `insert` seam whose
 * innermost still-open container is one of these is refused.
 */
const STRUCTURAL_ONLY_CONTAINERS = new Set([
    'ul', 'ol', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'dl', 'colgroup',
]);

const TAG_RE_SOURCE = String.raw`<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>`;

/**
 * DEFAULT-DENY container test: anything that is neither void, nor self-closing,
 * nor a known inline element is a container. A future container element is
 * therefore covered without a code change.
 *
 * Self-closing tags are excluded, which covers every simplified token
 * (`<citation/>`, `<link/>`, `<image/>`, `<annotation-image/>`).
 */
export function isContainerTag(name: string, selfClosing: boolean): boolean {
    if (selfClosing) return false;
    const lower = name.toLowerCase();
    if (VOID_ELEMENTS.has(lower)) return false;
    if (INLINE_ELEMENTS.has(lower)) return false;
    return true;
}

interface ParsedTag {
    closing: boolean;
    name: string;
    selfClosing: boolean;
}

function* iterateTags(text: string): Generator<ParsedTag> {
    // A fresh regex per call: this is a generator, so a caller that breaks early
    // would otherwise leave a shared `lastIndex` behind for the next caller.
    const re = new RegExp(TAG_RE_SOURCE, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        yield { closing: m[1] === '/', name: m[2].toLowerCase(), selfClosing: m[3] === '/' };
    }
}

/**
 * Tag-balance test for a `delete` / `replace` range — a STACK check, NOT an
 * `opens === closes` count comparison.
 *
 * A count comparison accepts the exact worst case this rule exists to stop: a
 * delete covering exactly `</li>` + `<li>` — the seam between two list items —
 * is count-balanced, and removing it MERGES the two items' content, which is the
 * ProseMirror-restructuring hazard.
 *
 * This matters because the destructive-edit gate cannot see structural damage:
 * `assessNoteRewrite` reduces both sides through `toComparableText`
 * (`noteRewriteRisk.ts:43-51`), which strips ALL tags before the trigram
 * comparison, so a structure-destroying but text-preserving edit scores benign
 * and never escalates.
 */
export function isRangeBalanced(text: string): boolean {
    const stack: string[] = [];
    for (const tag of iterateTags(text)) {
        if (!isContainerTag(tag.name, tag.selfClosing)) continue;
        if (tag.closing) {
            if (stack.length === 0) return false;
            if (stack[stack.length - 1] !== tag.name) return false;
            stack.pop();
        } else {
            stack.push(tag.name);
        }
    }
    return stack.length === 0;
}

/**
 * The container stack that is still open after `lines[0 … upToLine - 1]`.
 * Unmatched closers are tolerated (they cannot occur in normalized note HTML,
 * and guessing here would be worse than ignoring them).
 */
function containerStackAfter(lines: readonly string[], upToLine: number): string[] {
    const stack: string[] = [];
    for (let i = 0; i < upToLine; i++) {
        for (const tag of iterateTags(lines[i])) {
            if (!isContainerTag(tag.name, tag.selfClosing)) continue;
            if (tag.closing) {
                const at = stack.lastIndexOf(tag.name);
                if (at !== -1) stack.length = at;
            } else {
                stack.push(tag.name);
            }
        }
    }
    return stack;
}

/**
 * True when an `insert` after block `afterBlock` would land between a
 * container's own structural lines (between `<tr>` and `<td>`, or between `<ul>`
 * and its first `<li>`).
 *
 * This also refuses the `</li>` | `<li>` seam. That is intended and anticipated;
 * the telemetry-gated relaxation is tracked separately.
 */
export function seamIsStructural(lines: readonly string[], afterBlock: number): boolean {
    const stack = containerStackAfter(lines, afterBlock);
    const innermost = stack[stack.length - 1];
    return innermost !== undefined && STRUCTURAL_ONLY_CONTAINERS.has(innermost);
}

// =============================================================================
// PART 2e — the `expect` contract
// =============================================================================

/**
 * Simplified-space visible-text projection: strip tags → decode entities →
 * collapse whitespace, IN THAT ORDER.
 *
 * The order is load-bearing: decoding first would turn a `&lt;` inside a code
 * block into a live `<` that tag-stripping then eats. (`decodeHtmlEntities`
 * deliberately leaves `&lt;` / `&gt;` / `&amp;` encoded, so this is belt and
 * braces — but the order is what makes it safe regardless.)
 */
export function projectVisibleText(s: string): string {
    return normalizeWS(decodeHtmlEntities(s.replace(/<[^>]*>/g, '')));
}

// `decodeHtmlEntities` deliberately leaves these three encoded so that decoding
// can never manufacture live markup. The `expect` comparison runs AFTER tags are
// already stripped and never re-strips, and it decodes BOTH sides identically,
// so folding them here is safe and closes the `&amp;` ↔ `&` drift class the
// single-string matcher covers with `entity_decode` / `entity_encode`.
//
// ONE ALTERNATION, ONE PASS — never a chain of `.replace()` calls. Sequential
// passes would decode one entity layer per pass, so `&amp;lt;` (a note that
// DISPLAYS the text `&lt;`) would collapse first to `&lt;` and then to `<`,
// making it compare equal to a note that displays `<`. Those are different
// visible texts, and `expect` is the only content guard on a replace.
const COMPARISON_ENTITY_RE = /&(amp|lt|gt);/g;
const COMPARISON_ENTITY_VALUES: Readonly<Record<string, string>> = {
    amp: '&',
    lt: '<',
    gt: '>',
};

function decodeComparisonEntities(s: string): string {
    return s.replace(COMPARISON_ENTITY_RE, (_match, name: string) => COMPARISON_ENTITY_VALUES[name]);
}

/**
 * Drop "Pangu" spaces — the optional space between an East Asian character and
 * an adjacent Latin/digit/punctuation character. Language models insert and drop
 * these silently when reproducing mixed-script text, so `共识 [14]` and
 * `共识[14]` must compare equal. Only spaces WITH a CJK character on exactly one
 * side are removed; ordinary word spacing is untouched.
 */
function stripPanguSpaces(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s.charAt(i);
        if (ch === ' ' && i > 0 && i < s.length - 1) {
            const before = s.charAt(i - 1);
            const after = s.charAt(i + 1);
            if (isCjkChar(before) !== isCjkChar(after) && !/\s/.test(before) && !/\s/.test(after)) {
                continue;
            }
        }
        out += ch;
    }
    return out;
}

/**
 * Canonical form used ONLY to compare an `expect` against a block's projection.
 *
 * Each fold mirrors a strategy the single-string matcher needs
 * (`editNoteMatcher.ts`): entity drift, CJK full-width drift (`nfkc`), quote
 * style (`quote_normalized`), and Pangu spacing (`whitespace_relaxed`). They are
 * safe to apply far more freely here than there: that matcher slices the raw
 * note at the match offset, so every transformation risks a corrupt splice,
 * whereas this function only ever decides a boolean — nothing is sliced out of
 * `expect`, and the bytes written to the note come from `content`. The only
 * thing spent is `expect`'s strength as a guard, and it is applied to both sides
 * identically, so two lines can only collide if they differ solely by these
 * folds.
 */
function canonicalizeForExpect(projection: string): string {
    return stripPanguSpaces(
        foldTypographicQuotes(decodeComparisonEntities(projection).normalize('NFKC')),
    );
}

/** Minimum non-whitespace characters an `expect` prefix must carry. */
const EXPECT_MIN_NON_WHITESPACE = 8;

function countNonWhitespace(s: string): number {
    let n = 0;
    for (const ch of s) if (!/\s/.test(ch)) n++;
    return n;
}

interface OutermostTag {
    closing: boolean;
    name: string;
}

/** The first tag of a line, attribute-stripped: `<p><citation/></p>` → `p`. */
function outermostTag(line: string): OutermostTag | null {
    const m = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b/.exec(line);
    return m ? { closing: m[1] === '/', name: m[2].toLowerCase() } : null;
}

/** Outcome of one `expect`-vs-line comparison. */
export type ExpectMatchOutcome = 'match' | 'mismatch' | 'too_short';

/**
 * Does `expect` confirm `line`?
 *
 * Two regimes, both in simplified space:
 *
 * 1. LINES WITH VISIBLE TEXT — `expect`'s projection must be a PREFIX of the
 *    line's projection (or, with `allowSuffix`, a SUFFIX — insert anchors say
 *    "after this block", so models naturally quote the END of the anchor's
 *    text), with a floor of {@link EXPECT_MIN_NON_WHITESPACE} non-whitespace
 *    characters (or the full projection when the projection is shorter). The
 *    model is NEVER required to reproduce a truncation boundary exactly. A
 *    correctly-placed but under-floor `expect` is reported as `too_short`
 *    rather than `mismatch`, so the skip message can name the actual fix.
 *
 * 2. LINES WITH NO VISIBLE TEXT — 55.9% of all lines in the measured library
 *    (`<li>` 2470, `</li>` 2470, `<td>`/`</td>` 584 each, `<ul>`/`</ul>` 486
 *    each, blank 478, `<hr>` 360, …). These are confirmed by their OUTERMOST
 *    TAG, ATTRIBUTE-STRIPPED: `<ul>`, `</li>`, `<hr>`, `<citation/>`, and `<p>`
 *    for `<p><citation/></p>`. NOT the full tag signature — requiring the model
 *    to reconstruct `<p><citation/></p>` from
 *    `<p><citation id="…" ref="…"/></p>` is a transformation, not a copy, and
 *    getting it wrong would re-manufacture the `expect_mismatch` failure class on
 *    exactly the lines that are hardest to describe. The comparison is on
 *    (isClosing, tagName), so a stray self-closing slash is forgiving while
 *    `<ul>` vs `</ul>` still fails loudly.
 *
 * An empty `expect` matches only a genuinely empty line (including the trailing
 * empty line).
 *
 * HONEST LIMITATION: on no-visible-text lines `expect` matches hundreds of
 * positions in the same note, so it is NOT the load-bearing guard — the snapshot
 * requirement is, together with the rule that `read_note` issues a snapshot ONLY
 * for a whole-note read (so a block number can never name a page the model was
 * not shown). A ranged `delete` likewise confirms only its two endpoints and
 * never its interior. On lines WITH visible text `expect` is strong (only 7.5%
 * of notes contain two content lines sharing a 40-character prefix).
 *
 * Both sides are additionally run through {@link canonicalizeForExpect}, which
 * folds the drift classes the single-string matcher needs dedicated strategies
 * for (entities, CJK full-width, quote style, Pangu spacing). That is applied
 * here rather than inside {@link projectVisibleText} on purpose:
 * `verifyLineProjection` must stay byte-strict.
 */
export function matchExpect(
    expect: string,
    line: string,
    opts?: { allowSuffix?: boolean },
): ExpectMatchOutcome {
    const lineProjection = canonicalizeForExpect(projectVisibleText(line));
    const expectProjection = canonicalizeForExpect(projectVisibleText(expect));

    if (lineProjection !== '') {
        // An expect with no visible text (empty, or tag-only) cannot confirm a
        // line that has some — `startsWith('')` is vacuously true, and calling
        // it `too_short` would claim a match that was never established and
        // steer the model toward lengthening a quote instead of re-reading.
        if (expectProjection === '') return 'mismatch';
        const placed = lineProjection.startsWith(expectProjection)
            || (!!opts?.allowSuffix && lineProjection.endsWith(expectProjection));
        if (!placed) return 'mismatch';
        if (expectProjection === lineProjection) return 'match';
        return countNonWhitespace(expectProjection) >= EXPECT_MIN_NON_WHITESPACE
            ? 'match'
            : 'too_short';
    }

    const lineTag = outermostTag(line);
    const expectTag = outermostTag(expect);
    if (lineTag === null) {
        // Genuinely empty (or whitespace-only) line.
        return expectTag === null && expectProjection === '' ? 'match' : 'mismatch';
    }
    if (expectTag === null) return 'mismatch';
    // An `expect` carrying visible text cannot be confirming a line that has
    // none. Without this, `expect: "<p>some prose I remember</p>"` passes
    // against `<p><citation id=… ref=…/></p>` purely because the outermost tags
    // agree — and on a `replace`, `expect` is the ONLY content guard, so a stale
    // block number pointing at a token-only paragraph would apply silently.
    if (expectProjection !== '') return 'mismatch';
    return expectTag.closing === lineTag.closing && expectTag.name === lineTag.name
        ? 'match'
        : 'mismatch';
}

// =============================================================================
// PART 3 — per-edit selection
// =============================================================================

const ACTUAL_MAX_LENGTH = 80;

function actualFor(index: BlockRawIndex, blockNumber: number): string | undefined {
    const line = index.simplifiedLines[blockNumber - 1];
    if (line === undefined) return undefined;
    const collapsed = normalizeWS(line);
    if (collapsed.length <= ACTUAL_MAX_LENGTH) return collapsed;
    return `${collapsed.slice(0, ACTUAL_MAX_LENGTH - 1)}…`;
}

/** Count of lines a replacement fragment occupies. */
function lineCount(s: string): number {
    return s.split('\n').length;
}

interface SkipDraft {
    reason_code: EditNoteBlocksSkipReasonCode;
    reason: string;
    actualBlock?: number;
}

/**
 * Drop one leading `Error: ` from a per-edit reason. The shared validator and
 * expander prefix their messages, which would render as
 * `Edit [0] (replace): Error: …`.
 */
export function stripErrorPrefix(reason: string): string {
    return reason.replace(/^\s*Error:\s*/, '');
}

function skip(
    reason_code: EditNoteBlocksSkipReasonCode,
    reason: string,
    actualBlock?: number,
): SkipDraft {
    return { reason_code, reason: stripErrorPrefix(reason), actualBlock };
}

function isBlockNumber(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

/**
 * Gate 1 — shape. Everything checkable without the note.
 */
function checkShape(spec: BlockEditSpec): SkipDraft | null {
    const { op } = spec;
    if (op === 'rewrite') {
        return skip(
            'invalid_edit',
            'op:"rewrite" is a whole-body rewrite and is not handled by the block-addressing '
            + 'engine. It must be sent as the sole edit in the request.',
        );
    }
    if (op !== 'replace' && op !== 'insert' && op !== 'prepend' && op !== 'append' && op !== 'delete') {
        return skip(
            'invalid_edit',
            `Unknown op "${String(op)}"; expected "replace", "insert", "prepend", "append", `
            + '"delete" or "rewrite".',
        );
    }

    // `prepend` / `append` address the note's absolute start and end. They name
    // no block, so every addressing field is a sign the caller meant `insert`.
    if (op === 'prepend' || op === 'append') {
        if (typeof spec.content !== 'string') {
            return skip('invalid_edit', `${op} requires \`content\` (the text to add, in simplified format).`);
        }
        const stray = (['block', 'after', 'to', 'expect', 'expect_end'] as const)
            .find((field) => spec[field] !== undefined);
        if (stray) {
            return skip(
                'invalid_edit',
                `\`${stray}\` is not valid for ${op} — it adds \`content\` at the `
                + `${op === 'prepend' ? 'start' : 'end'} of the note and addresses no block. `
                + 'Use op:"insert" with `after` and `expect` to add content next to a block.',
            );
        }
        return null;
    }

    if (op === 'replace') {
        if (!isBlockNumber(spec.block)) {
            return skip('invalid_edit', 'replace requires `block` — a 1-based integer block number.');
        }
        if (typeof spec.content !== 'string') {
            return skip('invalid_edit', 'replace requires `content` (the new text for the block, in simplified format).');
        }
        if (typeof spec.expect !== 'string') {
            return skip('invalid_edit', 'replace requires `expect` — the text you believe is currently at `block`.');
        }
        return null;
    }

    if (op === 'insert') {
        if (!isBlockNumber(spec.after)) {
            return skip(
                'invalid_edit',
                'insert requires `after` — a 1-based integer block number. To add content at the '
                + 'very start or end of the note, use op:"prepend" or op:"append" instead.',
            );
        }
        if (typeof spec.content !== 'string') {
            return skip('invalid_edit', 'insert requires `content` (the text to insert, in simplified format).');
        }
        // An insert overwrites no line, but its anchor still needs `expect` so an
        // off-by-one `after` is caught instead of silently placing content at the
        // wrong seam. Every `after` names a real block, so this is unconditional.
        if (typeof spec.expect !== 'string') {
            return skip('invalid_edit', 'insert requires `expect` — the text of the block you are inserting after.');
        }
        return null;
    }

    // delete
    if (!isBlockNumber(spec.block)) {
        return skip('invalid_edit', 'delete requires `block` — a 1-based integer block number.');
    }
    if (spec.to !== undefined && !isBlockNumber(spec.to)) {
        return skip('invalid_edit', '`to` must be a 1-based integer block number.');
    }
    const to = spec.to ?? spec.block;
    if (to < spec.block) {
        return skip('invalid_edit', `\`to\` (${to}) is before \`block\` (${spec.block}).`);
    }
    if (typeof spec.expect !== 'string') {
        return skip('invalid_edit', 'delete requires `expect` — the text you believe is currently at `block`.');
    }
    const isMultiLine = to > spec.block;
    if (isMultiLine && typeof spec.expect_end !== 'string') {
        return skip('invalid_edit', 'a multi-block delete requires `expect_end` — the text you believe is at `to`.');
    }
    if (!isMultiLine && spec.expect_end !== undefined) {
        return skip('invalid_edit', '`expect_end` is only valid when `to` is greater than `block`.');
    }
    return null;
}

/** Gate 2 — numeric bounds. */
function checkBounds(spec: BlockEditSpec, total: number): SkipDraft | null {
    const oor = (n: number, field: string) => skip(
        'block_out_of_range',
        `${field} ${n} does not exist; this note has ${total} block(s). `
        + `Address a block between 1 and ${total}.`,
    );
    // `prepend` / `append` address no block, so there is nothing to bound.
    if (spec.op === 'prepend' || spec.op === 'append') return null;
    if (spec.op === 'replace') {
        const block = spec.block as number;
        if (block > total) return oor(block, 'block');
        return null;
    }
    if (spec.op === 'insert') {
        const after = spec.after as number;
        if (after > total) return oor(after, 'after');
        return null;
    }
    const from = spec.block as number;
    const to = spec.to ?? from;
    if (from > total) return oor(from, 'block');
    if (to > total) return oor(to, 'to');
    return null;
}

/**
 * Gate 3 — a RANGE that would cross a footer-skipped line.
 *
 * REFUSED, never split into one splice per contiguous run. An earlier design
 * emitted N splices, which quietly broke the one-splice-per-edit invariant that
 * the flat preview pair and the single undo draft both rest on (an
 * under-captured undo fragment and a diff showing one of two runs). The
 * population is 1 note in 473 and the model's recovery is trivial, so the skip
 * message says exactly what to do instead.
 */
function checkSkippedLineCrossing(index: BlockRawIndex, from: number, to: number): SkipDraft | null {
    for (let i = from - 1; i <= to - 2; i++) {
        if (index.seamCrossesSkippedLine[i]) {
            return skip(
                'unaddressable_range',
                `Blocks ${from}–${to} span a hidden region of the note that is not addressable `
                + 'by block number. Issue one range per side of it instead — each range must land '
                + 'entirely on one side.',
                from,
            );
        }
    }
    return null;
}

/** Multiline spans touching block `n`. */
function multilineSpansAt(index: BlockRawIndex, n: number): OpaqueSpan[] {
    return index.spans.filter((s) => s.startLine !== s.endLine && s.startLine <= n && n <= s.endLine);
}

function spanSkipCode(kind: OpaqueSpanKind): EditNoteBlocksSkipReasonCode {
    return kind === 'annotation' ? 'annotation_immutable' : 'span_partial_edit';
}

/**
 * Gate 4 — opaque-span rules. Run BEFORE the structural rules, deliberately:
 * both can fire on a range over a multiline annotation, and the span code is the
 * correct, actionable one.
 *
 * v1 has NO interior carve-out: no line of a MULTILINE opaque span is editable,
 * interior lines included. What v1 gives up is editing INSIDE multiline math and
 * `<pre>` (multiline annotations are never editable); `op:"rewrite"` remains
 * available.
 *
 * Whole-element annotation editing is handled by a DIFFERENT mechanism that
 * already exists: `expandToRawHtml` verifies an annotation's inner text against
 * the stored `originalText` and re-expands the stored raw HTML
 * (`noteCitationExpand.ts:849-865`), and OMITTING an annotation from the content
 * deletes it. So a whole-line `replace` of a line holding a complete SINGLE-LINE
 * annotation stays allowed — the common "quoted highlight + citation + my
 * comment on one line" edit keeps working.
 *
 * There is deliberately NO raw-slice wrapper-balance check here. A previous
 * revision added one as belt-and-braces, but the container classifier excludes
 * `span`, so it silently skipped raw annotation wrappers
 * (`<span class="highlight" data-annotation=…>`) while checking
 * `<pre class="math">` — half-dead as written.
 */
function checkSpanRules(index: BlockRawIndex, spec: BlockEditSpec): SkipDraft | null {
    if (spec.op === 'replace') {
        const block = spec.block as number;
        const spans = multilineSpansAt(index, block);
        if (spans.length === 0) return null;
        const annotation = spans.find((s) => s.kind === 'annotation');
        const span = annotation ?? spans[0];
        const label = span.kind === 'annotation' ? 'an annotation' : span.kind === 'math' ? 'a display-math block' : 'a <pre> block';
        return skip(
            spanSkipCode(span.kind),
            `Block ${block} is part of ${label} that spans blocks ${span.startLine}–${span.endLine}. `
            + (span.kind === 'annotation'
                ? 'Annotation text cannot be edited; annotations may only be moved or deleted whole.'
                : `Replace the whole span in one edit, or rewrite the note: ${REWRITE_FALLBACK}.`),
            block,
        );
    }

    // `prepend` / `append` land at the body's outer edges, which cannot be
    // inside a span.
    if (spec.op === 'prepend' || spec.op === 'append') return null;

    if (spec.op === 'insert') {
        const after = spec.after as number;
        // A seam strictly inside a multiline span: blocks `after` and `after+1`
        // both belong to it. Seams at span boundaries are fine.
        const span = index.spans.find((s) => s.startLine <= after && after < s.endLine);
        if (!span) return null;
        return skip(
            spanSkipCode(span.kind),
            `Inserting after block ${after} would land inside ${span.kind === 'annotation' ? 'an annotation' : span.kind === 'math' ? 'a display-math block' : 'a <pre> block'} `
            + `that spans blocks ${span.startLine}–${span.endLine}. Insert before block ${span.startLine} or after block ${span.endLine}.`,
            after,
        );
    }

    // delete: a range covering PART but not all of any opaque span (every kind,
    // annotation included). Ranges fully covering whole spans are fine — a
    // whole-annotation delete is the supported removal path. Containment is
    // decided in SIMPLIFIED SPACE ONLY; because line alignment holds, a range
    // fully covering a span's simplified extent fully covers its raw bytes too.
    const from = spec.block as number;
    const to = spec.to ?? from;
    for (const span of index.spans) {
        const intersects = span.startLine <= to && from <= span.endLine;
        if (!intersects) continue;
        const contained = from <= span.startLine && span.endLine <= to;
        if (contained) continue;
        return skip(
            'span_partial_edit',
            `Deleting blocks ${from}–${to} would remove only part of ${span.kind === 'annotation' ? 'an annotation' : span.kind === 'math' ? 'a display-math block' : 'a <pre> block'} `
            + `that spans blocks ${span.startLine}–${span.endLine}. Delete the whole span, or narrow the range.`,
            from,
        );
    }
    return null;
}

/** Gate 5 — structural rules. */
function checkStructuralRules(index: BlockRawIndex, spec: BlockEditSpec): SkipDraft | null {
    // `prepend` / `append` land at the body's outer edges, never between a
    // container's own structural lines.
    if (spec.op === 'prepend' || spec.op === 'append') return null;

    if (spec.op === 'insert') {
        const after = spec.after as number;
        if (!seamIsStructural(index.simplifiedLines, after)) return null;
        return skip(
            'structural_seam',
            `Inserting after block ${after} would land between a container's own structural lines `
            + '(e.g. between <tr> and <td>, or between <ul> and its first <li>). Insert at a '
            + 'container boundary, or replace the container line itself.',
            after,
        );
    }

    const from = spec.block as number;
    const to = spec.op === 'replace' ? from : (spec.to ?? from);
    const text = index.simplifiedLines.slice(from - 1, to).join('\n');
    if (isRangeBalanced(text)) return null;
    return skip(
        'unbalanced_range',
        `Blocks ${from}–${to} are not tag-balanced: the range opens or closes an element whose `
        + 'counterpart is outside it. Editing it would make the note editor restructure the '
        + 'document. Extend the range to cover the whole element (e.g. the whole <li>, row or list).',
        from,
    );
}

/**
 * Gate 5b — the CONTENT going in must be tag-balanced too.
 *
 * {@link checkStructuralRules} only guards the text being REMOVED, which leaves
 * the identical hazard open in the other direction: `{op:'insert', after:1,
 * content:'<ul><li>'}` applies cleanly and produces a dangling list opener, so
 * ProseMirror repairs the note by restructuring it — exactly what the
 * balanced-range rule exists to prevent, and exactly what the destructive-edit
 * gate cannot see (`toComparableText` strips all tags before comparing).
 *
 * Checked in SIMPLIFIED space, before expansion: simplified tokens are
 * self-closing and `<annotation>` is classified inline, so neither participates
 * in the stack and no legitimate payload is refused.
 */
function checkContentBalance(spec: BlockEditSpec): SkipDraft | null {
    if (spec.op === 'delete') return null;
    const content = spec.content ?? '';
    if (isRangeBalanced(content)) return null;
    // No `actual`: the payload is at fault, not the addressed block, and quoting
    // that block's text here reads as if the address were the problem.
    return skip(
        'unbalanced_range',
        '`content` is not tag-balanced: it opens or closes an element whose counterpart is '
        + 'missing. Inserting it would make the note editor restructure the document. Send '
        + 'complete elements (e.g. a whole <li> or a whole list).',
    );
}

/** Gate 6 — `expect` / `expect_end`. */
function checkExpect(index: BlockRawIndex, spec: BlockEditSpec): SkipDraft | null {
    const mismatchMessage = (field: string, block: number, outcome: ExpectMatchOutcome): string =>
        outcome === 'too_short'
            ? `\`${field}\` matches block ${block} but is too short to confirm it: copy a longer `
              + 'piece of the block\'s visible text — at least 8 non-space characters, or the '
              + 'block\'s ENTIRE visible text when it is shorter than that.'
            : `\`${field}\` does not match block ${block} — the text actually there is shown as `
              + '`actual`. Either the expect text came from a different block or the block number '
              + 'is wrong; check both against the read_note listing you already have.';

    // `prepend` / `append` address no block, so there is nothing to confirm.
    // `checkShape` has already refused any `expect` they carried.
    if (spec.op === 'prepend' || spec.op === 'append') return null;

    if (spec.op === 'insert') {
        // The anchor is quoted from either end of the block, so suffixes match too.
        const after = spec.after as number;
        const anchorLine = index.simplifiedLines[after - 1];
        const outcome = matchExpect(spec.expect as string, anchorLine, { allowSuffix: true });
        if (outcome !== 'match') {
            return skip('expect_mismatch', mismatchMessage('expect', after, outcome), after);
        }
        return null;
    }

    const first = spec.block as number;
    const firstLine = index.simplifiedLines[first - 1];
    const firstOutcome = matchExpect(spec.expect as string, firstLine);
    if (firstOutcome !== 'match') {
        return skip('expect_mismatch', mismatchMessage('expect', first, firstOutcome), first);
    }
    if (spec.op === 'delete') {
        const from = spec.block as number;
        const to = spec.to ?? from;
        if (to > from) {
            const lastLine = index.simplifiedLines[to - 1];
            const lastOutcome = matchExpect(spec.expect_end as string, lastLine);
            if (lastOutcome !== 'match') {
                return skip('expect_end_mismatch', mismatchMessage('expect_end', to, lastOutcome), to);
            }
        }
    }
    return null;
}

/** True when an expansion error is really the annotation-immutability guard. */
function isAnnotationImmutabilityError(message: string): boolean {
    return /annotation content cannot be modified/i.test(message);
}

/**
 * Build the ONE splice for an edit whose gates all passed.
 *
 * EXACTLY ONE SPLICE PER EDIT, UNCONDITIONALLY. This invariant is load-bearing
 * in two places: the flat preview pair and the single undo draft per edit.
 * Anything that would emit N splices is a refusal instead (see
 * {@link checkSkippedLineCrossing}).
 *
 * Every operation maps to batch `operation: 'str_replace'`. `applyResolvedEdits`
 * and `captureUndoContexts` only special-case `'rewrite'` (skip undo anchors) and
 * `'str_replace_all'` (per-occurrence contexts, keyed off
 * `undo_occurrence_contexts`), so a single-splice `'str_replace'` carries exactly
 * the undo semantics needed via `undoOldHtml` / `undoNewHtml`.
 */
function buildSplice(
    index: BlockRawIndex,
    spec: BlockEditSpec,
    expandedContent: string,
): { applyOp: BatchApplyOp; range: ResolvedRange; undoOldHtml: string; undoNewHtml: string; anchorBlock: number; consumedBlocks: number; producedBlocks: number } {
    const { rawLineRanges, strippedHtml, bodyEnd } = index;
    const total = rawLineRanges.length;
    const trailingEmpty = index.simplifiedLines[total - 1] === '';

    const make = (start: number, end: number, replacement: string, undoOld: string, undoNew: string) => ({
        applyOp: {
            start,
            end,
            replacement,
            fragmentOffset: 0,
            fragmentLength: undoNew.length,
        },
        range: { start, end },
        undoOldHtml: undoOld,
        undoNewHtml: undoNew,
    });

    /**
     * "Append at the end of the body" — the SINGLE implementation shared by
     * `op: 'append'`, `insert after: <trailing empty line>` and `replace` of the
     * trailing empty line. These are the same conceptual operation and must not
     * diverge, which is why there is one helper and not three call sites. The
     * point comes from the walk (see `BlockRawIndex.bodyAppendPoint`), so content
     * lands ABOVE any trailing Beaver footer.
     */
    const appendAtBodyEnd = () => {
        const at = index.bodyAppendPoint;
        const replacement = index.bodyAppendLeadingNewline
            ? `\n${expandedContent}`
            : `${expandedContent}\n`;
        return {
            ...make(at, at, replacement, '', replacement),
            anchorBlock: index.bodyAppendAnchorBlock,
            consumedBlocks: 0,
            producedBlocks: lineCount(expandedContent),
        };
    };

    if (spec.op === 'append') return appendAtBodyEnd();

    if (spec.op === 'prepend') {
        // The first KEPT line is normally the first content line, so prepending
        // at its start puts content above every block — and below a LEADING
        // Beaver footer, which is where it belongs.
        //
        // EXCEPT when the body holds no content line at all (only footers): then
        // the first kept line is the trailing empty line, which sits BELOW the
        // footer, and prepending there would bury the user's content under
        // "Created by Beaver" — the exact hazard `bodyAppendPoint` exists to
        // avoid at the other end. `bodyAppendAnchorBlock === 0` is the walk's own
        // signal for that shape and `bodyStart` is what its append point falls
        // back to, so the two ends coincide there, as they must: with no content,
        // there is nothing to be before or after.
        const at = index.bodyAppendAnchorBlock === 0 ? index.bodyStart : rawLineRanges[0].start;
        const replacement = `${expandedContent}\n`;
        return {
            ...make(at, at, replacement, '', replacement),
            anchorBlock: 0,
            consumedBlocks: 0,
            producedBlocks: lineCount(expandedContent),
        };
    }

    if (spec.op === 'replace') {
        const block = spec.block as number;
        // Replacing the trailing empty line IS an append at the end of the body.
        if (block === total && trailingEmpty) return appendAtBodyEnd();
        const r = rawLineRanges[block - 1];
        const original = strippedHtml.slice(r.start, r.end);
        return {
            ...make(r.start, r.end, expandedContent, original, expandedContent),
            anchorBlock: block,
            consumedBlocks: 1,
            producedBlocks: lineCount(expandedContent),
        };
    }

    if (spec.op === 'insert') {
        // Inserting after the trailing empty line IS an append at the end of the
        // body — the one spelling of `append` that `insert` can still reach.
        if (spec.after === total && trailingEmpty) return appendAtBodyEnd();
        const after = spec.after as number;
        const at = rawLineRanges[after - 1].end;
        const replacement = `\n${expandedContent}`;
        return {
            ...make(at, at, replacement, '', replacement),
            anchorBlock: after,
            consumedBlocks: 0,
            producedBlocks: lineCount(expandedContent),
        };
    }

    // delete
    const from = spec.block as number;
    const to = spec.to ?? from;
    const startOffset = rawLineRanges[from - 1].start;
    const endOffset = rawLineRanges[to - 1].end;
    let spliceStart = startOffset;
    let spliceEnd = endOffset;
    if (endOffset < bodyEnd && strippedHtml[endOffset] === '\n') {
        // Consume the range's own trailing newline.
        spliceEnd = endOffset + 1;
    } else {
        // Deleting through the last body line: extend LEFT instead, so the
        // preceding line keeps its terminator and no blank line is left behind.
        spliceStart = Math.max(index.bodyStart, startOffset - 1);
    }
    const removed = strippedHtml.slice(spliceStart, spliceEnd);
    return {
        ...make(spliceStart, spliceEnd, '', removed, ''),
        anchorBlock: from,
        consumedBlocks: to - from + 1,
        producedBlocks: 0,
    };
}

function rangesIntersect(a: ResolvedRange, b: ResolvedRange): boolean {
    return a.start < b.end && b.start < a.end;
}

/**
 * Conflict test for the ascending keep-first selector.
 *
 * Strict intersection (adjacency is legal, matching the batch engine) PLUS a
 * same-offset clause for ZERO-WIDTH ranges. The zero-width clause covers two
 * distinct hazards, and it must fire whenever a zero-width range coincides with
 * ANY other range's START — not only when both ranges are zero-width:
 *
 * 1. Two inserts at the same anchor both produce zero-width ranges, which strict
 *    intersection reports as non-conflicting. The second must be skipped so the
 *    model combines them into one `content`.
 * 2. A zero-width insert whose offset equals another edit's range START escapes
 *    strict intersection too — `prepend` resolves to `rawLineRanges[0].start`,
 *    exactly where `replace block 1` / `delete block 1` begin. Keeping both
 *    is silent corruption, not a cosmetic ordering quirk: `applyResolvedEdits`
 *    splices descending by start and breaks ties by DESCENDING edit index (a
 *    tie-break meant for case 1), so when the insert has the higher request index
 *    it is spliced FIRST and the sibling splice — still holding pre-edit offsets —
 *    consumes the freshly inserted text instead of the original line. The
 *    reverse-replay self-check does not fire, because the two length deltas
 *    cancel, so nothing downstream notices.
 *
 * Coincidence with a range's END stays legal and is correct: `insert after N`
 * resolves strictly past `replace N`'s end, so the descending splice order
 * applies them in the right sequence.
 */
function conflicts(a: ResolvedRange, b: ResolvedRange): boolean {
    if (rangesIntersect(a, b)) return true;
    if (a.start === a.end && a.start === b.start) return true;
    if (b.start === b.end && b.start === a.start) return true;
    return false;
}

/**
 * Resolve every block edit against ONE note snapshot.
 *
 * Every per-edit failure is a SKIP, never a whole-call failure. The one
 * whole-call failure this can return is `address_resolution_failed`, raised when
 * the token-aware projection check finds a line that genuinely does not line up
 * — at that point every splice offset is suspect, so refusing is the only safe
 * answer.
 *
 * Edits are processed ASCENDING by `index`; the gate order per edit is exact and
 * deliberate (see the individual gate functions for why).
 */
export function selectBlockEdits(
    ctx: SelectBlockEditsContext,
    edits: readonly BlockEditSpec[],
): SelectBlockEditsResult {
    const { index } = ctx;
    const total = index.rawLineRanges.length;
    const applied: SelectedBlockEdit[] = [];
    const skipped: BlockEditSkip[] = [];
    const unverifiedBlocks: number[] = [];
    const verified = new Set<number>();

    /** Run the projection guard for a line actually addressed by an edit. */
    const verifyBlock = (block: number): BlockAddressRefusal | null => {
        if (verified.has(block)) return null;
        verified.add(block);
        // Lines owned by a multiline span are exempt: their raw and simplified
        // forms differ by a wrapper that only exists on one of the span's lines.
        if (multilineSpansAt(index, block).length > 0) return null;
        const check = verifyLineProjection(index, block);
        if (check.status === 'match') return null;
        if (check.status === 'unverified') {
            unverifiedBlocks.push(block);
            return null;
        }
        return refuse(
            'Cannot address this note by block number: the note\'s stored HTML and its simplified '
            + `view do not line up (${check.detail}). Instead: ${REWRITE_FALLBACK}.`,
        );
    };

    const ordered = [...edits].sort((a, b) => a.index - b.index);

    for (const spec of ordered) {
        const emit = (draft: SkipDraft) => {
            const entry: BlockEditSkip = {
                index: spec.index,
                reason_code: draft.reason_code,
                reason: draft.reason,
            };
            if (spec.client_item_id !== undefined) entry.client_item_id = spec.client_item_id;
            const actual = draft.actualBlock === undefined ? undefined : actualFor(index, draft.actualBlock);
            if (actual !== undefined) entry.actual = actual;
            skipped.push(entry);
        };

        // 1. shape
        const shapeSkip = checkShape(spec);
        if (shapeSkip) { emit(shapeSkip); continue; }

        // 2. bounds, then the trailing-empty-line delete guard
        const boundsSkip = checkBounds(spec, total);
        if (boundsSkip) { emit(boundsSkip); continue; }

        if (spec.op === 'delete') {
            const from = spec.block as number;
            const to = spec.to ?? from;
            if (to === total && index.simplifiedLines[total - 1] === '') {
                emit(skip(
                    'invalid_edit',
                    `Block ${total} is the note's trailing empty line and cannot be deleted. `
                    + `Delete up to block ${total - 1} instead, or rewrite the note: ${REWRITE_FALLBACK}.`,
                    total,
                ));
                continue;
            }
        }

        // 3. a range crossing a footer-skipped line
        if (spec.op === 'delete') {
            const from = spec.block as number;
            const to = spec.to ?? from;
            const crossSkip = checkSkippedLineCrossing(index, from, to);
            if (crossSkip) { emit(crossSkip); continue; }
        }

        // 4. span rules (BEFORE structural rules — see checkSpanRules)
        const spanSkip = checkSpanRules(index, spec);
        if (spanSkip) { emit(spanSkip); continue; }

        // 5. structural rules
        const structuralSkip = checkStructuralRules(index, spec);
        if (structuralSkip) { emit(structuralSkip); continue; }

        // 5b. the content going IN must be balanced too (the other direction of
        // the same hazard).
        const contentSkip = checkContentBalance(spec);
        if (contentSkip) { emit(contentSkip); continue; }

        // Projection guard for every line this edit is about to touch.
        const touched: number[] = [];
        if (spec.op === 'replace') touched.push(spec.block as number);
        else if (spec.op === 'delete') {
            const from = spec.block as number;
            const to = spec.to ?? from;
            for (let n = from; n <= to; n++) touched.push(n);
        } else if (spec.op === 'insert') touched.push(spec.after as number);
        // `prepend` / `append` touch no block, so they have nothing to verify.
        for (const block of touched) {
            const refusal = verifyBlock(block);
            if (refusal) return refusal;
        }

        // 6. expect
        const expectSkip = checkExpect(index, spec);
        if (expectSkip) { emit(expectSkip); continue; }

        // 7. content precheck / expansion
        const warnings: string[] = [];
        let expandedContent = '';
        if (spec.op !== 'delete') {
            let content = spec.content as string;
            if (ctx.preprocessContent) {
                const pre = ctx.preprocessContent(content);
                if (pre.error) {
                    // Same code the expansion layer would raise for this content
                    // if the hook had let it through — the hook only intercepts
                    // earlier so it can say something specific about WHY.
                    emit(skip(
                        'expansion_failed',
                        pre.error,
                        spec.op === 'replace' ? (spec.block as number) : undefined,
                    ));
                    continue;
                }
                content = pre.content;
                warnings.push(...pre.warnings);
            }
            try {
                expandedContent = expandToRawHtml(
                    content,
                    index.metadata,
                    'new',
                    ctx.externalRefContext,
                    ctx.pageLabels,
                    ctx.resolvedLocatorPages,
                );
            } catch (e: any) {
                const message = e?.message || String(e);
                emit(skip(
                    isAnnotationImmutabilityError(message) ? 'annotation_immutable' : 'expansion_failed',
                    message,
                    spec.op === 'replace' ? (spec.block as number) : undefined,
                ));
                continue;
            }
        }

        const splice = buildSplice(index, spec, expandedContent);

        // 8. overlap vs the kept set
        const conflict = applied.find((a) => a.resolved.ranges.some((r) => conflicts(r, splice.range)));
        if (conflict) {
            emit(skip(
                'overlapping_edits',
                `This edit overlaps edit ${conflict.resolved.index}, which was applied first. `
                + 'Combine them into a single edit, or address a different region.',
                splice.anchorBlock >= 1 ? splice.anchorBlock : undefined,
            ));
            continue;
        }

        const resolved: ResolvedBatchEdit = {
            index: spec.index,
            client_item_id: spec.client_item_id,
            operation: 'str_replace',
            expandedOld: splice.undoOldHtml,
            expandedNew: splice.applyOp.replacement,
            ranges: [splice.range],
            applyOps: [splice.applyOp],
            matchCount: 1,
            occurrencesReplaced: 1,
            undoOldHtml: splice.undoOldHtml,
            undoNewHtml: splice.undoNewHtml,
            warnings,
        };

        applied.push({
            resolved,
            op: spec.op,
            anchorBlock: splice.anchorBlock,
            consumedBlocks: splice.consumedBlocks,
            producedBlocks: splice.producedBlocks,
        });
    }

    return { ok: true, applied, skipped, unverifiedBlocks };
}

/**
 * Edit-note string location: the single home for "where does this fragment
 * live in the note HTML?" across validator, executor, and undo paths.
 *
 * Layered API:
 *
 *   Strategies (low-level, single-purpose):
 *     - findUniqueRawMatchPosition / findTargetRawMatchPosition (in simplifier)
 *     - captureValidatedEditTargetContext (in simplifier)
 *     - findRangeByContexts with policy (in simplifier)
 *     - findRangesByRawAnchors      — prefix/suffix probe candidates
 *     - findWhitespaceTolerant      — single match with whitespace tolerance
 *     - normalizeUndoComparisonHtml — comparator that hides PM whitespace drift
 *
 *   Patterns (composed strategies):
 *     - locateEditTarget          → validate-time position lookup
 *     - resolveEditTargetAtRuntime → execute-time position lookup
 *     - locateEditFragment        → unified orchestrator (any intent)
 *     - buildZeroMatchHint        → drift / fuzzy / structural / generic hint
 */

import {
    type SimplificationMetadata,
    simplifyNoteHtml,
} from './noteHtmlSimplifier';
import { stripDataCitationItems } from './noteWrapper';
import {
    type CandidateSnippet,
    centerTruncate,
    findCandidateSnippets,
    findInlineTagDriftMatch,
    findStructuralAnchorHint,
    findWindowCandidates,
    DEFAULT_MAX_SNIPPET_LENGTH,
    markTruncatedUnlessVerbatim,
    MAX_PASTEABLE_SNIPPET_LENGTH,
    pasteableSnippetBudget,
} from './editNoteHints';
import type { EditNoteOperation } from '@beaver/agent-core/types/agentActions/editNote';
import {
    captureValidatedEditTargetContext,
    findRangeByContexts,
    findRefInsensitiveMatches,
    findTargetRawMatchPosition,
    findUniqueRawMatchPosition,
} from './editNoteRawPosition';

// =============================================================================
// Position lookup (Pattern B)
// =============================================================================

export type EditTargetLocation =
    | { kind: 'position'; rawPosition: number }
    | { kind: 'context'; beforeContext: string; afterContext: string }
    | { kind: 'ambiguous' };

/**
 * Validation-time target resolution for ambiguous multi-match edits.
 *
 * 1. Prefer a unique raw-position match (conservative — ignores ref values).
 * 2. Fall back to capturing surrounding context so the executor can re-locate
 *    the exact occurrence later.
 * 3. If neither pins down a single target, report ambiguous.
 */
export function locateEditTarget(args: {
    strippedHtml: string;
    simplified: string;
    oldString: string;
    expandedOld: string;
    metadata: SimplificationMetadata;
}): EditTargetLocation {
    const { strippedHtml, simplified, oldString, expandedOld, metadata } = args;

    const rawPos = findUniqueRawMatchPosition(
        strippedHtml, simplified, oldString, expandedOld, metadata
    );
    if (rawPos !== null) {
        return { kind: 'position', rawPosition: rawPos };
    }

    const targetContext = captureValidatedEditTargetContext(
        strippedHtml, simplified, oldString, expandedOld, metadata
    );
    if (targetContext) {
        return {
            kind: 'context',
            beforeContext: targetContext.beforeContext,
            afterContext: targetContext.afterContext,
        };
    }

    return { kind: 'ambiguous' };
}

/**
 * Execution-time target resolution. Prefers the conservative unique-match
 * lookup; falls back to the context stored by the validator. Returns -1 when
 * neither resolves.
 */
export function resolveEditTargetAtRuntime(args: {
    strippedHtml: string;
    simplified: string;
    oldString: string;
    expandedOld: string;
    metadata: SimplificationMetadata;
    targetBeforeContext?: string;
    targetAfterContext?: string;
}): { rawPosition: number } {
    const {
        strippedHtml, simplified, oldString, expandedOld, metadata,
        targetBeforeContext, targetAfterContext,
    } = args;

    const uniquePos = findUniqueRawMatchPosition(
        strippedHtml, simplified, oldString, expandedOld, metadata
    );
    if (uniquePos !== null) {
        return { rawPosition: uniquePos };
    }

    if (targetBeforeContext !== undefined || targetAfterContext !== undefined) {
        const ctxPos = findTargetRawMatchPosition(
            strippedHtml, expandedOld, targetBeforeContext, targetAfterContext
        );
        if (ctxPos !== null) {
            return { rawPosition: ctxPos };
        }
    }

    return { rawPosition: -1 };
}

// =============================================================================
// Zero-match hint (Pattern A)
// =============================================================================

export type ZeroMatchHint =
    | { kind: 'drift'; droppedTags: string[]; noteSpan: string; message: string; candidates: CandidateSnippet[] }
    | { kind: 'fuzzy'; message: string; candidates: CandidateSnippet[] }
    | { kind: 'structural'; tagName: string; context: string; message: string; candidates: CandidateSnippet[] }
    | { kind: 'generic'; message: string; candidates: CandidateSnippet[] };

export interface ZeroMatchHintOptions {
    /**
     * Sentence explaining a fallback that matched but was refused as
     * ambiguous (`describeRejectedFallback`).
     */
    rejectedFallback?: string | null;
}

/**
 * Opening sentence of a not-found error. With a refused fallback it is
 * worded differently on purpose: the backend shortens a message that starts
 * with the plain sentence to that sentence alone, and this explanation must
 * stay on the first line it keeps.
 */
function notFoundSentence(rejectedFallback?: string | null): string {
    return rejectedFallback
        ? `The string to replace was not found in the note as written. ${rejectedFallback}`
        : 'The string to replace was not found in the note.';
}

/** Render a candidate list as a numbered, fenced block for the model. */
function renderCandidateLines(candidates: CandidateSnippet[]): string {
    return candidates
        .map((c, i) => {
            const parts: string[] = [`score ${c.score.toFixed(2)}`, `via ${c.via}`];
            if (c.truncated) parts.push('truncated');
            return `  [${i + 1}] (${parts.join(', ')})\n\`\`\`\n${c.snippet}\n\`\`\``;
        })
        .join('\n');
}

/**
 * Build the most specific error hint available when `old_string` isn't found.
 * Priority: inline-tag drift → candidate snippets → structural anchor →
 * multi-line window region → generic. Each variant carries `candidates` so
 * callers can forward them to the agent in a structured envelope (see
 * `WSAgentActionValidateResponse.error_candidates`).
 */
export function buildZeroMatchHint(
    simplified: string,
    oldString: string,
    options: ZeroMatchHintOptions = {},
): ZeroMatchHint {
    const notFound = notFoundSentence(options.rejectedFallback);
    const drift = findInlineTagDriftMatch(simplified, oldString);
    if (drift) {
        const droppedList = drift.droppedTags.join(' ');
        const message =
            `${notFound} `
            + 'Your old_string text matches a span in the note uniquely, '
            + 'but is missing inline HTML formatting tags that the note has.\n'
            + `Note has:\n\`\`\`\n${drift.noteSpan}\n\`\`\`\n`
            + `Your old_string:\n\`\`\`\n${oldString}\n\`\`\`\n`
            + `Tags missing from old_string: ${droppedList}.\n`
            + 'To fix: copy the "Note has" version above as your old_string '
            + '(must match exactly, including all inline tags). Then choose '
            + 'new_string based on intent — keep the same tags around the '
            + 'same words to preserve the formatting, or omit them to remove '
            + 'the formatting.';
        // The message above tells the model to copy this exact span, and the
        // span is a verbatim slice of the note — so let the whole thing through
        // rather than handing back a clipped version it cannot paste.
        const driftTrimmed = markTruncatedUnlessVerbatim(
            centerTruncate(
                drift.noteSpan,
                Math.floor(drift.noteSpan.length / 2),
                pasteableSnippetBudget(drift.noteSpan.length),
            ),
            simplified,
        );
        return {
            kind: 'drift',
            droppedTags: drift.droppedTags,
            noteSpan: drift.noteSpan,
            message,
            candidates: [{
                snippet: driftTrimmed.snippet,
                truncated: driftTrimmed.truncated,
                via: 'inline_tag_drift',
                score: 1,
            }],
        };
    }

    const candidates = findCandidateSnippets(simplified, oldString);
    if (candidates.length > 0) {
        const header =
            `${notFound} `
            + 'Closest matches in the note:';
        const footer =
            '\nCopy the exact text from one of the candidates above as your '
            + 'old_string, or rewrite old_string to match a span you can see '
            + 'in the note.';
        return {
            kind: 'fuzzy',
            message: `${header}\n${renderCandidateLines(candidates)}${footer}`,
            candidates,
        };
    }

    const structural = findStructuralAnchorHint(simplified, oldString);
    if (structural) {
        const message =
            notFound
            + ` Your old_string references \`<${structural.tagName}>\`,`
            + ' but its actual context in the note is:\n'
            + `\`\`\`\n${structural.context}\n\`\`\`\n`
            + 'Rewrite old_string to match the surrounding content shown above.';
        // `structural.context` already carries its own `…` markers when the
        // anchor window was cut out of a longer note, so it stays flagged as
        // truncated even when it fits the snippet budget whole.
        const structuralTrimmed = markTruncatedUnlessVerbatim(
            centerTruncate(
                structural.context,
                Math.floor(structural.context.length / 2),
                pasteableSnippetBudget(structural.context.length),
            ),
            simplified,
        );
        return {
            kind: 'structural',
            tagName: structural.tagName,
            context: structural.context,
            message,
            candidates: [{
                snippet: structuralTrimmed.snippet,
                truncated: structuralTrimmed.truncated,
                via: 'structural_anchor',
                score: 1,
            }],
        };
    }

    // Last resort before a bare "not found": multi-line window scoring locates
    // the region even when old_string is Markdown, mis-tagged, or spread
    // across many lines that no per-line scorer could catch.
    const windowCandidates = findWindowCandidates(simplified, oldString);
    if (windowCandidates.length > 0) {
        const header =
            `${notFound} These note `
            + 'snippets are near the region your old_string seems to target, '
            + 'but are NOT exact matches:';
        const footer =
            '\nDo not paste these verbatim. Call read_note around them to see '
            + 'the exact current HTML, then copy a precise span as old_string.';
        return {
            kind: 'fuzzy',
            message: `${header}\n${renderCandidateLines(windowCandidates)}${footer}`,
            candidates: windowCandidates,
        };
    }

    return {
        kind: 'generic',
        message: notFound,
        candidates: [],
    };
}

// =============================================================================
// Ambiguous-match hint
// =============================================================================

/** Occurrences listed in an ambiguous-match error. */
const MAX_AMBIGUOUS_CANDIDATES = 5;

function isUniqueIn(text: string, slice: string): boolean {
    const first = text.indexOf(slice);
    return first !== -1 && text.indexOf(slice, first + 1) === -1;
}

/** Move `start` left so it does not fall inside a `<…>` tag. */
function snapStartOutsideTag(text: string, start: number): number {
    const open = text.lastIndexOf('<', start - 1);
    return open > text.lastIndexOf('>', start - 1) ? open : start;
}

/** Move `end` right so it does not fall inside a `<…>` tag. */
function snapEndOutsideTag(text: string, end: number): number {
    if (text.lastIndexOf('<', end - 1) <= text.lastIndexOf('>', end - 1)) return end;
    const close = text.indexOf('>', end);
    return close === -1 ? text.length : close + 1;
}

/**
 * Grow `[s, e)` until it is unique: backwards while `prev` can extend it, then
 * forwards with `next`. Growing backwards first keeps the occurrence at the
 * end of the snippet, after the text that identifies it (a row label, the
 * start of a sentence).
 */
function growUntilUnique(
    text: string,
    s: number,
    e: number,
    budget: number,
    prev: (s: number) => number,
    next: (e: number) => number,
): string | null {
    while (e - s <= budget) {
        const slice = text.substring(s, e);
        if (isUniqueIn(text, slice)) return slice;
        const ps = s > 0 ? prev(s) : s;
        if (ps < s && e - ps <= budget) { s = ps; continue; }
        const ne = e < text.length ? next(e) : e;
        if (ne > e && ne - s <= budget) { e = ne; continue; }
        break;
    }
    return null;
}

/** Grow by whole lines. */
function growByLines(text: string, s: number, e: number, budget: number): string | null {
    return growUntilUnique(text, s, e, budget,
        (i) => text.lastIndexOf('\n', i - 2) + 1,
        (i) => {
            const nl = text.indexOf('\n', i + 1);
            return nl === -1 ? text.length : nl;
        });
}

/**
 * Grow by words, snapped out of tags so no simplified tag is cut in half.
 * `fixedEdge` keeps that end of the occurrence where it is.
 */
function growByWords(
    text: string,
    s: number,
    e: number,
    budget: number,
    fixedEdge?: 'start' | 'end',
): string | null {
    const isSpace = (c: string) => /\s/.test(c);
    return growUntilUnique(text, s, e, budget,
        (i) => {
            if (fixedEdge === 'start') return i;
            while (i > 0 && isSpace(text[i - 1])) i--;
            while (i > 0 && !isSpace(text[i - 1])) i--;
            return snapStartOutsideTag(text, i);
        },
        (i) => {
            if (fixedEdge === 'end') return i;
            while (i < text.length && isSpace(text[i])) i++;
            while (i < text.length && !isSpace(text[i])) i++;
            return snapEndOutsideTag(text, i);
        });
}

/**
 * The shortest slice of `simplified` around the occurrence `[start, end)` that
 * occurs exactly once, or `null` when none fits in `budget`. Blocks sit one per
 * line, so an occurrence alone on a short line grows by whole lines and stays
 * readable; inside a long line, or one holding another occurrence, it grows
 * word by word so each occurrence gets its own snippet. An insertion anchor
 * grows away from its insertion point only (`fixedEdge`): pasted back, the
 * snippet must still insert exactly where the occurrence ends or starts.
 */
function uniqueSliceAround(
    simplified: string,
    start: number,
    end: number,
    spans: { start: number; end: number }[],
    budget: number,
    fixedEdge?: 'start' | 'end',
): string | null {
    if (fixedEdge) return growByWords(simplified, start, end, budget, fixedEdge);
    const ls = start <= 0 ? 0 : simplified.lastIndexOf('\n', start - 1) + 1;
    const nl = simplified.indexOf('\n', end);
    // An occurrence that already ends with a newline ends on a line boundary.
    const le = end > start && simplified[end - 1] === '\n' ? end : (nl === -1 ? simplified.length : nl);
    const lineIsOwn = le - ls <= DEFAULT_MAX_SNIPPET_LENGTH
        && !spans.some((o) => o.start !== start && o.start < le && o.end > ls);
    if (lineIsOwn) {
        const byLine = growByLines(simplified, ls, le, budget);
        if (byLine) return byLine;
    }
    return growByWords(simplified, start, end, budget)
        ?? (lineIsOwn ? null : growByLines(simplified, ls, le, budget));
}

/**
 * One candidate per occurrence of `oldString` in the simplified note, each the
 * occurrence widened with surrounding text until it is unique, so the agent
 * can paste the one it means as `old_string`. Refs in `oldString` act as
 * wildcards: refs renumber after edits, and the snippets carry the current
 * ones. Occurrences that cannot be made unique within the snippet budget are
 * skipped.
 *
 * `searchIn` is an equal-length re-spelling of `simplified` (e.g. with folded
 * quotes) to find the occurrences in; snippets are still cut from
 * `simplified`, so they stay verbatim note text. `fixedEdge` is the edge of
 * an insertion anchor that must not move (see `uniqueSliceAround`).
 */
export function findAmbiguousOccurrenceCandidates(
    simplified: string,
    oldString: string,
    options: { searchIn?: string; fixedEdge?: 'start' | 'end'; maxCandidates?: number } = {},
): { candidates: CandidateSnippet[]; occurrenceCount: number } {
    const { searchIn = simplified, fixedEdge, maxCandidates = MAX_AMBIGUOUS_CANDIDATES } = options;
    if (!oldString) return { candidates: [], occurrenceCount: 0 };
    const spans = findRefInsensitiveMatches(searchIn, oldString);
    // A lone occurrence identical to old_string gives the agent nothing new to
    // copy; one that differs in its refs shows the current refs.
    if (spans.length === 0
        || (spans.length === 1 && simplified.substring(spans[0].start, spans[0].end) === oldString)) {
        return { candidates: [], occurrenceCount: spans.length };
    }

    const candidates: CandidateSnippet[] = [];
    const seen = new Set<string>();
    for (const { start, end } of spans) {
        if (candidates.length >= maxCandidates) break;
        const snippet = uniqueSliceAround(simplified, start, end, spans, MAX_PASTEABLE_SNIPPET_LENGTH, fixedEdge);
        if (!snippet || seen.has(snippet)) continue;
        seen.add(snippet);
        candidates.push({ snippet, truncated: false, via: 'ambiguous_occurrence', score: 1 });
    }
    return { candidates, occurrenceCount: spans.length };
}

/**
 * Error message for an old_string that matches more than once. With
 * candidates, each occurrence is listed as a unique, pasteable snippet so the
 * agent can retry in one step. `rewrite` names how the matcher changed
 * old_string before it matched (`describeMatchRewrite`), so the count is not
 * read as a count of the model's exact text.
 */
export function buildAmbiguousMatchError(
    matchCount: number,
    operation?: EditNoteOperation,
    hint?: {
        candidates?: CandidateSnippet[];
        occurrenceCount?: number;
        rewrite?: string | null;
    },
): string {
    const isInsert = operation === 'insert_after' || operation === 'insert_before';
    const candidates = hint?.candidates ?? [];
    const subject = isInsert ? 'The insertion anchor' : 'The string to replace';
    const found = hint?.rewrite
        ? `${subject} was not found exactly as written; after ${hint.rewrite}, it was found ${matchCount} times in the note.`
        : `${subject} was found ${matchCount} times in the note.`;
    // str_replace_all is only a valid alternative for replacement edits; for
    // inserts the anchor itself must be made unique.
    if (candidates.length === 0) {
        return isInsert
            ? `${found} Include more surrounding context in old_string so the anchor matches exactly once.`
            : `${found} Use operation str_replace_all to replace all occurrences, or include more context to make the match unique.`;
    }

    const lines: string[] = [found];
    lines.push(
        operation === 'insert_after'
            ? 'Each snippet below ends with one occurrence, widened with the text before it until it is unique.'
            : operation === 'insert_before'
                ? 'Each snippet below starts with one occurrence, widened with the text after it until it is unique.'
                : 'Each snippet below ends with one occurrence (or starts with it, near the top of the note), '
                    + 'widened with the neighboring text until it is unique.',
        'Copy the one you mean EXACTLY as old_string'
        + (isInsert
            ? '; the anchor is kept, so new_string still holds only the inserted content.'
            : ', and keep that surrounding text unchanged in new_string.'),
    );
    if (!isInsert) lines.push('To change every occurrence instead, use operation str_replace_all.');
    const occurrenceCount = hint?.occurrenceCount ?? candidates.length;
    if (occurrenceCount > candidates.length) {
        lines.push(`Showing ${candidates.length} of ${occurrenceCount} occurrences.`);
    }
    candidates.forEach((c, i) => {
        lines.push(`[${i + 1}]\n\`\`\`\n${c.snippet}\n\`\`\``);
    });
    return lines.join('\n');
}

export interface AmbiguousMatchHint {
    message: string;
    candidates: CandidateSnippet[];
}

/**
 * Build the ambiguous-match error and its per-occurrence candidates.
 *
 * Occurrences are looked up for the model's own old_string first, so the
 * snippets describe what it wrote. Fallbacks, in order: `matchedOldString`
 * (a strategy's rewritten needle, e.g. with trailing newlines trimmed), then
 * old_string re-spelled by `normalize` (the strategy's `normalizeAnchor`, e.g.
 * decoded entities or folded quotes) when the note differs only in spelling.
 */
export function buildAmbiguousMatchHint(args: {
    simplified: string;
    oldString: string;
    matchedOldString?: string;
    normalize?: (s: string) => string;
    matchCount: number;
    operation?: EditNoteOperation;
    rewrite?: string | null;
}): AmbiguousMatchHint {
    const { simplified, oldString, matchedOldString, normalize, matchCount, operation, rewrite } = args;
    const fixedEdge = operation === 'insert_after' ? 'end' : operation === 'insert_before' ? 'start' : undefined;
    const searches: { needle: string; searchIn: string }[] = [{ needle: oldString, searchIn: simplified }];
    if (matchedOldString && matchedOldString !== oldString) {
        searches.push({ needle: matchedOldString, searchIn: simplified });
    }
    if (normalize) {
        const needle = normalize(oldString);
        const folded = normalize(simplified);
        // A length-preserving re-spelling keeps offsets aligned with the note.
        searches.push({ needle, searchIn: folded.length === simplified.length ? folded : simplified });
    }
    let found = findAmbiguousOccurrenceCandidates(simplified, searches[0].needle, { fixedEdge });
    for (const next of searches.slice(1)) {
        if (found.candidates.length > 0) break;
        found = findAmbiguousOccurrenceCandidates(simplified, next.needle, { searchIn: next.searchIn, fixedEdge });
    }
    return {
        message: buildAmbiguousMatchError(matchCount, operation, { ...found, rewrite }),
        candidates: found.candidates,
    };
}

/**
 * True when old_string carries citation refs and its text occurs in the note
 * only with other refs. Refs exist only in the simplified view: citations of
 * the same item share their raw HTML, so the raw match lands on those other
 * citations, not on text the model wrote. Whether the model copied the text
 * right and the ref wrong, or the reverse, its old_string is not in the note.
 */
export function oldStringCitesOtherRefs(simplified: string, oldString: string): boolean {
    if (!/\bref="/.test(oldString)) return false;
    const spans = findRefInsensitiveMatches(simplified, oldString);
    return spans.length > 0
        && !spans.some(({ start, end }) => simplified.substring(start, end) === oldString);
}

/** Lead sentence for the not-found error when `oldStringCitesOtherRefs`. */
const OTHER_REFS_SENTENCE = 'Its text appears in the note only next to citations with other refs '
    + '(refs number the citations of each item in note order), so those were not used.';

/**
 * Not-found error for an old_string whose text occurs only next to citations
 * with other refs (`oldStringCitesOtherRefs`). Either the ref or the text
 * around it is wrong, so both readings are offered: first the line holding
 * each citation old_string names, then each place its text occurs, with the
 * refs found there. All snippets are verbatim note text. The explanation
 * stays on the first line, which the backend keeps when it renders the
 * candidates itself.
 */
export function buildOtherRefsNotFoundHint(
    simplified: string,
    oldString: string,
    operation?: EditNoteOperation,
): AmbiguousMatchHint {
    const candidates: CandidateSnippet[] = [];
    const seen = new Set<string>();
    const add = (snippet: string | null) => {
        if (!snippet || seen.has(snippet)) return;
        seen.add(snippet);
        candidates.push({ snippet, truncated: false, via: 'ambiguous_occurrence', score: 1 });
    };

    const refs = [...oldString.matchAll(/\bref="([^"]*)"/g)].map((m) => m[1]);
    for (const ref of new Set(refs)) {
        const at = simplified.indexOf(`ref="${ref}"`);
        if (at === -1) continue;
        const lineStart = simplified.lastIndexOf('\n', at) + 1;
        const nl = simplified.indexOf('\n', at);
        const line = simplified.substring(lineStart, nl === -1 ? simplified.length : nl);
        // The ref is unique, so its line is too; a very long line is cut to
        // the citation tag itself.
        if (line.length <= MAX_PASTEABLE_SNIPPET_LENGTH) add(line);
        else add(simplified.substring(simplified.lastIndexOf('<citation', at), simplified.indexOf('/>', at) + 2));
    }
    const refCandidates = candidates.length;
    const fixedEdge = operation === 'insert_after' ? 'end' : operation === 'insert_before' ? 'start' : undefined;
    for (const c of findAmbiguousOccurrenceCandidates(simplified, oldString, { fixedEdge }).candidates) add(c.snippet);

    const quotedRefs = refs.map((r) => `ref="${r}"`).join(', ');
    const guide = candidates.length === 0
        ? ''
        : refCandidates > 0 && candidates.length > refCandidates
            ? (refCandidates > 1 ? ` Snippets [1-${refCandidates}] show` : ' Snippet [1] shows')
                + ` where ${quotedRefs} ${refs.length > 1 ? 'are' : 'is'} now; the others show where old_string's text `
                + 'occurs, with the refs found there. Copy the one you mean EXACTLY as old_string.'
            : ' The snippets below are verbatim note text; copy the one you mean EXACTLY as old_string.';
    const lines = [`${notFoundSentence(OTHER_REFS_SENTENCE)}${guide}`];
    candidates.forEach((c, i) => lines.push(`[${i + 1}]\n\`\`\`\n${c.snippet}\n\`\`\``));
    return { message: lines.join('\n'), candidates };
}

export interface ExecutionZeroMatchHint {
    message: string;
    candidates: CandidateSnippet[];
}

/**
 * Executor variant of `buildZeroMatchHint`. The validator already ran the
 * inline-tag-drift and structural-anchor legs; at execute time we only care
 * about candidate snippets so the error carries actionable alternatives.
 */
export function buildExecutionZeroMatchHint(
    simplified: string,
    oldString: string,
    options: ZeroMatchHintOptions = {},
): ExecutionZeroMatchHint {
    const notFound = notFoundSentence(options.rejectedFallback);
    const candidates = findCandidateSnippets(simplified, oldString);
    if (candidates.length > 0) {
        const header =
            `${notFound} `
            + 'Closest matches in the note:';
        return {
            message: `${header}\n${renderCandidateLines(candidates)}`,
            candidates,
        };
    }
    // Fall back to multi-line window scoring so a long or mis-formatted
    // old_string still yields a region pointer instead of a bare "not found".
    const windowCandidates = findWindowCandidates(simplified, oldString);
    if (windowCandidates.length > 0) {
        const header =
            `${notFound} These note `
            + 'snippets are near the region your old_string seems to target, '
            + 'but are NOT exact matches:';
        const footer =
            '\nCall read_note around them to see the exact current HTML, '
            + 'then copy a precise span as old_string.';
        return {
            message: `${header}\n${renderCandidateLines(windowCandidates)}${footer}`,
            candidates: windowCandidates,
        };
    }
    return {
        message: notFound,
        candidates: [],
    };
}

// =============================================================================
// Undo-side fuzzy-recovery strategies
// =============================================================================

/**
 * Comparator that normalizes ProseMirror-induced whitespace drift between two
 * HTML fragments. Strips data-citation-items, simplifies, then collapses
 * whitespace and inter-tag whitespace so e.g. `</p>\n</div>` and `</p></div>`
 * compare equal.
 */
export function normalizeUndoComparisonHtml(html: string, libraryId: number): string {
    const { simplified } = simplifyNoteHtml(stripDataCitationItems(html), libraryId);
    return simplified.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
}

/**
 * Locate ranges in `currentHtml` whose prefix and suffix match those of
 * `targetHtml`. Tries progressively shorter anchors (160→…→12 chars). Returns
 * candidates sorted by (length asc, start asc). Caller is expected to verify
 * each candidate (e.g. via `normalizeUndoComparisonHtml`) before applying.
 */
export function findRangesByRawAnchors(
    currentHtml: string,
    targetHtml: string,
): Array<{ start: number; end: number }> {
    const anchorLengths = [160, 120, 80, 40, 24, 16, 12];
    const candidates: Array<{ start: number; end: number }> = [];
    const seen = new Set<string>();
    const MAX_PREFIX_MATCHES = 12;
    const MAX_SUFFIX_MATCHES_PER_PREFIX = 8;

    for (const prefixLen of anchorLengths) {
        const resolvedPrefixLen = Math.min(prefixLen, targetHtml.length);
        if (resolvedPrefixLen < 12) continue;

        const prefix = targetHtml.slice(0, resolvedPrefixLen);
        let prefixSearchFrom = 0;
        let prefixMatches = 0;

        while (prefixMatches < MAX_PREFIX_MATCHES) {
            const start = currentHtml.indexOf(prefix, prefixSearchFrom);
            if (start === -1) break;

            prefixMatches += 1;

            for (const suffixLen of anchorLengths) {
                const resolvedSuffixLen = Math.min(suffixLen, targetHtml.length);
                if (resolvedSuffixLen < 12) continue;

                const suffix = targetHtml.slice(-resolvedSuffixLen);
                let suffixSearchFrom = start + resolvedPrefixLen;
                let suffixMatches = 0;

                while (suffixMatches < MAX_SUFFIX_MATCHES_PER_PREFIX) {
                    const suffixIdx = currentHtml.indexOf(suffix, suffixSearchFrom);
                    if (suffixIdx === -1) break;

                    suffixMatches += 1;

                    const key = `${start}:${suffixIdx + resolvedSuffixLen}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        candidates.push({ start, end: suffixIdx + resolvedSuffixLen });
                    }

                    suffixSearchFrom = suffixIdx + 1;
                }
            }

            prefixSearchFrom = start + 1;
        }
    }

    candidates.sort((a, b) => {
        const lengthDiff = (a.end - a.start) - (b.end - b.start);
        if (lengthDiff !== 0) return lengthDiff;
        return a.start - b.start;
    });

    return candidates;
}

/**
 * Search for `needle` in `haystack` with tolerance for whitespace differences
 * introduced by ProseMirror normalization (indentation, newlines between tags).
 *
 *  - Existing whitespace runs in the needle match any whitespace (`\s+`).
 *  - Adjacent tags (`><`) in the needle allow optional whitespace (`\s*`).
 *
 * Returns the matched range in the original haystack, or null if not found.
 */
export function findWhitespaceTolerant(
    haystack: string,
    needle: string,
): { start: number; end: number } | null {
    // Split needle into alternating [nonWS, ws, nonWS, ws, ...] segments
    const segments = needle.split(/(\s+)/);
    const regexParts: string[] = [];
    for (let i = 0; i < segments.length; i++) {
        if (i % 2 === 1) {
            regexParts.push('\\s+');
        } else if (segments[i].length > 0) {
            let escaped = segments[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            escaped = escaped.replace(/></g, '>\\s*<');
            regexParts.push(escaped);
        }
    }
    const pattern = regexParts.join('');
    if (!pattern) return null;
    try {
        const match = haystack.match(new RegExp(pattern));
        if (!match || match.index === undefined) return null;
        return { start: match.index, end: match.index + match[0].length };
    } catch {
        return null;
    }
}

// =============================================================================
// Unified location orchestrator
// =============================================================================

/**
 * Intent tells `locateEditFragment` which strategy chain to apply. Each kind
 * carries only the inputs that strategy needs.
 *
 *   - `validate`        Validator picking a unique target (or capturing
 *                       context anchors when ambiguous).
 *   - `execute`         Executor re-locating the target at apply-time using
 *                       stored validator anchors.
 *   - `undo-fragment`   Undo locating the previously-applied fragment in the
 *                       current note so it can be replaced back. When
 *                       `allowFuzzy` is true the orchestrator falls back to
 *                       context anchors, raw anchors, and whitespace-tolerant
 *                       matching, verifying each candidate via
 *                       `normalizeUndoComparisonHtml`.
 *   - `undo-seam`       Undo locating the seam where deleted content went,
 *                       tolerating editor-inserted whitespace at the seam.
 */
export type LocateIntent =
    | {
          kind: 'validate';
          oldString: string;
          expandedOld: string;
          simplified: string;
          metadata: SimplificationMetadata;
      }
    | {
          kind: 'execute';
          oldString: string;
          expandedOld: string;
          simplified: string;
          metadata: SimplificationMetadata;
          beforeContext?: string;
          afterContext?: string;
      }
    | {
          kind: 'undo-fragment';
          expectedHtml: string;
          beforeContext?: string;
          afterContext?: string;
          libraryId: number;
          allowFuzzy?: boolean;
      }
    | {
          kind: 'undo-seam';
          beforeContext?: string;
          afterContext?: string;
          maxGap?: number;
      };

export type LocateResult =
    | { kind: 'position'; rawPosition: number }
    | { kind: 'context-only'; beforeContext: string; afterContext: string }
    | {
          kind: 'range';
          start: number;
          end: number;
          via: 'exact' | 'context' | 'rawAnchor' | 'whitespaceTolerant';
      }
    | { kind: 'seam'; insertionPoint: number; gapEnd?: number }
    | { kind: 'ambiguous' }
    | { kind: 'not-found' };

/**
 * Single entry point for "find this fragment in the note HTML" across all
 * edit-note paths. Each intent runs its own ordered strategy chain — see the
 * intent type for what each chain does.
 *
 * This is a refactor seam, not new behavior: every strategy here previously
 * lived inline in editNote.ts (validator/executor) or editNoteActions.ts
 * (undo). Going through one orchestrator means a fix for, e.g., whitespace
 * drift lands in every path that needs it.
 */
export function locateEditFragment(args: {
    strippedHtml: string;
    intent: LocateIntent;
}): LocateResult {
    const { strippedHtml, intent } = args;

    if (intent.kind === 'validate') {
        const loc = locateEditTarget({
            strippedHtml,
            simplified: intent.simplified,
            oldString: intent.oldString,
            expandedOld: intent.expandedOld,
            metadata: intent.metadata,
        });
        if (loc.kind === 'position') return { kind: 'position', rawPosition: loc.rawPosition };
        if (loc.kind === 'context') {
            return {
                kind: 'context-only',
                beforeContext: loc.beforeContext,
                afterContext: loc.afterContext,
            };
        }
        return { kind: 'ambiguous' };
    }

    if (intent.kind === 'execute') {
        const { rawPosition } = resolveEditTargetAtRuntime({
            strippedHtml,
            simplified: intent.simplified,
            oldString: intent.oldString,
            expandedOld: intent.expandedOld,
            metadata: intent.metadata,
            targetBeforeContext: intent.beforeContext,
            targetAfterContext: intent.afterContext,
        });
        if (rawPosition === -1) return { kind: 'not-found' };
        return { kind: 'position', rawPosition };
    }

    if (intent.kind === 'undo-seam') {
        return locateUndoSeam(
            strippedHtml,
            intent.beforeContext,
            intent.afterContext,
            intent.maxGap ?? 10,
        );
    }

    // undo-fragment
    return locateUndoFragment(
        strippedHtml,
        intent.expectedHtml,
        intent.beforeContext,
        intent.afterContext,
        intent.libraryId,
        intent.allowFuzzy ?? true,
    );
}

function locateUndoSeam(
    strippedHtml: string,
    beforeCtx: string | undefined,
    afterCtx: string | undefined,
    maxGap: number,
): LocateResult {
    // Strategy 1: exact seam match (ideal case).
    // An empty seam (whole-note deletion: both contexts captured as '')
    // resolves to offset 0 here — `''.indexOf('')` returns 0 — which is the
    // correct insertion point for restoring full-note removals.
    const seam = (beforeCtx || '') + (afterCtx || '');
    const seamIdx = strippedHtml.indexOf(seam);
    if (seamIdx !== -1) {
        return {
            kind: 'seam',
            insertionPoint: seamIdx + (beforeCtx || '').length,
        };
    }

    // Strategy 2: locate beforeCtx end, sanity-check afterCtx is nearby
    if (beforeCtx) {
        const beforeIdx = strippedHtml.indexOf(beforeCtx);
        if (beforeIdx !== -1) {
            const beforeEnd = beforeIdx + beforeCtx.length;
            if (afterCtx) {
                const afterIdx = strippedHtml.indexOf(
                    afterCtx,
                    Math.max(0, beforeEnd - maxGap),
                );
                if (afterIdx !== -1 && Math.abs(afterIdx - beforeEnd) <= maxGap) {
                    // Editor may have inserted whitespace between contexts;
                    // span the gap so the undo replaces it.
                    return { kind: 'seam', insertionPoint: beforeEnd, gapEnd: afterIdx };
                }
                // afterCtx was stored but isn't near beforeCtx anymore. Only
                // fall back to the before-only seam when afterCtx has
                // drifted out of the ENTIRE document (not merely moved
                // elsewhere, which would leave its true seam ambiguous) and
                // beforeCtx pins down exactly one position in the note.
                if (
                    strippedHtml.indexOf(afterCtx) === -1
                    && strippedHtml.indexOf(beforeCtx, beforeIdx + 1) === -1
                ) {
                    return { kind: 'seam', insertionPoint: beforeEnd };
                }
            } else {
                return { kind: 'seam', insertionPoint: beforeEnd };
            }
        }
    }

    // Strategy 3: locate afterCtx start (beforeCtx not found)
    if (afterCtx) {
        const afterIdx = strippedHtml.indexOf(afterCtx);
        if (afterIdx !== -1) {
            return { kind: 'seam', insertionPoint: afterIdx };
        }
    }

    return { kind: 'not-found' };
}

function locateUndoFragment(
    strippedHtml: string,
    expectedHtml: string,
    beforeCtx: string | undefined,
    afterCtx: string | undefined,
    libraryId: number,
    allowFuzzy: boolean,
): LocateResult {
    // Exact path — `expectedHtml` is present verbatim
    const exactIdx = strippedHtml.indexOf(expectedHtml);
    if (exactIdx !== -1) {
        // When `expectedHtml` appears more than once (e.g. after a
        // disambiguated duplicate-citation edit), prefer the occurrence
        // bracketed by the stored anchors.
        const hasDuplicate =
            strippedHtml.indexOf(expectedHtml, exactIdx + expectedHtml.length) !== -1;
        if (hasDuplicate && beforeCtx) {
            const ctxRange = findRangeByContexts(
                strippedHtml,
                beforeCtx,
                afterCtx,
                expectedHtml.length,
            );
            if (ctxRange) {
                return {
                    kind: 'range',
                    start: ctxRange.start,
                    end: ctxRange.start + expectedHtml.length,
                    via: 'exact',
                };
            }
        }
        return {
            kind: 'range',
            start: exactIdx,
            end: exactIdx + expectedHtml.length,
            via: 'exact',
        };
    }

    if (!allowFuzzy) return { kind: 'not-found' };

    // Fuzzy chain: collect candidates from context anchors then raw anchors,
    // verify each via normalize-compare. Context-anchor candidates additionally
    // permit a text-content fallback (PM may restructure HTML while preserving
    // visible text); raw-anchor candidates do not, since they have weaker
    // uniqueness guarantees.
    type Candidate = {
        start: number;
        end: number;
        via: 'context' | 'rawAnchor' | 'whitespaceTolerant';
    };
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    const addCandidate = (c: Candidate) => {
        const key = `${c.start}:${c.end}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(c);
    };

    const ctxRange = findRangeByContexts(
        strippedHtml,
        beforeCtx,
        afterCtx,
        expectedHtml.length,
    );
    if (ctxRange) addCandidate({ ...ctxRange, via: 'context' });

    for (const r of findRangesByRawAnchors(strippedHtml, expectedHtml)) {
        addCandidate({ ...r, via: 'rawAnchor' });
    }

    const wsRange = findWhitespaceTolerant(strippedHtml, expectedHtml);
    if (wsRange) addCandidate({ ...wsRange, via: 'whitespaceTolerant' });

    const normalizedExpected = normalizeUndoComparisonHtml(expectedHtml, libraryId);
    for (const c of candidates) {
        const candidateHtml = strippedHtml.substring(c.start, c.end);
        const normalizedCandidate = normalizeUndoComparisonHtml(candidateHtml, libraryId);
        if (normalizedCandidate === normalizedExpected) {
            return { kind: 'range', start: c.start, end: c.end, via: c.via };
        }
        // Text-content fallback only allowed for context-anchor candidates.
        if (c.via !== 'context') continue;
        const candidateText = candidateHtml.replace(/<[^>]+>/g, '').trim();
        const expectedText = expectedHtml.replace(/<[^>]+>/g, '').trim();
        if (candidateText && candidateText === expectedText) {
            return { kind: 'range', start: c.start, end: c.end, via: c.via };
        }
    }

    return { kind: 'not-found' };
}

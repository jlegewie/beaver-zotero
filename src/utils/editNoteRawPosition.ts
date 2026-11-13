/**
 * Raw-HTML position helpers used by `editNotePositionLookup`.
 *
 *   - `findUniqueRawMatchPosition`       map a unique simplified match to raw
 *   - `findTargetRawMatchPosition`       find raw position by before/after ctx
 *   - `captureValidatedEditTargetContext` capture unique anchors at validate time
 *
 * Split from the orchestrator so tests can stub individual helpers through
 * `vi.mock` without intercepting the position-lookup module itself.
 */

import type { SimplificationMetadata } from './noteHtmlSimplifier';
import { stripNoteWrapperDiv } from './noteWrapper';
import { expandToRawHtml } from './noteCitationExpand';

// =============================================================================
// Context-Anchored Range Finding
// =============================================================================

export type ContextRangePolicy = 'first' | 'best-length';

/**
 * Find the range in currentHtml bracketed by before/after context strings.
 * Used for context-anchored undo and PM normalization refresh.
 *
 * Policy resolution (when omitted): `best-length` if `expectedLength` is
 * provided, otherwise `first`.
 *
 *   - `first`        Return the first valid (beforeCtx, afterCtx) pair.
 *   - `best-length`  Walk all valid pairs; return the one whose length is
 *                    closest to `expectedLength`. Disambiguates cases where
 *                    `beforeCtx` matches non-uniquely (e.g., a shared
 *                    citation-span suffix repeated across sibling `<li>`s).
 */
export function findRangeByContexts(
    currentHtml: string,
    beforeCtx?: string,
    afterCtx?: string,
    expectedLength?: number,
    policy?: ContextRangePolicy,
): { start: number; end: number } | null {
    const hasBefore = beforeCtx != null && beforeCtx.length > 0;
    const hasAfter = afterCtx != null && afterCtx.length > 0;
    const effectivePolicy: ContextRangePolicy =
        policy ?? (expectedLength !== undefined ? 'best-length' : 'first');

    if (hasBefore && hasAfter) {
        let bestStart = -1;
        let bestEnd = -1;
        let bestScore = Number.POSITIVE_INFINITY;

        let searchFrom = 0;
        while (true) {
            const beforeIdx = currentHtml.indexOf(beforeCtx!, searchFrom);
            if (beforeIdx === -1) break;
            const start = beforeIdx + beforeCtx!.length;
            const afterIdx = currentHtml.indexOf(afterCtx!, start);
            if (afterIdx !== -1 && afterIdx >= start) {
                if (effectivePolicy === 'first') {
                    return { start, end: afterIdx };
                }
                // best-length
                const score = Math.abs((afterIdx - start) - (expectedLength ?? 0));
                if (score < bestScore) {
                    bestScore = score;
                    bestStart = start;
                    bestEnd = afterIdx;
                }
            }
            searchFrom = beforeIdx + 1;
        }

        if (bestStart !== -1) return { start: bestStart, end: bestEnd };
    } else if (hasBefore && !hasAfter) {
        // Edit at end of note — beforeCtx anchors the start, end is end-of-string.
        const beforeIdx = currentHtml.indexOf(beforeCtx!);
        if (beforeIdx !== -1) {
            return { start: beforeIdx + beforeCtx!.length, end: currentHtml.length };
        }
    } else if (!hasBefore && hasAfter) {
        // Edit at start of note — afterCtx anchors the end, start is 0.
        const afterIdx = currentHtml.indexOf(afterCtx!);
        if (afterIdx !== -1) {
            return { start: 0, end: afterIdx };
        }
    }
    return null;
}

// =============================================================================
// Helpers
// =============================================================================

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Spans of `needle` in `haystack`, treating every `ref="…"` value in the
 * needle as a wildcard. Citation refs are occurrence counters that shift when
 * an edit adds or removes a citation, so this also finds the spans a needle
 * with stale refs was meant to address.
 */
export function findRefInsensitiveMatches(haystack: string, needle: string): { start: number; end: number }[] {
    const refAttrRegex = /\bref="[^"]*"/g;
    let pattern = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = refAttrRegex.exec(needle)) !== null) {
        pattern += escapeRegex(needle.substring(lastIndex, match.index));
        pattern += 'ref="[^"]*"';
        lastIndex = match.index + match[0].length;
    }
    pattern += escapeRegex(needle.substring(lastIndex));

    const regex = new RegExp(pattern, 'g');
    const spans: { start: number; end: number }[] = [];
    while ((match = regex.exec(haystack)) !== null) {
        spans.push({ start: match.index, end: match.index + match[0].length });
    }
    return spans;
}

/**
 * Map an old_string that occurs exactly once in the simplified note to its raw
 * HTML position, or `null` when it is missing, repeated, or cannot be verified
 * against the raw HTML. Unlike `findUniqueRawMatchPosition`, citation refs
 * count: they tell apart citations whose raw HTML is identical.
 */
function findExactSimplifiedRawMatchPosition(
    strippedHtml: string,
    simplified: string,
    oldString: string,
    expandedOld: string,
    metadata: SimplificationMetadata
): number | null {
    const simplifiedMatchPos = simplified.indexOf(oldString);
    if (simplifiedMatchPos === -1) return null;

    if (simplified.indexOf(oldString, simplifiedMatchPos + oldString.length) !== -1) {
        return null;
    }

    try {
        const expandedBefore = expandToRawHtml(
            simplified.substring(0, simplifiedMatchPos), metadata, 'old'
        );
        // Simplified HTML strips the root wrapper div, so map the content-level
        // offset back into the raw note HTML before verifying the match.
        const unwrapped = stripNoteWrapperDiv(strippedHtml);
        const wrapperPrefixLen = unwrapped !== strippedHtml
            ? strippedHtml.indexOf('>') + 1 : 0;
        const candidate = wrapperPrefixLen + expandedBefore.length;
        return strippedHtml.substring(candidate, candidate + expandedOld.length) === expandedOld
            ? candidate
            : null;
    } catch {
        return null;
    }
}

export interface EditTargetContext {
    beforeContext: string;
    afterContext: string;
}

const EDIT_TARGET_CONTEXT_LENGTH = 200;
/** Longest anchor captured on either side of a validated edit target. */
const MAX_EDIT_TARGET_CONTEXT_LENGTH = 4000;

/**
 * Capture the anchors the executor uses to re-locate a validated target whose
 * raw HTML occurs more than once. The citation ref in old_string pins the
 * occurrence now, but refs renumber when the note changes before execution,
 * so the executor relies on the anchors alone. They start at 200 chars and
 * double until they bracket only this occurrence: two table rows that differ
 * in a citation ref can share a long run of identical cells on both sides.
 * Returns `null` when the occurrence cannot be pinned down within the cap.
 */
export function captureValidatedEditTargetContext(
    strippedHtml: string,
    simplified: string,
    oldString: string,
    expandedOld: string,
    metadata: SimplificationMetadata
): EditTargetContext | null {
    const rawPos = findExactSimplifiedRawMatchPosition(
        strippedHtml, simplified, oldString, expandedOld, metadata
    );
    if (rawPos === null) return null;

    const afterStart = rawPos + expandedOld.length;
    for (let length = EDIT_TARGET_CONTEXT_LENGTH; ; length = Math.min(length * 2, MAX_EDIT_TARGET_CONTEXT_LENGTH)) {
        const context = {
            beforeContext: strippedHtml.substring(Math.max(0, rawPos - length), rawPos),
            afterContext: strippedHtml.substring(afterStart, afterStart + length),
        };
        const reachesBothEnds = rawPos - length <= 0 && afterStart + length >= strippedHtml.length;
        if (
            findUniqueRawPositionByContext(strippedHtml, expandedOld, context.beforeContext, context.afterContext) === rawPos
        ) {
            return context;
        }
        if (reachesBothEnds || length >= MAX_EDIT_TARGET_CONTEXT_LENGTH) return null;
    }
}

/**
 * Locate `expandedOld` by the anchors captured around it. An occurrence that
 * both anchors bracket wins; single-anchor hits only count when no occurrence
 * matches both, which tolerates drift on one side. One anchor alone is often
 * shared: the 200 chars after the first cell of two table rows can be the
 * same run of identical cells.
 */
function findUniqueRawPositionByContext(
    currentHtml: string,
    expandedOld: string,
    beforeCtx?: string,
    afterCtx?: string
): number | null {
    const beforeStarts = new Set<number>();
    const afterStarts = new Set<number>();

    if (beforeCtx) {
        let searchFrom = 0;
        while (true) {
            const beforeIdx = currentHtml.indexOf(beforeCtx, searchFrom);
            if (beforeIdx === -1) break;
            const start = beforeIdx + beforeCtx.length;
            if (currentHtml.startsWith(expandedOld, start)) beforeStarts.add(start);
            searchFrom = beforeIdx + 1;
        }
    }

    if (afterCtx) {
        let searchFrom = 0;
        while (true) {
            const afterIdx = currentHtml.indexOf(afterCtx, searchFrom);
            if (afterIdx === -1) break;
            const start = afterIdx - expandedOld.length;
            if (start >= 0 && currentHtml.startsWith(expandedOld, start)) afterStarts.add(start);
            searchFrom = afterIdx + 1;
        }
    }

    const bracketed = [...beforeStarts].filter((start) => afterStarts.has(start));
    if (bracketed.length > 0) return bracketed.length === 1 ? bracketed[0] : null;

    const anchored = new Set([...beforeStarts, ...afterStarts]);
    return anchored.size === 1 ? [...anchored][0] : null;
}

export function findTargetRawMatchPosition(
    currentHtml: string,
    expandedOld: string,
    beforeCtx?: string,
    afterCtx?: string,
): number | null {
    return findUniqueRawPositionByContext(currentHtml, expandedOld, beforeCtx, afterCtx);
}

/**
 * Map a unique simplified old_string match back to its raw HTML position.
 *
 * This is used when the raw HTML fragment is duplicated due to equivalent
 * citations. This helper is intentionally conservative: citation refs are only
 * occurrence counters from the current document order, so ref values alone are
 * not treated as a stable identity signal. Returns null if the match is
 * missing, ambiguous after ref-masking, or cannot be verified against the raw
 * HTML.
 */
export function findUniqueRawMatchPosition(
    strippedHtml: string,
    simplified: string,
    oldString: string,
    expandedOld: string,
    metadata: SimplificationMetadata
): number | null {
    const matchPositions = findRefInsensitiveMatches(simplified, oldString).map((m) => m.start);
    if (matchPositions.length !== 1) {
        return null;
    }
    const simplifiedMatchPos = matchPositions[0];

    try {
        const expandedBefore = expandToRawHtml(
            simplified.substring(0, simplifiedMatchPos), metadata, 'old'
        );
        // Simplified HTML strips the root wrapper div, so map the content-level
        // offset back into the raw note HTML before verifying the match.
        const unwrapped = stripNoteWrapperDiv(strippedHtml);
        const wrapperPrefixLen = unwrapped !== strippedHtml
            ? strippedHtml.indexOf('>') + 1 : 0;
        const candidate = wrapperPrefixLen + expandedBefore.length;
        return strippedHtml.substring(candidate, candidate + expandedOld.length) === expandedOld
            ? candidate
            : null;
    } catch {
        return null;
    }
}

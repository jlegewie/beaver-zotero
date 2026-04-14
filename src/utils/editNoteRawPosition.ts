/**
 * Raw-HTML position helpers used by `editNotePositionLookup`.
 *
 *   - `findUniqueRawMatchPosition`       map a unique simplified match to raw
 *   - `findTargetRawMatchPosition`       find raw position by before/after ctx
 *   - `captureValidatedEditTargetContext` capture 200-char anchors at validate time
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

export type ContextRangePolicy = 'first' | 'unique' | 'best-length';

/**
 * Find the range in currentHtml bracketed by before/after context strings.
 * Used for context-anchored undo, PM normalization refresh, and validator
 * disambiguation of multi-match edits.
 *
 * Policy resolution (when omitted): `best-length` if `expectedLength` is
 * provided, otherwise `first`.
 *
 *   - `first`        Return the first valid (beforeCtx, afterCtx) pair.
 *   - `best-length`  Walk all valid pairs; return the one whose length is
 *                    closest to `expectedLength`. Disambiguates cases where
 *                    `beforeCtx` matches non-uniquely (e.g., a shared
 *                    citation-span suffix repeated across sibling `<li>`s).
 *   - `unique`       Walk all valid pairs; return null if more than one
 *                    distinct range is found. Used when the validator needs
 *                    to confirm a single matching position.
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
        let firstFound: { start: number; end: number } | null = null;
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
                if (effectivePolicy === 'unique') {
                    if (firstFound) {
                        if (firstFound.start !== start || firstFound.end !== afterIdx) {
                            return null;
                        }
                    } else {
                        firstFound = { start, end: afterIdx };
                    }
                } else {
                    // best-length
                    const score = Math.abs((afterIdx - start) - (expectedLength ?? 0));
                    if (score < bestScore) {
                        bestScore = score;
                        bestStart = start;
                        bestEnd = afterIdx;
                    }
                }
            }
            searchFrom = beforeIdx + 1;
        }

        if (effectivePolicy === 'unique') return firstFound;
        if (bestStart !== -1) return { start: bestStart, end: bestEnd };
    } else if (hasBefore && !hasAfter) {
        // Edit at end of note — beforeCtx anchors the start, end is end-of-string.
        // 'unique' policy requires beforeCtx to occur exactly once; otherwise
        // the end-of-note range is ambiguous.
        if (effectivePolicy === 'unique') {
            const first = currentHtml.indexOf(beforeCtx!);
            if (first === -1) return null;
            if (currentHtml.indexOf(beforeCtx!, first + 1) !== -1) return null;
            return { start: first + beforeCtx!.length, end: currentHtml.length };
        }
        const beforeIdx = currentHtml.indexOf(beforeCtx!);
        if (beforeIdx !== -1) {
            return { start: beforeIdx + beforeCtx!.length, end: currentHtml.length };
        }
    } else if (!hasBefore && hasAfter) {
        // Edit at start of note — afterCtx anchors the end, start is 0.
        if (effectivePolicy === 'unique') {
            const first = currentHtml.indexOf(afterCtx!);
            if (first === -1) return null;
            if (currentHtml.indexOf(afterCtx!, first + 1) !== -1) return null;
            return { start: 0, end: first };
        }
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

function findRefInsensitiveMatchPositions(haystack: string, needle: string): number[] {
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
    const positions: number[] = [];
    while ((match = regex.exec(haystack)) !== null) {
        positions.push(match.index);
    }
    return positions;
}

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

    return {
        beforeContext: strippedHtml.substring(
            Math.max(0, rawPos - EDIT_TARGET_CONTEXT_LENGTH),
            rawPos
        ),
        afterContext: strippedHtml.substring(
            rawPos + expandedOld.length,
            rawPos + expandedOld.length + EDIT_TARGET_CONTEXT_LENGTH
        ),
    };
}

function findUniqueRawPositionByContext(
    currentHtml: string,
    expandedOld: string,
    beforeCtx?: string,
    afterCtx?: string
): number | null {
    const positions = new Set<number>();
    const hasBefore = beforeCtx != null && beforeCtx.length > 0;
    const hasAfter = afterCtx != null && afterCtx.length > 0;

    if (hasBefore && hasAfter) {
        const range = findRangeByContexts(currentHtml, beforeCtx, afterCtx, undefined, 'unique');
        if (range && currentHtml.substring(range.start, range.end) === expandedOld) {
            positions.add(range.start);
        }
    }

    if (hasBefore) {
        let searchFrom = 0;
        while (true) {
            const beforeIdx = currentHtml.indexOf(beforeCtx!, searchFrom);
            if (beforeIdx === -1) break;
            const start = beforeIdx + beforeCtx!.length;
            if (currentHtml.substring(start, start + expandedOld.length) === expandedOld) {
                positions.add(start);
            }
            searchFrom = beforeIdx + 1;
        }
    }

    if (hasAfter) {
        let searchFrom = 0;
        while (true) {
            const afterIdx = currentHtml.indexOf(afterCtx!, searchFrom);
            if (afterIdx === -1) break;
            const start = afterIdx - expandedOld.length;
            if (start >= 0 && currentHtml.substring(start, afterIdx) === expandedOld) {
                positions.add(start);
            }
            searchFrom = afterIdx + 1;
        }
    }

    return positions.size === 1 ? Array.from(positions)[0] : null;
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
    const matchPositions = findRefInsensitiveMatchPositions(simplified, oldString);
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

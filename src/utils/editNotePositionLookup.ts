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
    findFuzzyMatch,
    findInlineTagDriftMatch,
    findStructuralAnchorHint,
} from './editNoteHints';
import {
    captureValidatedEditTargetContext,
    findRangeByContexts,
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
    | { kind: 'drift'; droppedTags: string[]; noteSpan: string; message: string }
    | { kind: 'fuzzy'; fuzzyMatch: string; message: string }
    | { kind: 'structural'; tagName: string; context: string; message: string }
    | { kind: 'generic'; message: string };

/**
 * Build the most specific error hint available when `old_string` isn't found.
 * Priority: inline-tag drift → fuzzy word match → structural anchor → generic.
 * The structured return lets callers compose their own error envelope.
 */
export function buildZeroMatchHint(
    simplified: string,
    oldString: string
): ZeroMatchHint {
    const drift = findInlineTagDriftMatch(simplified, oldString);
    if (drift) {
        const droppedList = drift.droppedTags.join(' ');
        const message =
            'The string to replace was not found in the note. '
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
        return { kind: 'drift', droppedTags: drift.droppedTags, noteSpan: drift.noteSpan, message };
    }

    const fuzzy = findFuzzyMatch(simplified, oldString);
    if (fuzzy) {
        const message =
            'The string to replace was not found in the note.'
            + ` Found a possible fuzzy match:\n\`\`\`\n${fuzzy}\n\`\`\``;
        return { kind: 'fuzzy', fuzzyMatch: fuzzy, message };
    }

    const structural = findStructuralAnchorHint(simplified, oldString);
    if (structural) {
        const message =
            'The string to replace was not found in the note.'
            + ` Your old_string references \`<${structural.tagName}>\`,`
            + ' but its actual context in the note is:\n'
            + `\`\`\`\n${structural.context}\n\`\`\`\n`
            + 'Rewrite old_string to match the surrounding content shown above.';
        return { kind: 'structural', tagName: structural.tagName, context: structural.context, message };
    }

    return {
        kind: 'generic',
        message: 'The string to replace was not found in the note.',
    };
}

/**
 * Executor variant: only the fuzzy leg is used in the executor today (drift
 * and structural hints are validator-only). Kept as a separate entry point so
 * the executor's shorter error message stays faithful to the original.
 */
export function buildExecutionZeroMatchMessage(
    simplified: string,
    oldString: string
): string {
    const fuzzy = findFuzzyMatch(simplified, oldString);
    return (
        'The string to replace was not found in the note.'
        + (fuzzy ? ` Found a possible fuzzy match:\n\`\`\`\n${fuzzy}\n\`\`\`` : '')
    );
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

/**
 * Position lookup and zero-match hint orchestration for edit_note actions.
 *
 * The validator and both executors (esbuild-side and react-side) share two
 * identical fallback chains:
 *
 *   Pattern B — position lookup:
 *     findUniqueRawMatchPosition → captureValidatedEditTargetContext (validate)
 *     findUniqueRawMatchPosition → findTargetRawMatchPosition         (execute)
 *
 *   Pattern A — zero-match error hint:
 *     findInlineTagDriftMatch → findFuzzyMatch → findStructuralAnchorHint
 *
 * This module composes the primitives from `noteHtmlSimplifier.ts` so each
 * call site becomes a single function call instead of a ~10-line block.
 * No new logic lives here — just orchestration.
 */

import {
    type SimplificationMetadata,
    captureValidatedEditTargetContext,
    findFuzzyMatch,
    findInlineTagDriftMatch,
    findStructuralAnchorHint,
    findTargetRawMatchPosition,
    findUniqueRawMatchPosition,
} from './noteHtmlSimplifier';

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
